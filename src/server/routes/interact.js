/**
 * Agent Browser Bridge —— 路由：交互与标签页管理。
 *
 * 直排动作由动作注册表驱动（generic.js）；这里手写的是
 * 标记（/unmark 没有目标时要逐个在线浏览器都清一遍）与批量（逐步派发）两段。
 */

'use strict';

const { sendJson, readJsonBody, badRequest } = require('../http.js');
const { clampTimeout, dispatch, connectedBrowsers } = require('../queue.js');
const { makeRoute, buildTask } = require('./generic.js');

const routeClick = makeRoute('click');
const routeType = makeRoute('type');
const routeKey = makeRoute('key');
const routeNavigate = makeRoute('navigate');
const routeWait = makeRoute('wait');
const routeClose = makeRoute('close');
const routeActivate = makeRoute('activate');

async function routeMark(req, res, ctx) {
  const body = await readJsonBody(req, res);
  if (!body) { return; }
  const markTask = buildTask(ctx.path === '/unmark' ? 'unmark' : 'mark', body);
  const markTimeout = clampTimeout(body.timeoutMs);

  // 清除全部标记时标记散落在各浏览器各自的扩展存储里，只清一个会留下另一个的残留
  // （标题前缀和图标角点都还在）。没有指定浏览器与目标时，逐个在线浏览器都清一遍。
  const broadcastUnmark = ctx.path === '/unmark' && !body.browser
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
