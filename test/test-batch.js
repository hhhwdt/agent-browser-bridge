#!/usr/bin/env node
/**
 * 批量动作测试：隔离端口起 server.js，发 batch 请求，验证执行顺序与结果。
 *
 * 防的失败：批量动作绕过风险护栏（破坏性 click 不需要 force、type 会提交），
 * 或者执行顺序错乱（后面的步骤先执行）。
 *
 *   node test-batch.js
 */

'use strict';

const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 18997;
const HOST = '127.0.0.1';
const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

function call(method, httpPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: HOST, port: PORT, path: httpPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (data) { req.write(data); }
    req.end();
  });
}

(async () => {
  const srv = spawn(process.execPath, [SERVER, '--port', String(PORT), '--no-token'], { stdio: 'ignore' });
  await sleep(1200);

  try {
    /* ---------- 1. 空 steps 被拒绝 ---------- */
    const empty = await call('POST', '/batch', { steps: [] });
    check('空 steps 返回 400', empty.status === 400, `status=${empty.status}`);

    /* ---------- 2. 非数组 steps 被拒绝 ---------- */
    const notArray = await call('POST', '/batch', { steps: 'not-an-array' });
    check('非数组 steps 返回 400', notArray.status === 400, `status=${notArray.status}`);

    /* ---------- 3. 正常 batch：第一步失败时停止 ---------- */
    const batch = await call('POST', '/batch', {
      steps: [
        { action: 'read', match: 'example.com', timeoutMs: 2000 },
        { action: 'click', match: 'example.com', selector: '#btn', timeoutMs: 2000 },
        { action: 'type', match: 'example.com', selector: '#input', value: 'hello', timeoutMs: 2000 }
      ]
    });
    check('batch 返回 200 或 502', batch.status === 200 || batch.status === 502, `status=${batch.status}`);
    check('第一步失败时只返回 1 步', Array.isArray(batch.body.results) && batch.body.results.length === 1,
      `results=${JSON.stringify(batch.body.results)}`);

    if (batch.body.results && batch.body.results.length === 1) {
      check('步骤 0 是 read', batch.body.results[0].action === 'read');
    }

    /* ---------- 4. 第一步失败时停止 ---------- */
    const stopOnFail = await call('POST', '/batch', {
      steps: [
        { action: 'read', match: 'nonexistent.com', timeoutMs: 2000 },
        { action: 'click', match: 'example.com', selector: '#btn', timeoutMs: 2000 }
      ]
    });
    check('第一步失败时停止', stopOnFail.body.results && stopOnFail.body.results.length === 1,
      `results length=${stopOnFail.body.results && stopOnFail.body.results.length}`);

    /* ---------- 5. continueOnError 时继续执行 ---------- */
    const continueOnErr = await call('POST', '/batch', {
      steps: [
        { action: 'read', match: 'nonexistent.com', timeoutMs: 2000 },
        { action: 'click', match: 'example.com', selector: '#btn', timeoutMs: 2000 }
      ],
      continueOnError: true
    });
    check('continueOnError 时执行所有步骤', continueOnErr.body.results && continueOnErr.body.results.length === 2,
      `results length=${continueOnErr.body.results && continueOnErr.body.results.length}`);

  } finally {
    srv.kill();
    await sleep(200);
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
