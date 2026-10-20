/**
 * Agent Browser Bridge —— 路由：扩展侧长轮询与结果回传。
 */

'use strict';

const { POLL_HOLD_MS, RESULT_MAX_BODY } = require('../config.js');
const { sendJson, readJsonBody } = require('../http.js');
const { normalizeBrowser, heldPolls, lastSeen, pending, flushTasks } = require('../queue.js');

async function routePoll(req, res, ctx) {
  // 这里**不能**靠 Origin 判断调用方是不是本扩展：扩展清单里有
  // http://127.0.0.1:18777/* 的 host_permissions，这类请求不受 CORS 约束,
  // 浏览器因此不发 Origin 头。实测扩展发来的 /poll 没有 Origin，
  // 一旦在此要求扩展来源，真扩展会被自己人挡在门外（1.5.0 上踩过）。
  // 代价是：网页用一个 <img src=".../poll?browser=edge"> 仍能冒充在线浏览器，
  // 把下一个任务接到自己的连接上（读不到内容，但任务被吞掉，调用方白等到超时）。
  // 要堵这个只能引入共享密钥，见 SECURITY.md 的"还能冒充吗"一节。
  const browser = normalizeBrowser(ctx.url.searchParams.get('browser'));
  lastSeen.set(browser, Date.now());
  res.__req = req;
  res.__browser = browser;

  // 同一浏览器只保留一个长轮询，新的连接顶替旧的
  const stale = heldPolls.get(browser);
  if (stale) {
    clearTimeout(stale.__holdTimer);
    try { stale.end(); } catch (e) { /* 旧连接已断开 */ }
    heldPolls.delete(browser);
  }

  heldPolls.set(browser, res);
  res.__holdTimer = setTimeout(() => {
    if (heldPolls.get(browser) === res) { heldPolls.delete(browser); }
    res.writeHead(204).end();
  }, POLL_HOLD_MS);

  req.on('close', () => {
    if (heldPolls.get(browser) === res) { heldPolls.delete(browser); }
    clearTimeout(res.__holdTimer);
  });

  flushTasks();
}

async function routeResult(req, res, ctx) {
  const browser = normalizeBrowser(ctx.url.searchParams.get('browser'));
  lastSeen.set(browser, Date.now());

  const body = await readJsonBody(req, res, RESULT_MAX_BODY);
  if (!body) { return; }

  const entry = pending.get(body.id);
  if (entry) {
    // 任务只会投给某一个浏览器，回传方必须与它一致。否则同机另一个浏览器
    // 或本机任意进程只要猜到自增的 id，就能顶替别人去结算任务结果。
    if (entry.browser && entry.browser !== browser) {
      sendJson(res, 409, {
        ok: false,
        error: 'browser_mismatch',
        expected: entry.browser,
        actual: browser
      }, req);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(body.id);
    entry.resolve(body.result ?? { ok: false, error: 'empty_result' });
  }
  sendJson(res, 200, { ok: true, accepted: !!entry }, req);
}

module.exports = { routePoll, routeResult };
