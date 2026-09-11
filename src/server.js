#!/usr/bin/env node
/**
 * Agent Browser Bridge —— 本机桥接服务。
 *
 * 作用：在"浏览器扩展"和"任意本机 agent"之间转发操作请求。
 * 任何本机程序只要会发 HTTP 就能用，不限定具体的 agent 实现。
 *
 * 依赖：仅 Node 原生模块，无需 npm install。
 *
 * 启动：
 *   node server.js            默认端口 18777
 *   node server.js --port 18778
 *
 * HTTP 接口（全部只监听 127.0.0.1）。每个动作的完整入参与返回见 README.md，
 * 这里只列清单，方便定位：
 *
 *   GET  /health  /capabilities   状态、apiVersion、能力清单、在线浏览器
 *   GET  /tabs                    标签页清单（含 discarded / status / favIconUrl）
 *   POST /read   /links   /media          读取类
 *   POST /click  /type    /key   /navigate /eval   交互类
 *   POST /save   /grab    /download   /upload      文件类
 *   POST /session                         站点 Cookie 与存储（需 cookies 可选权限）
 *   POST /screenshot                      截图（走 debugger）
 *   POST /wait   /frames  /diag           同步与诊断
 *   POST /mark   /unmark  /activate /close /reload  标签页与扩展管理
 *   GET  /poll   /result                  扩展专用（长轮询与回传）
 *
 * 路由说明：
 *   请求可带 browser 指定 edge / chrome；未指定时按 edge → chrome 顺序逐个尝试，
 *   命中真正包含目标标签页的那个浏览器。任务只投递给目标浏览器自己的队列。
 *
 * 安全说明：
 *   - 只绑定 127.0.0.1，不对局域网或外网开放。
 *   - 校验 Origin，拒绝来自普通网页的请求，避免恶意页面通过 CSRF 驱动扩展。
 *   - 服务端本身不做任何页面操作，只做转发；是否可操作由浏览器扩展的站点授权决定。
 */

'use strict';

const http = require('node:http');
const { URL } = require('node:url');

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = parseInt(argValue('--port', '18777'), 10);
const HOST = '127.0.0.1';

/**
 * 允许驱动桥接的扩展 ID。
 *
 * 扩展 ID 由清单里的 key（公钥）推导，因此从源码加载的每一份安装 ID 都相同。
 * 不固定 ID 的话，用户装的**任何**其他扩展都能调这个桥接：它们会借用桥接自己的
 * cookies 与 debugger 权限，等于绕过浏览器的权限提示拿到这些能力。
 *
 * 另有自己签名的构建、或从商店安装的版本（ID 由商店分配）时，用
 * --allow-extension <id> 追加。扩展 ID 可在扩展弹窗或 `node src/cli.js diag` 里看到。
 */
const DEFAULT_EXTENSION_ID = 'nbopjoejgialcnmjcefaciebicahjhpp';

/** 实际生效的扩展 ID 允许列表：默认 ID + 命令行追加。 */
const allowedExtensionIds = new Set([DEFAULT_EXTENSION_ID.toLowerCase()]);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--allow-extension' && argv[i + 1]) {
    allowedExtensionIds.add(String(argv[i + 1]).trim().toLowerCase());
  }
}
const POLL_HOLD_MS = 25000;      // 扩展长轮询的挂起时长
const READ_TIMEOUT_MS = 30000;   // 单次操作的默认等待上限
const MAX_QUEUE = 100;           // 单浏览器队列上限，防止无扩展连接时无限堆积
/**
 * /result 的请求体上限。不能沿用普通请求的 1MB：
 * download 会把整个文件转成 base64 回传（上限 20MB），screenshot 回传
 * dataUrl，session 会把 localStorage 整个倒出来，都会超过 1MB。
 * 超限时 readBody 会 destroy 连接，扩展侧只看到 ECONNRESET，调用方只能干等到超时。
 */
const RESULT_MAX_BODY = 32 * 1024 * 1024;

