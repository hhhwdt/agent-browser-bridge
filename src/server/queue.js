/**
 * Agent Browser Bridge —— 任务队列与派发。
 *
 * 同一台机器可能同时装着 Chrome 和 Edge 两个扩展实例，因此按浏览器名分别
 * 保存长轮询连接，任务可按 browser 定向下发，避免两个浏览器互相顶替连接。
 */

'use strict';

const { URL } = require('node:url');
const { READ_TIMEOUT_MS, MAX_QUEUE } = require('./config.js');
const { sendJson } = require('./http.js');
const { acquireTabLease, releaseTabLease, getTabLease } = require('./leases.js');
const { logAudit } = require('./audit.js');

const heldPolls = new Map();     // 浏览器名 -> 挂起的长轮询响应
const lastSeen = new Map();      // 浏览器名 -> 最近心跳时间
const queues = new Map();        // 浏览器名 -> 该浏览器专属的待下发任务数组
const pending = new Map();       // 任务 id -> { resolve, timer, browser }
const wsChannels = new Map();    // 浏览器名 -> WebSocket 通道（registerWsChannel 登记）
let nextTaskId = 1;

const HEARTBEAT_MS = 30000;      // 超出此时间未心跳视为离线

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
  for (const name of wsChannels.keys()) { names.add(name); }
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

/**
 * 把各浏览器专属队列里的任务下发给对应的浏览器。
 * 每个任务只可能投递给它自己队列所属的那个浏览器，因此不存在跨浏览器误投。
 *
 * 投递优先走 WebSocket 通道（在注册中就代表连接活着、已过心跳），没有 WS 的
 * 浏览器回落到长轮询槽位——这条就是老路径，保持 1.8.0 的语义不动：扩展不在线
 * 或 WS 被环境拦截时，任务照旧等下一次 /poll。
 */
function flushTasks(browser) {
  const targets = browser ? [browser] : Array.from(queues.keys());

  for (const name of targets) {
    const q = queues.get(name);
    if (!q || q.length === 0) { continue; }

    const channel = wsChannels.get(name);
    if (channel) {
      const task = q.shift();
      let sent = false;
      try {
        sent = channel.sendTask(task);
      } catch (e) {
        sent = false;
      }
      if (sent) { continue; }
      // sendTask 返回 false 说明连接其实已死（还没触发 onclose 清理）：把任务
      // 放回队首、停用这个通道，落到长轮询分支兜底。不应有静默吞任务的情况。
      q.unshift(task);
      unregisterWsChannel(name, channel);
    }

    const res = heldPolls.get(name);
    if (!res) { continue; }                              // 该浏览器未持有长轮询，等它下次轮询

    // 一次轮询只下发一个任务，保证结果与任务一一对应
    const task = q.shift();
    heldPolls.delete(name);
    clearTimeout(res.__holdTimer);
    sendJson(res, 200, task, res.__req);
  }
}

/**
 * 登记一条鉴权过的 WebSocket 通道；同一浏览器的旧通道被顶替并关闭。
 * 由 routes/ws.js 鉴权通过后调用，关闭时 unregisterWsChannel 摘除。
 *
 * 顶替用的是专用 close 码 4420 而不是 1000：扩展端要把"被顶替"和"服务没了"
 * 区分开——被顶替的连接所属的旧实例若还活着（重连定时器在跑），看到 1000 会
 * 为了恢复服务再开一条连接，把它追着刚建立的那条顶替，形成两个实例无休止
 * 互相追逐（实测毫秒级 连接→断开 死循环，任务是随后到的，全被丢在过气通道上）。
 * 4420 的语义是"你不是当前通道了，别重连"。
 */
function registerWsChannel(browser, channel) {
  const old = wsChannels.get(browser);
  if (old && old !== channel) {
    try { old.close(4420); } catch (e) { /* 旧通道已死 */ }
  }
  wsChannels.set(browser, channel);
}

/** 摘除一条通道。只在传入的仍是登记的那条时生效，防止把重连后的新通道误摘。 */
function unregisterWsChannel(browser, channel) {
  if (wsChannels.get(browser) === channel) {
    wsChannels.delete(browser);
  }
}

