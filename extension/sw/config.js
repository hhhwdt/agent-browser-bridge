/**
 * Agent Browser Bridge —— 配置与运行环境：桥接地址、轮询参数、当前浏览器标识。
 */

'use strict';

const BRIDGE_URL = 'http://127.0.0.1:18777';

const POLL_TIMEOUT_MS = 25000;   // 服务端最长挂起时间，略小于服务端超时

const RETRY_DELAY_MS = 3000;     // 桥接服务不可用时的重试间隔

const KEEPALIVE_ALARM = 'abb-keepalive';

/**
 * 当前扩展所在浏览器的标识。
 * 服务端据此把任务路由到正确的浏览器，避免同机多个浏览器互相顶替连接。
 */

const BROWSER_NAME = (() => {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('edg/')) { return 'edge'; }
  if (ua.includes('firefox/')) { return 'firefox'; }
  if (ua.includes('chrome/')) { return 'chrome'; }
  return 'unknown';
})();

/* 供其他模块使用 */
export { BRIDGE_URL, BROWSER_NAME, KEEPALIVE_ALARM, POLL_TIMEOUT_MS, RETRY_DELAY_MS };