/**
 * 对外接口版本。新增能力时递增次版本，破坏性变更时递增主版本。
 * 其他 agent 可先读 /health 的 apiVersion 与 capabilities 再决定调用方式。
 */
const API_VERSION = '1.0';

/** 本服务提供的能力清单，供调用方做特性探测。 */
const CAPABILITIES = [
  'tabs',         // 列出标签页
  'read',         // 读取正文
  'eval',         // 在页面里执行 JS 并取回结果（量 DOM、取计算样式）
  'session',      // 读取标签页登录态（cookies + localStorage/sessionStorage）
  'upload',       // 把本地文件塞进页面 file input（CDP）
  'download',     // 用页面登录态下载文件
  'screenshot',   // 截取当前可见标签页画面
  'links',        // 枚举链接
  'click',        // 点击元素
  'type',         // 输入文本
  'key',          // 派发按键
  'navigate',     // 导航
  'mark',         // 标记标签页
  'unmark',       // 清除标记
  'close',        // 关闭标签页（需显式 tabId）
  'frames',       // 框架诊断
  'wait',         // 等待条件成立
  'diag',         // 扩展运行诊断
  'activate',     // 激活标签页（唤醒冻结标签页）
  'save',         // 保存文件到磁盘（浏览器下载栈）
  'media',        // 枚举页面媒体候选
  'grab',         // 抓取受防盗链/CORS 保护的媒体
  'reload',       // 重新加载扩展自身（开发用）
  'multiBrowser'  // 多浏览器隔离与路由
];

/* ------------------------------------------------------------------ *
 * 状态
 *
 * 同一台机器可能同时装着 Chrome 和 Edge 两个扩展实例，因此按浏览器名分别
 * 保存长轮询连接，任务可按 browser 定向下发，避免两个浏览器互相顶替连接。
 * ------------------------------------------------------------------ */
const heldPolls = new Map();     // 浏览器名 -> 挂起的长轮询响应
const lastSeen = new Map();      // 浏览器名 -> 最近心跳时间
const queues = new Map();        // 浏览器名 -> 该浏览器专属的待下发任务数组
const pending = new Map();       // 任务 id -> { resolve, timer, browser }
let nextTaskId = 1;

/** 取某个浏览器的专属队列，队列按浏览器隔离，互不串扰。 */
function queueFor(browser) {
  let q = queues.get(browser);
  if (!q) { q = []; queues.set(browser, q); }
  return q;
}

/** 统计待下发任务总数。 */
function queuedCount() {
  let n = 0;
  for (const q of queues.values()) { n += q.length; }
  return n;
}

const HEARTBEAT_MS = 30000;      // 超出此时间未心跳视为离线

/** 规范化浏览器名，用作路由键。 */
function normalizeBrowser(name) {
  const v = String(name || 'unknown').trim().toLowerCase();
  if (v.includes('edg')) { return 'edge'; }
  if (v.includes('chrome')) { return 'chrome'; }
  if (v.includes('firefox')) { return 'firefox'; }
  return v || 'unknown';
}

/** 当前在线的浏览器名列表。 */
function connectedBrowsers() {
  const names = new Set();
  for (const name of heldPolls.keys()) { names.add(name); }
  const now = Date.now();
  for (const [name, ts] of lastSeen.entries()) {
    if (now - ts < HEARTBEAT_MS) { names.add(name); }
  }
  return Array.from(names);
}

function extensionConnected() {
  return connectedBrowsers().length > 0;
}

/**
 * 未指定浏览器时的尝试顺序：Edge 优先（配合 Confluence 必用 Edge 的约定），
 * 其余按名称排序，保证多浏览器环境下顺序稳定、结果可预期。
 */
function orderBrowsers(online) {
  const rest = online.filter((b) => b !== 'edge').sort();
  return online.includes('edge') ? ['edge', ...rest] : rest;
}

/* ------------------------------------------------------------------ *
 * HTTP 工具
 * ------------------------------------------------------------------ */
/**
 * 判断来源是否为「允许列表里的扩展」。
 * 只认 ID，不认 chrome-extension:// 这个前缀——前缀对用户装的每个扩展都成立。
 */
