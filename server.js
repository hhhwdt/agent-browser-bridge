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
 * HTTP 接口（全部只监听 127.0.0.1）：
 *
 *   GET  /health
 *       返回 { ok, extensionConnected, pendingTasks }
 *
 *   GET  /tabs
 *       返回当前浏览器所有已打开标签页的只读元信息
 *       { ok, tabs: [{ id, windowId, index, active, title, url }] }
 *
 *   POST /read
 *       读取指定标签页的正文，后台执行、不切换标签、不抢焦点
 *       请求体：
 *         { match?: string        URL 子串，优先命中激活标签页
 *           url?:   string        精确或前缀匹配
 *           tabId?: number        直接指定标签页 id
 *           selector?: string     正文选择器，省略时自动识别
 *           includeLinks?: bool   是否同时返回页面链接
 *           timeoutMs?: number    等待超时，默认 30000 }
 *       返回：
 *         { ok: true, data: { tabId, wasActive, title, url, usedSelector, text, charCount, links } }
 *         或 { ok: false, error, hint? }
 *
 *   GET  /poll   （扩展专用，长轮询）
 *   POST /result （扩展专用，回传结果）
 *
 * 安全说明：
 *   - 只绑定 127.0.0.1，不对局域网或外网开放。
 *   - 校验 Origin，拒绝来自普通网页的请求，避免恶意页面通过 CSRF 驱动扩展读数据。
 *   - 服务端本身不做任何页面操作，只做转发；是否可读由浏览器扩展的站点授权决定。
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
const POLL_HOLD_MS = 25000;      // 扩展长轮询的挂起时长
const READ_TIMEOUT_MS = 30000;   // 单次操作的默认等待上限
const MAX_QUEUE = 100;           // 单浏览器队列上限，防止无扩展连接时无限堆积

/**
 * 对外接口版本。新增能力时递增次版本，破坏性变更时递增主版本。
 * 其他 agent 可先读 /health 的 apiVersion 与 capabilities 再决定调用方式。
 */
const API_VERSION = '1.0';

