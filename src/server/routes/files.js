/**
 * Agent Browser Bridge —— 路由：文件类（下载、抓取、保存、上传）。
 */

'use strict';

const { readJsonBody, targetMissing, badRequest } = require('../http.js');
const { clampTimeout, replyDispatch, extensionOffline } = require('../queue.js');

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

module.exports = { routeDownload, routeGrab, routeSave, routeUpload };