function isExtensionOrigin(origin) {
  if (typeof origin !== 'string') { return false; }
  const m = /^(?:chrome|moz)-extension:\/\/([^/]+)/i.exec(origin);
  if (!m) { return false; }
  return allowedExtensionIds.has(m[1].toLowerCase());
}

/** 被拒绝的来源只提示一次，避免刷屏。 */
const reportedRejectedOrigins = new Set();
function reportRejectedOrigin(origin) {
  const key = String(origin || '(无 Origin)');
  if (reportedRejectedOrigins.has(key)) { return; }
  reportedRejectedOrigins.add(key);
  const ext = /^(?:chrome|moz)-extension:\/\/([^/]+)/i.exec(key);
  console.warn(ext
    ? `[bridge] 拒绝扩展 ${ext[1]}。若是你自己加载的扩展，用 --allow-extension ${ext[1]} 加入允许列表。`
    : `[bridge] 拒绝来源 ${key}（只接受本机来源与允许列表内的扩展）。`);
}

function sendJson(res, status, payload, req) {
  const body = JSON.stringify(payload ?? {});
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  };

  // 对扩展来源显式回 CORS 头。清单里已授权本机桥接地址，这里是额外保险，
  // 让不同 Chromium 版本下都能正常通信。
  const origin = req && req.headers && req.headers.origin;
  if (isExtensionOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/**
 * 校验请求来源。
 * 允许：无 Origin（本机脚本）、扩展页面、本机 http 来源。
 * 拒绝：任何来自普通网站的请求，防止网页发起 CSRF 驱动扩展读取数据。
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) { return true; }
  if (isExtensionOrigin(origin)) { return true; }
  try {
    const u = new URL(origin);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') { return true; }
  } catch (e) { /* 非法 Origin，落到拒绝分支 */ }
  return false;
}

/* ------------------------------------------------------------------ *
 * 任务分发
 * ------------------------------------------------------------------ */

/**
 * 把各浏览器专属队列里的任务下发给对应的浏览器。
 * 每个任务只可能投递给它自己队列所属的那个浏览器，因此不存在跨浏览器误投。
 */
function flushTasks(browser) {
  const targets = browser ? [browser] : Array.from(queues.keys());

  for (const name of targets) {
    const q = queues.get(name);
    if (!q || q.length === 0) { continue; }

    const res = heldPolls.get(name);
    if (!res) { continue; }                              // 该浏览器未持有长轮询，等它下次轮询

    // 一次轮询只下发一个任务，保证结果与任务一一对应
    const task = q.shift();
    heldPolls.delete(name);
    clearTimeout(res.__holdTimer);
    sendJson(res, 200, task, res.__req);
  }
}

/** 归一化超时参数，限制在 1 秒到 2 分钟之间。 */
function clampTimeout(value, fallback = READ_TIMEOUT_MS) {
  return Math.min(Math.max(parseInt(value, 10) || fallback, 1000), 120000);
}

/** 单浏览器派发：任务只投递给指定浏览器，并等待它返回结果。 */
function dispatchTo(browser, task, timeoutMs) {
  return new Promise((resolve) => {
    const q = queueFor(browser);
    if (q.length >= MAX_QUEUE) {
      resolve({ ok: false, error: 'queue_full', browser });
      return;
    }

    task.id = nextTaskId++;
    // 扩展收到任务后会校验 browser 是否与自己一致，不一致直接拒收，
    // 从机制上保证任务不会落到错误的浏览器上
    task.browser = browser;

    const timer = setTimeout(() => {
      pending.delete(task.id);
      // 任务已过期，必须连同队列里还没下发的那一份一起丢掉。
      // 否则扩展稍后重连轮询时会把它当成新任务执行：调用方早已收到 timeout
      // 并放弃，点击、输入、关闭标签页却在之后某个时刻突然落地。
      const queued = q.indexOf(task);
      if (queued >= 0) { q.splice(queued, 1); }
      resolve({ ok: false, error: 'timeout', browser, hint: '扩展在超时前没有返回结果' });
    }, timeoutMs);

    pending.set(task.id, { resolve, timer, browser });
    q.push(task);
    flushTasks(browser);
  });
}

