/**
 * Agent Browser Bridge —— 通用路由执行器。
 *
 * 按 src/actions-registry.js 里登记的校验规则、参数形态与默认超时，
 * 把一个直排动作（读请求体 → 校验 → 组装任务 → 派发 → 回包）写一遍就够。
 * 路由文件对每个动作一行 makeRoute('名字')，导出名与原来一致，路由表不用动。
 * 标记 / 批量 / 重载这类有多播或循环逻辑的动作仍手写，注册表里标 bespoke。
 */

'use strict';

const { READ_TIMEOUT_MS } = require('../config.js');
const { readJsonBody, readBody, targetMissing, badRequest } = require('../http.js');
const { replyDispatch, extensionOffline, clampTimeout } = require('../queue.js');
const ACTIONS = require('../../actions-registry.js').ACTIONS;

const TARGET_HINT = '需要提供 match、url 或 tabId 之一';

/** 按参数形态把请求体里的一个值转成任务字段。 */
function castParam(spec, value, body) {
  if (typeof spec === 'string') {
    if (spec === 'bool') { return !!value; }
    if (spec === 'number') { return typeof value === 'number' ? value : undefined; }
    return value;
  }
  if (spec.values) { return spec.values.includes(value) ? value : spec.default; }
  if (spec.waitBudget !== undefined) { return clampTimeout(body.timeoutMs, spec.waitBudget); }
  return value;
}

/**
 * 按注册表组装任务对象。校验之后调用；mark/unmark 等定制路由也复用，
 * 保证任务字段只在一处定义。
 */
function buildTask(name, body) {
  const entry = ACTIONS[name];
  if (!entry) { throw new Error('注册表里没有这个动作：' + name); }
  const task = { action: name };

  if (entry.target === 'page') {
    task.browser = body.browser;
    task.match = body.match;
    task.url = body.url;
    task.tabId = body.tabId;
  } else if (entry.target === 'close') {
    task.browser = body.browser;
    task.tabId = body.tabId;
  } else if (entry.target === 'mark') {
    // browser 在定向下发时补上（未指定时要交给 dispatch 按浏览器顺序选）
    task.match = body.match;
    task.url = body.url;
    task.tabId = body.tabId;
  } else if (entry.target === 'diag') {
    task.browser = body.browser;
  }

  for (const [key, spec] of Object.entries(entry.params || {})) {
    task[key] = castParam(spec, body[key], body);
  }
  return task;
}

/** 命中任一校验规则就回 400 并返回 true（已回包，调用方直接 return）。 */
function runChecks(checks, body, res, req) {
  for (const c of checks || []) {
    if (c.target && targetMissing(body)) {
      badRequest(res, req, 'missing_target', TARGET_HINT);
      return true;
    }
    if (c.grabTarget !== undefined && !body.match && typeof body.tabId !== 'number') {
      badRequest(res, req, 'missing_target', c.grabTarget);
      return true;
    }
    if (c.any && !c.any.some((key) => body[key])) {
      badRequest(res, req, c.error, c.hint);
      return true;
    }
    if (c.str && typeof body[c.str] !== 'string') {
      badRequest(res, req, c.error, c.hint);
      return true;
    }
    if (c.nonEmptyStr && (typeof body[c.nonEmptyStr] !== 'string' || !body[c.nonEmptyStr].trim())) {
      badRequest(res, req, c.error, c.hint);
      return true;
    }
    if (c.truthy && !body[c.truthy]) {
      badRequest(res, req, c.error, c.hint);
      return true;
    }
    if (c.number && typeof body[c.number] !== 'number') {
      badRequest(res, req, c.error, c.hint);
      return true;
    }
  }
  return false;
}

/** 派发前的等待上限。任务里带预算的动作（wait）要回预算再加网络余量。 */
function resolveTimeout(entry, task, body) {
  if (entry.timeout === 'wait') { return task.timeoutMs + 5000; }
  if (entry.timeout === 'once') { return READ_TIMEOUT_MS; }
  if (typeof entry.timeout === 'number') { return clampTimeout(body.timeoutMs, entry.timeout); }
  return clampTimeout(body.timeoutMs);
}

/** 生成一个动作的通用路由处理器；ctx 只在 GET 型动作读 query 时用。 */
function makeRoute(name) {
  const entry = ACTIONS[name];
  if (!entry) { throw new Error('注册表里没有这个动作：' + name); }
  return async function routeGeneric(req, res, ctx) {
    let body = {};
    if (entry.body === 'raw') {
      body = await readBody(req).catch(() => ({}));
    } else if (entry.body !== 'none') {
      body = await readJsonBody(req, res);
      if (!body) { return; }
    }
    if (entry.offline && extensionOffline(res, req)) { return; }
    if (runChecks(entry.checks, body, res, req)) { return; }

    // GET /tabs 的目标不在请求体里，在 query 上
    if (entry.target === 'query') {
      await replyDispatch(res, req, {
        action: 'tabs',
        browser: ctx.url.searchParams.get('browser') || undefined
      }, READ_TIMEOUT_MS);
      return;
    }

    const task = buildTask(name, body);
    await replyDispatch(res, req, task, resolveTimeout(entry, task, body));
  };
}

module.exports = { makeRoute, buildTask, runChecks };
