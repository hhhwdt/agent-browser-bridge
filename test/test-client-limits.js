#!/usr/bin/env node
/**
 * 客户端限流与重试测试：并发闸门、读类重试、写类永不重试。
 *
 * 防的失败：
 *   - 批量作业把几百个请求同时打进来，浏览器和站点被打爆（没有并发闸门时）
 *   - 超时后自动重试一个 click —— 第一次其实已经点下去了，重试就是点两次
 *   - 业务性失败（未授权、找不到元素）被当成暂时性故障反复重试，白等
 *
 * 用一个假桥接（本地 HTTP）驱动真实的 src/client.js，不碰真服务、不需要浏览器。
 *
 *   node test-client-limits.js
 */

'use strict';

const path = require('node:path');
const http = require('node:http');
const { createClient } = require(path.join(__dirname, '..', 'src', 'client.js'));

const PORT = 18970;
const HOST = '127.0.0.1';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

/* ---------------- 假桥接 ---------------- */

let active = 0;
let maxActive = 0;
const attempts = new Map();     // path -> 次数
let readFailuresLeft = 0;
let readError = 'timeout';
const readDelayMs = 30;
const completionOrder = [];
let readSeq = 0;

function envelope(payload) {
  return JSON.stringify(payload);
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  attempts.set(urlPath, (attempts.get(urlPath) || 0) + 1);
  active++;
  if (active > maxActive) { maxActive = active; }
  res.on('finish', () => { active--; });

  req.resume();
  req.on('end', () => {
    const reply = (status, payload, delay) => {
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(envelope(payload));
      }, delay || 0);
    };

    if (urlPath === '/read') {
      if (readFailuresLeft > 0) {
        readFailuresLeft--;
        reply(502, { ok: false, error: readError, hint: '假桥接制造的失败' });
        return;
      }
      const seq = readSeq++;
      setTimeout(() => {
        completionOrder.push(seq);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(envelope({ ok: true, data: { seq, text: 'ok' } }));
      }, readDelayMs);
      return;
    }

    if (urlPath === '/click' || urlPath === '/eval') {
      reply(502, { ok: false, error: 'timeout', hint: '假桥接制造的失败' });
      return;
    }

    reply(200, { ok: true });
  });
});

/** 每个场景开始前重置统计。 */
function reset() {
  active = 0;
  maxActive = 0;
  attempts.clear();
  readFailuresLeft = 0;
  readError = 'timeout';
  completionOrder.length = 0;
  readSeq = 0;
}

(async () => {
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  const base = { port: PORT, timeoutMs: 5000 };

  try {
    /* ---------- 1. 并发闸门 ---------- */
    reset();
    const limited = createClient({ ...base, concurrency: 2 });
    const results = await Promise.all(Array.from({ length: 6 }, () => limited.read({ match: 'x' })));
    check('六个请求全部成功', results.length === 6 && results.every((r) => r.ok !== false), results.length);
    check('同时只有一个上限内的请求在飞', maxActive === 2, `峰值 ${maxActive}`);

    /* ---------- 2. 不设上限时确实并发 ---------- */
    reset();
    const open = createClient({ ...base });
    await Promise.all(Array.from({ length: 6 }, () => open.read({ match: 'x' })));
    check('不设并发上限时请求会重叠', maxActive >= 4, `峰值 ${maxActive}`);

    /* ---------- 3. 闸门是先进先出的 ---------- */
    reset();
    const fifo = createClient({ ...base, concurrency: 1 });
    await Promise.all(Array.from({ length: 4 }, () => fifo.read({ match: 'x' })));
    check('排队顺序与提交顺序一致',
      JSON.stringify(completionOrder) === JSON.stringify([0, 1, 2, 3]), JSON.stringify(completionOrder));

    /* ---------- 4. 读类动作会重试，前两次失败后成功 ---------- */
    reset();
    const retrying = createClient({ ...base, retries: 2, retryDelayMs: 10 });
    readFailuresLeft = 2;
    const ok = await retrying.read({ match: 'x' });
    check('两次失败后第三次成功', ok && ok.text === 'ok', JSON.stringify(ok));
    check('总共尝试三次', attempts.get('/read') === 3, `尝试 ${attempts.get('/read')} 次`);

    /* ---------- 5. 重试用尽后把错误抛出来 ---------- */
    reset();
    readFailuresLeft = 99;
    let caught = null;
    try {
      await createClient({ ...base, retries: 1, retryDelayMs: 10 }).read({ match: 'x' });
    } catch (e) { caught = e; }
    check('重试用尽后抛 BridgeError', caught && caught.code === 'timeout', caught && caught.code);
    check('只尝试了 retries + 1 次', attempts.get('/read') === 2, `尝试 ${attempts.get('/read')} 次`);

    /* ---------- 6. 写类动作永不自动重试 ---------- */
    reset();
    let clickErr = null;
    try {
      await createClient({ ...base, retries: 3, retryDelayMs: 10 }).click({ match: 'x', text: '删除' });
    } catch (e) { clickErr = e; }
    check('click 失败后不重试（第一次可能已经点下去了）',
      clickErr && clickErr.code === 'timeout' && attempts.get('/click') === 1,
      `尝试 ${attempts.get('/click')} 次`);

    /* ---------- 7. 业务性失败不重试 ---------- */
    reset();
    readError = 'permission_denied';
    readFailuresLeft = 99;
    let permErr = null;
    try {
      await createClient({ ...base, retries: 3, retryDelayMs: 10 }).read({ match: 'x' });
    } catch (e) { permErr = e; }
    check('未授权不是暂时性故障，不重试',
      permErr && permErr.code === 'permission_denied' && attempts.get('/read') === 1,
      `尝试 ${attempts.get('/read')} 次`);

    /* ---------- 8. 默认不开重试（向后兼容） ---------- */
    reset();
    readFailuresLeft = 1;
    let defErr = null;
    try {
      await createClient({ ...base }).read({ match: 'x' });
    } catch (e) { defErr = e; }
    check('不传 retries 时行为与以前一致：一次失败就直接报错',
      defErr && defErr.code === 'timeout' && attempts.get('/read') === 1,
      `尝试 ${attempts.get('/read')} 次`);
  } finally {
    server.close();
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