/**
 * 智能派发。
 * - 显式指定 browser：只投给该浏览器。
 * - 未指定且仅一个在线：直接投给它。
 * - 未指定且有多个在线：按 Edge 优先的顺序依次尝试，遇到 no_tab_matched
 *   就换下一个。这样 Chrome 与 Edge 同时开着时，也能自动命中真正包含
 *   目标标签页的那个浏览器，而不是盲选一个。
 */
async function dispatch(task, timeoutMs) {
  const online = connectedBrowsers();
  if (online.length === 0) {
    return { ok: false, error: 'extension_not_connected' };
  }

  if (task.browser) {
    const want = normalizeBrowser(task.browser);
    if (!online.includes(want)) {
      return { ok: false, error: 'browser_not_connected', browser: want, connected: online };
    }
    return dispatchTo(want, { ...task }, timeoutMs);
  }

  const order = orderBrowsers(online);
  let lastMiss = null;

  // 只有"要在某个浏览器里找某个标签页"的任务才需要短超时试探：目标不在时会立刻回
  // no_tab_matched，不必为它等满整个超时。没有标签页定位信息的任务（例如清空全部标记）
  // 不存在"找错浏览器"这回事，必须用满额超时，否则它做得完、却先被判超时。
  //
  // 15 秒而非 8 秒：扩展内部单次注入的预算就是 12 秒（INJECT_TIMEOUT_MS），
  // 8 秒必然把"慢但正常"的动作误判成超时——实测清空标记耗时 8.1 秒，
  // 调用方收到 timeout，而标记其实已经清掉了。
  const hasTabTarget = typeof task.tabId === 'number' || !!task.match || !!task.url;

  for (let i = 0; i < order.length; i++) {
    const isLast = i === order.length - 1;
    const attemptTimeout = (isLast || !hasTabTarget) ? timeoutMs : Math.min(timeoutMs, 15000);

    const res = await dispatchTo(order[i], { ...task }, attemptTimeout);
    if (res.ok) { return res; }

    // 该浏览器里没有目标标签页，换下一个继续找
    if (res.error === 'no_tab_matched') { lastMiss = res; continue; }
    return res;
  }

  return lastMiss || { ok: false, error: 'no_tab_matched' };
}

/* ------------------------------------------------------------------ *
 * 请求处理
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * 请求处理
 *
 * 一个接口一个函数，路由表在下面。
 *
 * 以前这些接口全挤在一个 handle() 里（800 多行、25 段 `if (req.method === ... && path === ...)`），
 * 想确认"某个接口到底校验了什么"必须逐段往下读，而这些接口的差别恰恰只在几行校验上：
 * 有的要先查扩展在线、有的要 URL、有的要 code。拆开之后，看一个接口只需要看一个函数。
 * ------------------------------------------------------------------ */

/** 读 JSON 请求体。失败时已经回过 400，返回 null，调用方直接 return。 */
async function readJsonBody(req, res, limitBytes) {
  try {
    return await readBody(req, limitBytes);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message }, req);
    return null;
  }
}

/** 目标定位是否缺失：match / url / tabId 三选一。 */
function targetMissing(body) {
  return !body.match && !body.url && typeof body.tabId !== 'number';
}

/** 扩展不在线就回 503 并返回 true（已回过包）。 */
function extensionOffline(res, req) {
  if (extensionConnected()) { return false; }
  sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
  return true;
}

/** 派发任务并按 ok / 502 回包——绝大多数接口的收尾都是这三行。 */
async function replyDispatch(res, req, task, timeoutMs) {
  const result = await dispatch(task, timeoutMs);
  sendJson(res, result.ok ? 200 : 502, result, req);
}

function badRequest(res, req, error, hint) {
  sendJson(res, 400, hint ? { ok: false, error, hint } : { ok: false, error }, req);
}