/**
 * 归一化超时参数，限制在 1 秒到上限之间。
 * 默认上限 2 分钟（tab 型动作的合理值）；注册表里登记了 maxTimeout 的长动作
 * 用自己的上限。这个上限不能想当然地抬高：抓取这类标称 190 秒预算的动作，
 * 若被默认上限截成 120 秒，调用方会先收到 timeout，而扩展其实抓取还在继续——
 * 恰是 1.7.1 修过的"干完了却报超时"缺陷。上限与标称值都要在注册表里可见。
 */
function clampTimeout(value, fallback = READ_TIMEOUT_MS, cap = 120000) {
  return Math.min(Math.max(parseInt(value, 10) || fallback, 1000), cap);
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

/**
 * 结算一个任务的真实结果。HTTP POST /result 与 WS 的 {type:'result'} 上行共用
 * 这一条路径，语义完全一致。
 *
 * 回传方必须与任务投递的浏览器一致：任务只投给一个浏览器，否则同机的另一个
 * 浏览器、或任意本机进程只要猜到自增 id，就能顶替结算别人的任务。
 *
 * 返回：
 *   { resolved: true }                      已结算
 *   { resolved: false, mismatch, expected } 浏览器对不上（HTTP 侧回 409）
 *   { resolved: false }                     没有这个任务在等（已超时或从未存在）
 */
function recordResult(browser, id, result) {
  const entry = pending.get(id);
  if (!entry) { return { resolved: false }; }
  if (entry.browser && entry.browser !== browser) {
    return { resolved: false, mismatch: true, expected: entry.browser };
  }
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(result ?? { ok: false, error: 'empty_result' });
  return { resolved: true };
}

/** 扩展不在线就回 503 并返回 true（已回过包）。 */
function extensionOffline(res, req) {
  if (extensionConnected()) { return false; }
  sendJson(res, 503, { ok: false, error: 'extension_not_connected' }, req);
  return true;
}

/** 派发任务并按 ok / 502 回包——绝大多数接口的收尾都是这三行。 */
async function replyDispatch(res, req, task, timeoutMs) {
  const startTime = Date.now();
  const caller = req.socket.remotePort;

  // per-tab lease：防止两个 agent 同时操作同一个标签页
  if (task.lease && typeof task.tabId === 'number') {
    if (!acquireTabLease(task.tabId, caller)) {
      const holder = getTabLease(task.tabId);
      sendJson(res, 409, {
        ok: false,
        error: 'tab_busy',
        tabId: task.tabId,
        hint: `标签页正被其他 caller 持有（${holder ? holder.caller : 'unknown'}）。稍后再试，或不传 lease 跳过。`
      }, req);
      return;
    }
  }

  let result;
  try {
    result = await dispatch(task, timeoutMs);

    // autoActivate：遇到冻结标签页时先唤醒再重试一次
    if (!result.ok && result.error === 'tab_unresponsive' && task.autoActivate && typeof task.tabId === 'number') {
      await dispatch({ action: 'activate', tabId: task.tabId, browser: task.browser }, 10000);
      result = await dispatch(task, timeoutMs);
    }
  } finally {
    if (task.lease && typeof task.tabId === 'number') {
      releaseTabLease(task.tabId, caller);
    }
  }

  const duration = Date.now() - startTime;

  // 审计日志：只记动作元数据，不记页面内容
  logAudit({
    timestamp: new Date().toISOString(),
    action: task.action,
    target: {
      match: task.match || undefined,
      tabId: task.tabId || undefined,
      host: task.url ? (() => { try { return new URL(task.url).host; } catch (e) { return undefined; } })() : undefined
    },
    outcome: result.ok ? 'ok' : (result.error || 'unknown'),
    duration,
    caller: req.socket.remotePort
  });

  sendJson(res, result.ok ? 200 : 502, result, req);
}

module.exports = {
  heldPolls,
  lastSeen,
  pending,
  queueFor,
  queuedCount,
  normalizeBrowser,
  connectedBrowsers,
  orderBrowsers,
  flushTasks,
  registerWsChannel,
  unregisterWsChannel,
  recordResult,
  clampTimeout,
  dispatch,
  dispatchTo,
  extensionConnected,
  extensionOffline,
  replyDispatch
};
