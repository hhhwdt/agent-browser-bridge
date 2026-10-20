/**
 * Agent Browser Bridge —— 路由：查询类（读页面、标签页、截图、诊断）。
 */

'use strict';

const { API_VERSION, CAPABILITIES, READ_TIMEOUT_MS, allowedExtensionIds } = require('../config.js');
const { sendJson, readJsonBody, readBody, targetMissing, badRequest } = require('../http.js');
const {
  clampTimeout, dispatch, replyDispatch, extensionOffline,
  connectedBrowsers, orderBrowsers, extensionConnected, pending, queuedCount
} = require('../queue.js');

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
    returnHtml: !!body.returnHtml,
    format: body.format,
    autoActivate: !!body.autoActivate,
    lease: !!body.lease
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

module.exports = {
  routeHealth, routeTabs, routeFrames, routeMedia, routeRead, routeLinks,
  routeScreenshot, routeEval, routeSession, routeDiag, routeReload
};