/* ---- 扩展侧：长轮询与结果回传 ---- */

async function routeHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    service: 'agent-browser-bridge',
    apiVersion: API_VERSION,
    extensionConnected: extensionConnected(),
    browsers: connectedBrowsers(),
    pendingTasks: pending.size,
    queuedTasks: queuedCount(),
    capabilities: CAPABILITIES,
    allowedExtensionIds: Array.from(allowedExtensionIds),
    defaultBrowserOrder: orderBrowsers(connectedBrowsers())
  }, req);
}

async function routePoll(req, res, ctx) {
  // 这里**不能**靠 Origin 判断调用方是不是本扩展：扩展清单里有
  // http://127.0.0.1:18777/* 的 host_permissions，这类请求不受 CORS 约束，
  // 浏览器因此不发 Origin 头。实测扩展发来的 /poll 没有 Origin，
  // 一旦在此要求扩展来源，真扩展会被自己人挡在门外（1.5.0 上踩过）。
  // 代价是：网页用一个 <img src=".../poll?browser=edge"> 仍能冒充在线浏览器，
  // 把下一个任务接到自己的连接上（读不到内容，但任务被吞掉，调用方白等到超时）。
  // 要堵这个只能引入共享密钥，见 SECURITY.md 的"还能冒充吗"一节。
  const browser = normalizeBrowser(ctx.url.searchParams.get('browser'));
  lastSeen.set(browser, Date.now());
  res.__req = req;
  res.__browser = browser;

  // 同一浏览器只保留一个长轮询，新的连接顶替旧的
  const stale = heldPolls.get(browser);
  if (stale) {
    clearTimeout(stale.__holdTimer);
    try { stale.end(); } catch (e) { /* 旧连接已断开 */ }
    heldPolls.delete(browser);
  }

  heldPolls.set(browser, res);
  res.__holdTimer = setTimeout(() => {
    if (heldPolls.get(browser) === res) { heldPolls.delete(browser); }
    res.writeHead(204).end();
  }, POLL_HOLD_MS);

  req.on('close', () => {
    if (heldPolls.get(browser) === res) { heldPolls.delete(browser); }
    clearTimeout(res.__holdTimer);
  });

  flushTasks();
}

