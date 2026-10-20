/**
 * Agent Browser Bridge —— 入口：长轮询主循环、任务分派、启动引导、错误记录、弹窗消息。
 *
 * 这里只做"接线"，具体动作在 actions-*.js，注入函数在 inject-*.js。
 *
 * 改动时的两条硬约束（本项目踩过）：
 *   - 注入函数必须自包含。可用 tools/check-inject-scope.js 静态检查。
 *   - 每次注入都要有超时。冻结的标签页会让 executeScript 永不返回。
 */

'use strict';

import { BRIDGE_URL, BROWSER_NAME, KEEPALIVE_ALARM, POLL_TIMEOUT_MS, RETRY_DELAY_MS, TOKEN_HEADER } from './config.js';
import { MARKS_KEY, collectMarkedTabs, loadMarks, markTab, markTask, markedTabs, removeBadge, saveMarks, unmarkTask } from './marks.js';
import { startWs, retryWs, wsConnected, wsState } from './ws.js';
import { activateTab, clickTab, downloadTab, evalTab, framesDiag, grabTab, keyTab, linksTab, listTabs, mediaTab, navigateTab, readTab, saveTab, screenshotTab, sessionTab, typeTab, uploadTab, waitTab } from './actions.js';

let loopRunning = false;
/** WebSocket 回调登记：bootstrap 填写，保活闹钟的 retryWs 救援复用。 */
let keepWs = null;

/** 返回扩展的运行诊断信息：标识、连接状态、错误日志。 */

async function diagAction() {
  let errors = [];
  let marks = [];
  let alarm = null;
  try {
    const stored = await chrome.storage.session.get(ERROR_LOG_KEY);
    errors = (stored && stored[ERROR_LOG_KEY]) || [];
  } catch (e) { /* 忽略 */ }
  try {
    const stored = await chrome.storage.session.get(MARKS_KEY);
    marks = (stored && stored[MARKS_KEY]) || [];
  } catch (e) { /* 忽略 */ }
  try {
    alarm = await chrome.alarms.get(KEEPALIVE_ALARM);
  } catch (e) { /* 忽略 */ }

  let boot = null;
  try {
    const stored = await chrome.storage.local.get('abb-boot');
    boot = (stored && stored['abb-boot']) || null;
  } catch (e) { /* 忽略 */ }

  // 站点授权状态。调用方据此判断"还差哪一步"，用户不必去翻扩展弹窗。
  // 必需权限里的桥接地址要滤掉：那不是用户授的，混在列表里会让人以为已经授权过什么。
  let grantedOrigins = [];
  let cookiesGranted = false;
  let allSitesGranted = false;
  try {
    const perms = await chrome.permissions.getAll();
    grantedOrigins = (perms.origins || []).filter((o) => !o.includes('127.0.0.1') && !o.includes('localhost'));
    cookiesGranted = (perms.permissions || []).includes('cookies');
    allSitesGranted = grantedOrigins.some((o) => o === '*://*/*' || o === 'http://*/*' || o === 'https://*/*');
  } catch (e) { /* 权限查询失败时留空，不阻断诊断 */ }

  // 实时检测哪些标签页真的有标记（标题前缀或徽标），而不是依赖 storage 里的历史记录
  const actuallyMarked = await collectMarkedTabs();

  return {
    ok: true,
    data: {
      browser: BROWSER_NAME,
      bridgeUrl: BRIDGE_URL,
      version: chrome.runtime.getManifest().version,
      // 服务端按扩展 ID 放行，这里报出来便于排查 403（自己加载的扩展 ID 应与服务端一致）
      extensionId: chrome.runtime.id,
      loopRunning,
      // WebSocket 任务通道状态（1.9 起 healthy=已鉴权并回 ready）
      ws: wsState(),
      // service worker 启动次数与时间，用于判断是否被频繁回收
      boot,
      markedTabs: actuallyMarked,
      markedCount: actuallyMarked.length,
      keepaliveAlarm: alarm ? { periodInMinutes: alarm.periodInMinutes, scheduledTime: alarm.scheduledTime } : null,
      grantedOrigins,
      allSitesGranted,
      cookiesGranted,
      errorCount: errors.length,
      errors
    }
  };
}

/** 执行任务本体，不含标记逻辑。 */