/** 本服务提供的能力清单，供调用方做特性探测。 */
const CAPABILITIES = [
  'tabs',         // 列出标签页
  'read',         // 读取正文
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
function isExtensionOrigin(origin) {
  return typeof origin === 'string'
    && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'));
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
  if (origin.startsWith('chrome-extension://')) { return true; }
  if (origin.startsWith('moz-extension://')) { return true; }
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

  for (let i = 0; i < order.length; i++) {
    const isLast = i === order.length - 1;
    // 非最后一次尝试用较短超时，避免目标不在该浏览器时长时间空等
    const attemptTimeout = isLast ? timeoutMs : Math.min(timeoutMs, 8000);

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
async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'origin_not_allowed' }, req);
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

  // ---- 健康检查 / 能力协商 ----
  if (req.method === 'GET' && (path === '/health' || path === '/capabilities')) {
    sendJson(res, 200, {
      ok: true,
      service: 'agent-browser-bridge',
      apiVersion: API_VERSION,
      extensionConnected: extensionConnected(),
      browsers: connectedBrowsers(),
      pendingTasks: pending.size,
      queuedTasks: queuedCount(),
      capabilities: CAPABILITIES,
      defaultBrowserOrder: orderBrowsers(connectedBrowsers())
    }, req);
    return;
  }

  // ---- 扩展长轮询 ----
  if (req.method === 'GET' && path === '/poll') {
    const browser = normalizeBrowser(url.searchParams.get('browser'));
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
    return;
  }

  // ---- 扩展回传结果 ----
  if (req.method === 'POST' && path === '/result') {
    const browser = normalizeBrowser(url.searchParams.get('browser'));
    lastSeen.set(browser, Date.now());
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    const entry = pending.get(body.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(body.id);
      entry.resolve(body.result ?? { ok: false, error: 'empty_result' });
    }
    sendJson(res, 200, { ok: true, accepted: !!entry }, req);
    return;
  }

  // ---- 列出标签页 ----
  if (req.method === 'GET' && path === '/tabs') {
    const result = await dispatch({ action: 'tabs', browser: url.searchParams.get('browser') || undefined }, READ_TIMEOUT_MS);
    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 框架诊断 ----
  if (req.method === 'POST' && path === '/frames') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    const result = await dispatch({
      action: 'frames',
      browser: body.browser,
      match: body.match,
      url: body.url,
      tabId: body.tabId
    }, clampTimeout(body.timeoutMs));

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 扩展诊断 ----
  if (req.method === 'POST' && path === '/diag') {
    const body = await readBody(req).catch(() => ({}));
    const result = await dispatch({ action: 'diag', browser: body.browser }, clampTimeout(body.timeoutMs, 10000));
    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 等待条件成立 ----
  if (req.method === 'POST' && path === '/wait') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    if (!extensionConnected()) {
      sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
      return;
    }
    if (!body.match && !body.url && typeof body.tabId !== 'number') {
      sendJson(res, 400, { ok: false, error: 'missing_target', hint: '需要提供 match、url 或 tabId 之一' }, req);
      return;
    }
    if (!body.selector && !body.text) {
      sendJson(res, 400, { ok: false, error: 'missing_condition', hint: '需要提供 selector 或 text 作为等待条件' }, req);
      return;
    }

    const waitMs = clampTimeout(body.timeoutMs, 10000);

    const result = await dispatch({
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

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 关闭标签页 ----
  if (req.method === 'POST' && path === '/close') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    if (typeof body.tabId !== 'number') {
      sendJson(res, 400, {
        ok: false,
        error: 'missing_tab_id',
        hint: '关闭标签页必须显式提供 tabId，不支持按 match 批量关闭'
      }, req);
      return;
    }

    const result = await dispatch({
      action: 'close',
      browser: body.browser,
      tabId: body.tabId
    }, clampTimeout(body.timeoutMs));

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 重新加载扩展（开发用）----
  if (req.method === 'POST' && path === '/reload') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      body = {};
    }

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
    return;
  }

  // ---- 标记 / 清除标记 ----
  if (req.method === 'POST' && (path === '/mark' || path === '/unmark')) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    const result = await dispatch({
      action: path === '/mark' ? 'mark' : 'unmark',
      browser: body.browser,
      match: body.match,
      url: body.url,
      tabId: body.tabId,
      frameId: typeof body.frameId === "number" ? body.frameId : undefined,
      text: body.text,
      color: body.color,
      all: !!body.all
    }, clampTimeout(body.timeoutMs));

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 读取页面 ----
  if (req.method === 'POST' && path === '/read') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    if (!extensionConnected()) {
      sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
      return;
    }

    if (!body.match && !body.url && typeof body.tabId !== 'number') {
      sendJson(res, 400, {
        ok: false,
        error: 'missing_target',
        hint: '需要提供 match、url 或 tabId 之一'
      }, req);
      return;
    }

    const timeoutMs = clampTimeout(body.timeoutMs);

    const result = await dispatch({
      action: 'read',
      browser: body.browser,
      match: body.match,
      url: body.url,
      tabId: body.tabId,
      frameId: typeof body.frameId === "number" ? body.frameId : undefined,
      selector: body.selector,
      includeLinks: !!body.includeLinks,
      returnHtml: !!body.returnHtml
    }, timeoutMs);

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 枚举链接 ----
  if (req.method === 'POST' && path === '/links') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    if (!extensionConnected()) {
      sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
      return;
    }
    if (!body.match && !body.url && typeof body.tabId !== 'number') {
      sendJson(res, 400, { ok: false, error: 'missing_target', hint: '需要提供 match、url 或 tabId 之一' }, req);
      return;
    }

    const result = await dispatch({
      action: 'links',
      browser: body.browser,
      match: body.match,
      url: body.url,
      tabId: body.tabId,
      frameId: typeof body.frameId === "number" ? body.frameId : undefined,
      selector: body.selector,
      text: body.text
    }, clampTimeout(body.timeoutMs));

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 点击 ----
  if (req.method === 'POST' && path === '/click') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    if (!extensionConnected()) {
      sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
      return;
    }
    if (!body.match && !body.url && typeof body.tabId !== 'number') {
      sendJson(res, 400, { ok: false, error: 'missing_target', hint: '需要提供 match、url 或 tabId 之一' }, req);
      return;
    }
    if (!body.selector && !body.text && !body.href) {
      sendJson(res, 400, {
        ok: false,
        error: 'missing_click_target',
        hint: '需要提供 selector、text 或 href 之一来定位要点击的元素'
      }, req);
      return;
    }

    // 点击可能触发页面跳转，给稍长的等待时间
    const result = await dispatch({
      action: 'click',
      browser: body.browser,
      match: body.match,
      url: body.url,
      tabId: body.tabId,
      frameId: typeof body.frameId === "number" ? body.frameId : undefined,
      selector: body.selector,
      text: body.text,
      href: body.href,
      index: body.index,
      allowNonLink: !!body.allowNonLink,
      dryRun: !!body.dryRun
    }, clampTimeout(body.timeoutMs, 45000));

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 输入文本 ----
  if (req.method === 'POST' && path === '/type') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    if (!extensionConnected()) {
      sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
      return;
    }
    if (!body.match && !body.url && typeof body.tabId !== 'number') {
      sendJson(res, 400, { ok: false, error: 'missing_target', hint: '需要提供 match、url 或 tabId 之一' }, req);
      return;
    }
    if (typeof body.value !== 'string') {
      sendJson(res, 400, { ok: false, error: 'missing_value', hint: '需要提供 value（要输入的文本）' }, req);
      return;
    }

    const result = await dispatch({
      action: 'type',
      browser: body.browser,
      match: body.match,
      url: body.url,
      tabId: body.tabId,
      frameId: typeof body.frameId === "number" ? body.frameId : undefined,
      selector: body.selector,
      text: body.text,
      value: body.value,
      method: body.method === 'html' ? 'html' : 'text',
      clear: !!body.clear,
      allowNonInput: !!body.allowNonInput
    }, clampTimeout(body.timeoutMs));

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 派发按键 ----
  if (req.method === 'POST' && path === '/key') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    if (!extensionConnected()) {
      sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
      return;
    }
    if (!body.match && !body.url && typeof body.tabId !== 'number') {
      sendJson(res, 400, { ok: false, error: 'missing_target', hint: '需要提供 match、url 或 tabId 之一' }, req);
      return;
    }
    if (!body.key) {
      sendJson(res, 400, { ok: false, error: 'missing_key' }, req);
      return;
    }

    const result = await dispatch({
      action: 'key',
      browser: body.browser,
      match: body.match,
      url: body.url,
      tabId: body.tabId,
      frameId: typeof body.frameId === "number" ? body.frameId : undefined,
      key: body.key,
      selector: body.selector,
      ctrl: !!body.ctrl,
      shift: !!body.shift,
      alt: !!body.alt,
      meta: !!body.meta
    }, clampTimeout(body.timeoutMs));

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  // ---- 导航 ----
  if (req.method === 'POST' && path === '/navigate') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, req);
      return;
    }

    if (!extensionConnected()) {
      sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
      return;
    }
    if (!body.url) {
      sendJson(res, 400, { ok: false, error: 'missing_url' }, req);
      return;
    }

    const result = await dispatch({
      action: 'navigate',
      browser: body.browser,
      match: body.match,
      tabId: body.tabId,
      frameId: typeof body.frameId === "number" ? body.frameId : undefined,
      url: body.url,
      newTab: !!body.newTab,
      active: !!body.active,
      waitMs: typeof body.waitMs === 'number' ? body.waitMs : undefined
    }, clampTimeout(body.timeoutMs));

    sendJson(res, result.ok ? 200 : 502, result, req);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found', path }, req);
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
    console.error(`端口 ${PORT} 已被占用。可用 --port 指定其他端口启动。`);
  } else {
    console.error(`服务启动失败: ${e.message}`);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
});