async function routeResult(req, res, ctx) {
  const browser = normalizeBrowser(ctx.url.searchParams.get('browser'));
  lastSeen.set(browser, Date.now());

  const body = await readJsonBody(req, res, RESULT_MAX_BODY);
  if (!body) { return; }

  const entry = pending.get(body.id);
  if (entry) {
    // 任务只会投给某一个浏览器，回传方必须与它一致。否则同机另一个浏览器
    // 或本机任意进程只要猜到自增的 id，就能顶替别人去结算任务结果。
    if (entry.browser && entry.browser !== browser) {
      sendJson(res, 409, {
        ok: false,
        error: 'browser_mismatch',
        expected: entry.browser,
        actual: browser
      }, req);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(body.id);
    entry.resolve(body.result ?? { ok: false, error: 'empty_result' });
  }
  sendJson(res, 200, { ok: true, accepted: !!entry }, req);
}

/* ---- 查询类 ---- */

async function routeTabs(req, res, ctx) {
  await replyDispatch(res, req, {
    action: 'tabs',
    browser: ctx.url.searchParams.get('browser') || undefined
  }, READ_TIMEOUT_MS);
}

async function routeFrames(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  await replyDispatch(res, req, {
    action: 'frames',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId
  }, clampTimeout(body.timeoutMs));
}

async function routeMedia(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  await replyDispatch(res, req, {
    action: 'media',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: body.frameId,
    minImageSize: body.minImageSize,
    maxScanChars: body.maxScanChars
  }, clampTimeout(body.timeoutMs, 45000));
}

async function routeRead(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  await replyDispatch(res, req, {
    action: 'read',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    selector: body.selector,
    includeLinks: !!body.includeLinks,
    returnHtml: !!body.returnHtml
  }, clampTimeout(body.timeoutMs));
}

async function routeLinks(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  await replyDispatch(res, req, {
    action: 'links',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    selector: body.selector,
    text: body.text
  }, clampTimeout(body.timeoutMs));
}

async function routeScreenshot(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  await replyDispatch(res, req, {
    action: 'screenshot',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    format: body.format,
    selector: body.selector,
    full: !!body.full
  }, clampTimeout(body.timeoutMs, 30000));
}

async function routeEval(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  if (typeof body.code !== 'string' || !body.code.trim()) {
    badRequest(res, req, 'missing_code',
      '需要提供要执行的 JS 代码，用 return 返回结果，例如 --code "return document.title"');
    return;
  }
  await replyDispatch(res, req, {
    action: 'eval',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    code: body.code
  }, clampTimeout(body.timeoutMs));
}

async function routeSession(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  await replyDispatch(res, req, {
    action: 'session',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    name: body.name,
    key: body.key,
    local: body.local,
    session: body.session,
    storage: body.storage
  }, clampTimeout(body.timeoutMs, 15000));
}

async function routeDownload(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  if (!body.url) {
    badRequest(res, req, 'missing_url', '用 --url 指定要下载的地址');
    return;
  }
  await replyDispatch(res, req, {
    action: 'download',
    browser: body.browser,
    match: body.match,
    tabId: body.tabId,
    url: body.url,
    maxBytes: body.maxBytes,
    headers: body.headers
  }, clampTimeout(body.timeoutMs, 60000));
}

async function routeGrab(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (!body.url) {
    badRequest(res, req, 'missing_url', '需要提供 url');
    return;
  }
  if (!body.match && typeof body.tabId !== 'number') {
    badRequest(res, req, 'missing_target', '需要提供 match 或 tabId，用于指定在哪个标签页内取流');
    return;
  }
  await replyDispatch(res, req, {
    action: 'grab',
    browser: body.browser,
    match: body.match,
    tabId: body.tabId,
    url: body.url,
    filename: body.filename,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    waitMs: typeof body.waitMs === 'number' ? body.waitMs : undefined
  }, clampTimeout(body.timeoutMs, 190000));
}

async function routeSave(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (!body.url) {
    badRequest(res, req, 'missing_url', '需要提供 url');
    return;
  }
  await replyDispatch(res, req, {
    action: 'save',
    browser: body.browser,
    match: body.match,
    tabId: body.tabId,
    url: body.url,
    filename: body.filename,
    saveAs: !!body.saveAs,
    overwrite: !!body.overwrite,
    waitMs: typeof body.waitMs === 'number' ? body.waitMs : undefined
  }, clampTimeout(body.timeoutMs, 60000));
}

async function routeUpload(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  await replyDispatch(res, req, {
    action: 'upload',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    selector: body.selector,
    files: body.files
  }, clampTimeout(body.timeoutMs, 30000));
}

/* ---- 交互类 ---- */

async function routeClick(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  if (!body.selector && !body.text && !body.href) {
    badRequest(res, req, 'missing_click_target', '需要提供 selector、text 或 href 之一来定位要点击的元素');
    return;
  }
  // 点击可能触发页面跳转，给稍长的等待时间
  await replyDispatch(res, req, {
    action: 'click',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    selector: body.selector,
    text: body.text,
    href: body.href,
    index: body.index,
    allowNonLink: !!body.allowNonLink,
    dryRun: !!body.dryRun
  }, clampTimeout(body.timeoutMs, 45000));
}

async function routeType(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  if (typeof body.value !== 'string') {
    badRequest(res, req, 'missing_value', '需要提供 value（要输入的文本）');
    return;
  }
  await replyDispatch(res, req, {
    action: 'type',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    selector: body.selector,
    text: body.text,
    value: body.value,
    method: body.method === 'html' ? 'html' : 'text',
    clear: !!body.clear,
    allowNonInput: !!body.allowNonInput
  }, clampTimeout(body.timeoutMs));
}

async function routeKey(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  if (!body.key) {
    badRequest(res, req, 'missing_key');
    return;
  }
  await replyDispatch(res, req, {
    action: 'key',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    key: body.key,
    selector: body.selector,
    ctrl: !!body.ctrl,
    shift: !!body.shift,
    alt: !!body.alt,
    meta: !!body.meta
  }, clampTimeout(body.timeoutMs));
}

async function routeNavigate(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (!body.url) {
    badRequest(res, req, 'missing_url');
    return;
  }
  await replyDispatch(res, req, {
    action: 'navigate',
    browser: body.browser,
    match: body.match,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    url: body.url,
    newTab: !!body.newTab,
    active: !!body.active,
    waitMs: typeof body.waitMs === 'number' ? body.waitMs : undefined
  }, clampTimeout(body.timeoutMs));
}

/* ---- 标签页与扩展管理 ---- */

async function routeWait(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  if (!body.selector && !body.text) {
    badRequest(res, req, 'missing_condition', '需要提供 selector 或 text 作为等待条件');
    return;
  }
  const waitMs = clampTimeout(body.timeoutMs, 10000);
  await replyDispatch(res, req, {
    action: 'wait',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    selector: body.selector,
    text: body.text,
    state: body.state === 'disappear' ? 'disappear' : 'appear',
    timeoutMs: waitMs,
    pollMs: body.pollMs
  }, waitMs + 5000);
}

async function routeClose(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (typeof body.tabId !== 'number') {
    badRequest(res, req, 'missing_tab_id', '关闭标签页必须显式提供 tabId，不支持按 match 批量关闭');
    return;
  }
  await replyDispatch(res, req, {
    action: 'close',
    browser: body.browser,
    tabId: body.tabId
  }, clampTimeout(body.timeoutMs));
}

async function routeActivate(req, res) {
  const body = await readBody(req).catch(() => ({}));
  await replyDispatch(res, req, {
    action: 'activate',
    browser: body.browser,
    match: body.match,
    url: body.url,
    tabId: body.tabId
  }, clampTimeout(body.timeoutMs));
}

async function routeDiag(req, res) {
  const body = await readBody(req).catch(() => ({}));
  await replyDispatch(res, req, { action: 'diag', browser: body.browser }, clampTimeout(body.timeoutMs, 10000));
}

async function routeReload(req, res) {
  const body = await readBody(req).catch(() => ({}));

  // 未指定浏览器时重载所有在线的浏览器，避免只重载了一个。
  // 每个只用较短超时：扩展收到后会立即应答再自行重载，
  // 若某个浏览器正好在重载中不响应，不应拖住其他浏览器。
  const targets = body.browser ? [body.browser] : (connectedBrowsers().length ? connectedBrowsers() : [undefined]);
  const results = [];
  for (const b of targets) {
    const r = await dispatch({ action: 'reload', browser: b }, 6000);
    results.push({ browser: b || 'auto', ok: !!r.ok, error: r.error });
  }

  const allOk = results.every((r) => r.ok);
  sendJson(res, allOk ? 200 : 502, { ok: allOk, data: { reloaded: results } }, req);
}

async function routeMark(req, res, ctx) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  const isUnmark = ctx.path === '/unmark';

  const markTask = {
    action: isUnmark ? 'unmark' : 'mark',
    match: body.match,
    url: body.url,
    tabId: body.tabId,
    frameId: typeof body.frameId === 'number' ? body.frameId : undefined,
    text: body.text,
    color: body.color,
    ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
    all: !!body.all
  };
  const markTimeout = clampTimeout(body.timeoutMs);

  // 清除全部标记时标记散落在各浏览器各自的扩展存储里，只清一个会留下另一个的残留
  // （标题前缀和图标角点都还在）。没有指定浏览器与目标时，逐个在线浏览器都清一遍。
  const broadcastUnmark = isUnmark && !body.browser
    && typeof body.tabId !== 'number' && !body.match && !body.url;

  if (broadcastUnmark) {
    const online = connectedBrowsers();
    if (online.length === 0) {
      sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
      return;
    }
    const per = [];
    const cleared = [];
    for (const b of online) {
      const r = await dispatch({ ...markTask, browser: b }, markTimeout);
      const ids = (r.data && r.data.cleared) || [];
      per.push({ browser: b, ok: !!r.ok, cleared: ids, error: r.error });
      for (const id of ids) { cleared.push(id); }
    }
    const allOk = per.every((p) => p.ok);
    sendJson(res, allOk ? 200 : 502, { ok: allOk, data: { cleared, browsers: per } }, req);
    return;
  }

  const result = await dispatch({ ...markTask, browser: body.browser }, markTimeout);
  sendJson(res, result.ok ? 200 : 502, result, req);
}