async function runAction(task) {
  switch (task.action) {
    case 'tabs':
      return await listTabs();
    case 'read':
      return await readTab(task);
    case 'eval':
      return await evalTab(task);
    case 'screenshot':
      return await screenshotTab(task);
    case 'session':
      return await sessionTab(task);
    case 'upload':
      return await uploadTab(task);
    case 'media':
      return await mediaTab(task);
    case 'grab':
      return await grabTab(task);
    case 'save':
      return await saveTab(task);
    case 'download':
      return await downloadTab(task);
    case 'links':
      return await linksTab(task);
    case 'frames':
      return await framesDiag(task);
    case 'wait':
      return await waitTab(task);
    case 'diag':
      return await diagAction();
    case 'activate':
      return await activateTab(task);
    case 'click':
      return await clickTab(task);
    case 'type':
      return await typeTab(task);
    case 'key':
      return await keyTab(task);
    case 'navigate':
      return await navigateTab(task);
    case 'mark':
      return await markTask(task);
    case 'unmark':
      return await unmarkTask(task);
    case 'close':
      return await closeTab(task);
    case 'reload':
      return reloadExtension();
    case 'ping':
      return { ok: true, pong: true, browser: BROWSER_NAME };
    default:
      return { ok: false, error: 'unknown_action', action: task.action };
  }
}

/** 除这些动作外，操作过的标签页都会自动打上标记。 */

const NO_MARK_ACTIONS = new Set(['tabs', 'unmark', 'ping', 'mark', 'close', 'reload']);

/**
 * 关闭标签页。
 * 必须显式指定 tabId，不支持按 match 批量关闭，避免误关用户正在看的页面。
 */

async function closeTab(task) {
  if (typeof task.tabId !== 'number') {
    return {
      ok: false,
      error: 'missing_tab_id',
      hint: '关闭标签页必须显式提供 tabId，以免误关其他页面'
    };
  }

  const tab = await chrome.tabs.get(task.tabId).catch(() => null);
  if (!tab) {
    return { ok: false, error: 'no_tab_matched', tabId: task.tabId };
  }

  await removeBadge(task.tabId);
  await saveMarks();

  try {
    await chrome.tabs.remove(task.tabId);
  } catch (e) {
    return { ok: false, error: 'close_failed', message: String(e && e.message ? e.message : e) };
  }

  return {
    ok: true,
    data: {
      tabId: task.tabId,
      browser: BROWSER_NAME,
      closedTitle: tab.title || '',
      closedUrl: tab.url || ''
    }
  };
}

/**
 * 重新加载扩展自身。
 *
 * 用途：开发时改了扩展代码，无需用户手动去 edge://extensions 点"重新加载"。
 * 先延时再重载，确保本次任务的结果能先回传给服务端，否则响应会丢失。
 * 重载后长轮询会自动重建（service worker 重新启动时调用 bootstrap）。
 */

function reloadExtension() {
  setTimeout(() => {
    try {
      chrome.runtime.reload();
    } catch (e) {
      // 重载失败时保持原状态，不影响后续任务
    }
  }, 1200);

  return {
    ok: true,
    data: {
      browser: BROWSER_NAME,
      reloading: true,
      delayMs: 1200,
      hint: '扩展将在约 1.2 秒后重新加载，之后自动重连'
    }
  };
}

async function handleTask(task) {
  try {
    // 目标浏览器的校验：服务端已按浏览器分队列，这里是第二道防线，
    // 确保即使路由出错，任务也不会被另一个浏览器执行。
    if (task.browser && task.browser !== BROWSER_NAME) {
      return {
        ok: false,
        error: 'browser_mismatch',
        expected: task.browser,
        actual: BROWSER_NAME
      };
    }

    const result = await runAction(task);

    // 操作成功后给目标标签页打标记，让用户能看到哪些页面被操作过
    if (result && result.ok && !NO_MARK_ACTIONS.has(task.action)) {
      const tabId = result.data && result.data.tabId;
      if (typeof tabId === 'number') {
        const detail = result.data.clicked && result.data.clicked.text
          ? result.data.clicked.text.slice(0, 40)
          : undefined;
        await markTab(tabId, task.action, detail);
      }
    }

    return result;
  } catch (e) {
    return { ok: false, error: 'handler_exception', message: String(e && e.message ? e.message : e) };
  }
}

/* ------------------------------------------------------------------ *
 * 长轮询主循环
 * ------------------------------------------------------------------ */

