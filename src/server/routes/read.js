/**
 * Agent Browser Bridge —— 路由：查询类（健康检查、读页面、标签页、截图、诊断）。
 *
 * 直排动作全部由动作注册表驱动（generic.js），这里只剩
 * 健康检查的静态信息与 reload 的多播派发两段手写逻辑。
 */

'use strict';

const { API_VERSION, CAPABILITIES, allowedExtensionIds } = require('../config.js');
const { sendJson, readBody } = require('../http.js');
const {
  dispatch, connectedBrowsers, orderBrowsers, extensionConnected, pending, queuedCount
} = require('../queue.js');
const { makeRoute } = require('./generic.js');

const routeHealth = async function routeHealth(req, res) {
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
};

const routeTabs = makeRoute('tabs');
const routeFrames = makeRoute('frames');
const routeMedia = makeRoute('media');
const routeRead = makeRoute('read');
const routeLinks = makeRoute('links');
const routeScreenshot = makeRoute('screenshot');
const routeEval = makeRoute('eval');
const routeSession = makeRoute('session');
const routeDiag = makeRoute('diag');

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

module.exports = {
  routeHealth, routeTabs, routeFrames, routeMedia, routeRead, routeLinks,
  routeScreenshot, routeEval, routeSession, routeDiag, routeReload
};