/* ------------------------------------------------------------------ *
 * 路由表
 *
 * 一个路径一行。加接口时改这里，而不是往一个巨大的 if 链里塞——见 docs/ARCHITECTURE.md。
 * ------------------------------------------------------------------ */
const ROUTES = new Map();
for (const [method, paths, handler] of [
  ['GET', ['/health', '/capabilities'], routeHealth],
  ['GET', ['/poll'], routePoll],
  ['POST', ['/result'], routeResult],
  ['GET', ['/tabs'], routeTabs],
  ['POST', ['/frames'], routeFrames],
  ['POST', ['/media'], routeMedia],
  ['POST', ['/read'], routeRead],
  ['POST', ['/links'], routeLinks],
  ['POST', ['/screenshot'], routeScreenshot],
  ['POST', ['/eval'], routeEval],
  ['POST', ['/session'], routeSession],
  ['POST', ['/download'], routeDownload],
  ['POST', ['/grab'], routeGrab],
  ['POST', ['/save'], routeSave],
  ['POST', ['/upload'], routeUpload],
  ['POST', ['/click'], routeClick],
  ['POST', ['/type'], routeType],
  ['POST', ['/key'], routeKey],
  ['POST', ['/navigate'], routeNavigate],
  ['POST', ['/wait'], routeWait],
  ['POST', ['/close'], routeClose],
  ['POST', ['/activate'], routeActivate],
  ['POST', ['/diag'], routeDiag],
  ['POST', ['/reload'], routeReload],
  ['POST', ['/mark', '/unmark'], routeMark]
]) {
  for (const p of paths) { ROUTES.set(`${method} ${p}`, handler); }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (!isAllowedOrigin(req)) {
    reportRejectedOrigin(req.headers.origin);
    sendJson(res, 403, {
      ok: false,
      error: 'origin_not_allowed',
      origin: req.headers.origin,
      hint: '只接受本机来源，以及允许列表内扩展的 chrome-extension:// 来源。'
        + '自己加载的扩展可用 --allow-extension <扩展ID> 追加（ID 见 node src/cli.js diag）。'
    }, req);
    return;
  }

  // ---- CORS 预检 ----
  if (req.method === 'OPTIONS') {
    const headers = { 'Content-Length': '0' };
    const origin = req.headers.origin;
    if (isExtensionOrigin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Max-Age'] = '600';
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const route = ROUTES.get(`${req.method} ${path}`);
  if (!route) {
    sendJson(res, 404, { ok: false, error: 'not_found', path }, req);
    return;
  }
  await route(req, res, { url, path });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    sendJson(res, 500, { ok: false, error: 'server_error', message: String(e && e.message ? e.message : e) }, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Browser Bridge 已启动: http://${HOST}:${PORT}`);
  console.log('等待浏览器扩展连接…');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。`);
    // 别建议换端口：扩展里的 BRIDGE_URL 是写死的 127.0.0.1:18777，
    // 换了端口扩展就找不到服务（表现为一直 extension_not_connected）。
    // 占用这个端口的几乎总是上一次没关干净的自己（被 --detach 拉起的那个）。
    console.error('先确认占用者是不是上一轮残留的本服务进程（tasklist / ps 里找 node）。');
    console.error('真要换端口，扩展里的 BRIDGE_URL 必须同步改，否则扩展连不上。');
  } else {
    console.error(`服务启动失败: ${e.message}`);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
});