/** 从 chrome.storage.local 读取 token，构造请求头。 */
async function tokenHeaders() {
  try {
    const stored = await chrome.storage.local.get('abb-token');
    const token = stored && stored['abb-token'];
    if (token) { return { [TOKEN_HEADER]: token }; }
  } catch (e) { /* 忽略 */ }
  return {};
}

async function pollOnce() {
  const res = await fetch(`${BRIDGE_URL}/poll?browser=${encodeURIComponent(BROWSER_NAME)}`, {
    method: 'GET',
    cache: 'no-store',
    headers: await tokenHeaders(),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5000)
  });

  if (res.status === 401) {
    // token 无效或缺失：不重试，等用户在弹窗里更新
    console.warn('[abb] token 被拒绝（401），请在扩展弹窗里更新 token');
    return { authFailed: true };
  }
  if (res.status === 204) {
    return; // 正常超时，没有任务
  }
  if (!res.ok) {
    throw new Error(`poll HTTP ${res.status}`);
  }

  const task = await res.json();
  if (!task || typeof task.id === 'undefined') {
    return;
  }

  // 关键：不要把任务执行 await 在轮询循环里。
  // 一个耗时任务（例如遍历大量已关闭标签页的 unmark）会阻塞后续轮询，
  // 服务端 30 秒收不到轮询就会判定该浏览器掉线——表现为"卡住然后掉线"。
  // 因此异步执行，立刻回去接收下一个任务。
  handleTask(task)
    .then((result) => postResult(task.id, result))
    .catch((e) => postResult(task.id, {
      ok: false,
      error: 'handler_exception',
      message: String(e && e.message ? e.message : e)
    }));
}

/** 回传任务结果。 */

