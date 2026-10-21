/**
 * Agent Browser Bridge —— WebSocket 任务通道（扩展侧）。
 *
 * 作用：任务下达从"扩展等下一次轮询"变成"服务端有任务直接推"。
 * 与长轮询是回退关系而不是互补关系：WS 连通时轮询循环会主动让位（见
 * background.js 的 pollLoop），WS 断开后轮询自动接管，行为回到 1.8.0。
 *
 * 结果回传也走这条通道（sendResult，{type:'result'} 帧）：服务端结算路径与
 * HTTP /result 共用。通道断开时 background.js 的 postResult 自动回落 HTTP，
 * 结果不会因为送到哪条路而不同。
 *
 * MV3 服务脚本被浏览器回收的问题：Chrome 116 起 WebSocket 的收发活动会计入
 * service worker 的 idle 重置，服务端每 20 秒发一条会进事件循环的数据帧（ka），
 * SW 因此在桥接在线期间常驻（控制帧 ping 由网络栈自动应答，不重置计时器）。
 *
 * 断线重连沿用长轮询的固定间隔策略（RETRY_DELAY_MS，不做指数退避——理由见
 * background.js pollLoop 的注释：本地回环连接失败代价小，桥接重启后要快恢复）。
 */

import { BRIDGE_URL, BROWSER_NAME, RETRY_DELAY_MS } from './config.js';

let sock = null;
let healthy = false;
let authFailed = false;
/** 已排定的重连定时器句柄。任何新的连接尝试都要先撤掉它，避免旧定时器开第二条连接。 */
let retryTimer = null;

/** 当前通道状态。healthy = 鉴权通过、服务端已回 ready。 */
export function wsState() {
  return { healthy, authFailed };
}

export function wsConnected() {
  return healthy;
}

/** token 被拒绝或扩展 ID 不在允许列表：等用户在弹窗处理，不再重试。 */
export function wsAuthFailed() {
  return authFailed;
}

/**
 * 任务结果经 WS 上行。通道健康时优先走这条，与 HTTP POST /result 在服务端
 * 共用同一结算路径，语义一致；本机回环上省一次 HTTP 往返的握手与鉴权。
 * 返回 false 表示通道不可用（断开瞬间 / 回退轮询模式），调用方回落 HTTP。
 */
export function sendResult(taskId, result) {
  const s = sock;
  if (!s || !healthy) { return false; }
  try {
    s.send(JSON.stringify({ type: 'result', id: taskId, result }));
    return true;
  } catch (e) {
    // send 一般不抛但也有竞态（连接正在死）：回落 HTTP，结果不会丢
    return false;
  }
}

/** 启动通道。重复调用是空操作（bootstrap 可能被多个事件触发）。 */
export function startWs(onTask, logError) {
  if (sock) { return; }
  connect(onTask, logError);

  // 用户在弹窗里换 token 后立刻重试连接，不必等下一次任务失败再发现。
  // 只在 authFailed 状态下动作：正常断线有自己的重连循环，不受影响。
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes['abb-token'] || !authFailed) { return; }
      authFailed = false;
      connect(onTask, logError);
    });
  } catch (e) {
    // 非扩展环境（测试）没有 storage
  }
}

/**
 * 保活闹钟的救援入口：通道尚未建立时再试一次。
 *
 * 为什么闹钟也要管 WS：长轮询兜底是持续活动的，service worker 一直不挂起，
 * 旧状态里 latch 的 authFailed 永远等不到重新 bootstrap。闹钟每 0.5 分钟进来
 * 看一眼，与 pollLoop 的"401 后每个闹钟周期重试一次"保持同样的节拍；token 仍
 * 无效的话每分钟一条 console.warn，属于既有的轮询行为，不再额外降噪。
 */
export function retryWs(onTask, logError) {
  if (sock) { return; }
  connect(onTask, logError);
}

function connect(onTask, logError) {
  // 入口防重入：已有连接（哪怕此刻正被顶替）时绝不多开。没有这个 guard，
  // 过期的 onclose 重连定时器和保活闹钟的 retryWs 会在毫秒级窗口内各开一条，
  // 服务端按"同浏览器新连接顶替旧连接"把先前那条杀掉，被杀那条的重连定时器
  // 再开一条……形成谁也不服谁的追逐链（实测：连接→断开每秒数次死循环，
  // 之后到达的任务全投在马上要过气的通道上，调用方拿到 timeout）。
  if (sock) { return; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  const url = BRIDGE_URL.replace(/^http/, 'ws') + '/ws';
  let opened = false;
  let helloSent = false;

  let s;
  try {
    s = new WebSocket(url);
  } catch (e) {
    // WebSocket 构造失败（理论不常见）：退回轮询，稍后重试
    if (logError) { logError('ws.construct', e); }
    healthy = false;
    sock = null;
    setTimeout(() => connect(onTask, logError), RETRY_DELAY_MS);
    return;
  }
  sock = s;

  s.onopen = async () => {
    opened = true;
    try {
      const stored = await chrome.storage.local.get('abb-token');
      s.send(JSON.stringify({
        type: 'hello',
        token: (stored && stored['abb-token']) || '',
        extensionId: chrome.runtime.id,
        browser: BROWSER_NAME,
        version: chrome.runtime.getManifest().version
      }));
      helloSent = true;
    } catch (e) {
      if (logError) { logError('ws.hello', e); }
    }
  };

  s.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') { return; }

    if (msg.type === 'ready') {
      healthy = true;
      return;
    }
    if (msg.type === 'task' && msg.task) {
      onTask(msg.task);
    }
    // 其他帧忽略：服务端的任务从不要求扩展经 WS 回执
  };

  s.onerror = () => {
    // 有 onclose 兜着，这里只留个痕；不在这里重连，避免 close+error 双触发
    if (!opened && helloSent === false && logError) {
      const e = new Error('websocket handshake failed');
      logError('ws.handshake', e);
    }
  };

  s.onclose = (ev) => {
    // 过期连接的残余 onclose 不许碰状态：sock 已经指向（或曾经指向）更新的
    // 连接时，这条关闭属于被顶替/已废弃的旧 socket，重连由已经在跑的那条负责，
    // 这里再动 sock/healthy 会把活着的连接"判死"，触发下一轮追逐。
    if (sock !== s) { return; }

    const code = ev && ev.code;
    const wasHealthy = healthy;
    healthy = false;
    sock = null;

    // 4401：token 被拒；4403：扩展 ID 不在允许列表。与轮询的 401、扩展来源
    // 403 一一对应，都是"等用户处理"而不是自动重试的状态
    if (code === 4401 || code === 4403) {
      authFailed = true;
      console.warn(`[abb] WebSocket 被服务端拒绝（${code}），停止重连；`
        + (code === 4401 ? '请在扩展弹窗里更新 token' : '扩展 ID 不在服务端允许列表'));
      return;
    }

    // 4420：被同浏览器的更新连接顶替。新实例已经接管这个浏览器的通道，
    // 这里既不重连也不算失败；若新实例随后死掉，保活闹钟的 retryWs 会再救。
    if (code === 4420) { return; }

    // 打开连 hello 都没发出去一次的失败是既有的轮询循环会接管的场景，
    // 不在这里反复告警
    if (wasHealthy && logError) {
      logError('ws.close', Object.assign(new Error(`closed ${code}`), {}));
    }
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; connect(onTask, logError); }, RETRY_DELAY_MS);
    }
  };
}
