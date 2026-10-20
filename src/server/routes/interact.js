/**
 * Agent Browser Bridge —— 路由：交互与标签页管理（点击、输入、导航、等待、标记）。
 */

'use strict';

const { sendJson, readJsonBody, readBody, targetMissing, badRequest } = require('../http.js');
const { clampTimeout, dispatch, replyDispatch, extensionOffline, connectedBrowsers } = require('../queue.js');

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

async function routeWait(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (extensionOffline(res, req)) { return; }
  if (targetMissing(body)) {
    badRequest(res, req, 'missing_target', '需要提供 match、url 或 tabId 之一');
    return;
  }
  if (!body.selector && !body.text && !body.url && !body.idleMs) {
    badRequest(res, req, 'missing_condition', '需要提供 selector、text、url 或 idleMs 作为等待条件');
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
    count: typeof body.count === 'number' ? body.count : undefined,
    idleMs: typeof body.idleMs === 'number' ? body.idleMs : undefined,
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

/** 批量执行动作：按顺序执行，每步独立返回结果，第一步失败时停止。 */
async function routeBatch(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    badRequest(res, req, 'missing_steps', '需要提供 steps 数组');
    return;
  }
  if (body.steps.length > 20) {
    badRequest(res, req, 'too_many_steps', '单次最多 20 步');
    return;
  }

  const results = [];
  for (let i = 0; i < body.steps.length; i++) {
    const step = body.steps[i];
    if (!step || typeof step !== 'object' || !step.action) {
      results.push({ step: i, ok: false, error: 'invalid_step' });
      break;
    }
    const result = await dispatch(step, clampTimeout(step.timeoutMs));
    results.push({ step: i, action: step.action, ok: result.ok, data: result.data, error: result.error });
    if (!result.ok && !body.continueOnError) { break; }
  }

  const allOk = results.every((r) => r.ok);
  sendJson(res, allOk ? 200 : 502, { ok: allOk, results }, req);
}

module.exports = {
  routeClick, routeType, routeKey, routeNavigate, routeWait,
  routeClose, routeActivate, routeMark, routeBatch
};