async function postResult(taskId, result) {
  // 让结果里带上来源浏览器，便于调用方确认实际读取的是哪一个
  if (result && typeof result === 'object') {
    result.browser = BROWSER_NAME;
    if (result.data && typeof result.data === 'object') {
      result.data.browser = BROWSER_NAME;
    }
  }

  try {
    const headers = { 'Content-Type': 'application/json', ...(await tokenHeaders()) };
    const res = await fetch(`${BRIDGE_URL}/result?browser=${encodeURIComponent(BROWSER_NAME)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: taskId, result }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      // 结果没被服务端接收（体积超限、id 已失效等）。不记下来的话，
      // 调用方只会干等到超时，事后查 diag 也看不到任何线索。
      const detail = await res.text().catch(() => '');
      logError('postResult', new Error(`HTTP ${res.status} ${detail}`.slice(0, 300)));
    }
  } catch (e) {
    logError('postResult', e);
  }
}

async function pollLoop() {
  if (loopRunning) { return; }
  loopRunning = true;

  try {
    // 服务脚本可能被浏览器回收，这里用循环保证连接持续恢复。
    //
    // 重试间隔固定为 RETRY_DELAY_MS，不做指数退避：退避的理由是"桥接长时间不可用
    // 时空转耗电"，但这里失败的多半只是一次回环连接的 ECONNREFUSED，代价可以忽略；
    // 而退避到 30 秒的代价是：桥接重启后扩展最长要等 30 秒才连上，这期间所有工具
    // 都返回 extension_not_connected（实测踩到，冷启动时尤其明显）。
    //
    // WebSocket 通道在线时轮询让位（任务由服务端直接推下来，通道自己维持心跳）。
    // 这里只是歇口气，不退出循环：通道一断，下一次循环就会回到轮询，回退无缝。
    for (;;) {
      try {
        if (wsConnected()) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        const result = await pollOnce();
        if (result && result.authFailed) {
          // token 被拒绝：不重试，等用户在弹窗里更新
          console.warn('[abb] 轮询停止：token 被拒绝（401）');
          break;
        }
      } catch (e) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  } finally {
    loopRunning = false;
  }
}

// 标签页关闭后清理它的标记记录，避免列表无限增长
chrome.tabs.onRemoved.addListener((tabId) => {
  if (markedTabs.delete(tabId)) {
    saveMarks();
  }
});
// 定时唤醒，防止 MV3 服务脚本被回收后不再自行恢复。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    pollLoop();
    // 通道救援：长轮询兜底会一直保持 SW 活动，authFailed 之类卡死的状态
    // 等不到下一次 bootstrap，闹钟在这里按同样的节拍补一条重试
    if (keepWs) { retryWs(keepWs.onTask, keepWs.logError); }
  }
});

const ERROR_LOG_KEY = 'abb-error-log';

/** 记录运行时错误，供 diag 动作读取，便于定位 service worker 异常。 */

function logError(where, err) {
  try {
    const msg = err && err.stack ? err.stack : String(err && err.message ? err.message : err);
    chrome.storage.session.get(ERROR_LOG_KEY).then((stored) => {
      const arr = (stored && stored[ERROR_LOG_KEY]) || [];
      arr.push({ where, msg: msg.slice(0, 500) });
      return chrome.storage.session.set({ [ERROR_LOG_KEY]: arr.slice(-25) });
    }).catch(() => {});
  } catch (e) {
    // 记录失败不影响主流程
  }
}

// 捕获未处理异常与未处理的 Promise 拒绝。
// MV3 的 service worker 不会把这类错误显示在任何界面上，
// 不主动记录就只能看到"扩展莫名掉线"。
try {
  self.addEventListener('error', (ev) => logError('error', ev.error || ev.message));
  self.addEventListener('unhandledrejection', (ev) => logError('unhandledrejection', ev.reason));
} catch (e) {
  // 非 service worker 环境
}
/**
 * 启动计数。MV3 的 service worker 会被浏览器回收，每次重新启动都会再跑一遍
 * 顶层代码。计数增长快说明 SW 频繁被回收，长轮询没能维持存活。
 */

function bumpBootCount() {
  try {
    chrome.storage.local.get('abb-boot').then((o) => {
      const s = (o && o['abb-boot']) || { count: 0, firstAt: Date.now() };
      s.count += 1;
      s.lastAt = Date.now();
      return chrome.storage.local.set({ 'abb-boot': s });
    }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

/**
 * 供扩展弹窗调用的本地操作。
 * 走消息而不是 HTTP，这样桥接服务没开时也能查看和清除标记。
 */
try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'abb-popup') { return undefined; }
    (async () => {
      try {
        if (msg.action === 'status') {
          sendResponse({
            ok: true,
            browser: BROWSER_NAME,
            version: chrome.runtime.getManifest().version,
            markedCount: markedTabs.size,
            markedTabs: Array.from(markedTabs)
          });
          return;
        }
        if (msg.action === 'clearMarks') {
          const r = await unmarkTask({});
          sendResponse({ ok: true, cleared: (r.data && r.data.cleared) || [] });
          return;
        }
        sendResponse({ ok: false, error: 'unknown_action' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true; // 异步响应
  });
} catch (e) {
  logError('runtime.onMessage', e);
}

function bootstrap() {
  bumpBootCount();
  try {
    loadMarks();
  } catch (e) {
    logError('bootstrap.loadMarks', e);
  }
  pollLoop();

  // WebSocket 任务通道。任务推进 WS 后由 onTask 走与轮询完全相同的处理路径
  //（异步执行 + HTTP POST /result 回传），通道只改任务的"到达方式"。
  // 回调存进 keepWs：保活闹钟的 retryWs 救援复用同一处理路径。
  try {
    keepWs = {
      onTask: (task) => {
        handleTask(task)
          .then((result) => postResult(task.id, result))
          .catch((e) => postResult(task.id, {
            ok: false,
            error: 'handler_exception',
            message: String(e && e.message ? e.message : e)
          }));
      },
      logError
    };
    startWs(keepWs.onTask, keepWs.logError);
  } catch (e) {
    logError('bootstrap.startWs', e);
  }
}

/* ------------------------------------------------------------------ *
 * 启动引导、事件监听、弹窗消息
 * ------------------------------------------------------------------ */

// 定时唤醒。个别浏览器对最小周期有限制，失败则退回 1 分钟。
// 这段只能出现一次：bootstrap 里的 bumpBootCount 每次都会 +1，重复注册会让
// diag 报出的"SW 启动次数"翻倍，而它正是判断服务脚本是否被频繁回收的依据。
try {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
} catch (e) {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  } catch (e2) {
    logError('alarms.create', e2);
  }
}

try {
  chrome.runtime.onStartup.addListener(bootstrap);
  chrome.runtime.onInstalled.addListener(bootstrap);
} catch (e) {
  logError('runtime.listeners', e);
}

bootstrap();

