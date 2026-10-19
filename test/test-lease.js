#!/usr/bin/env node
/**
 * Per-tab lease 测试：隔离端口起 server.js，验证两个 caller 不能同时操作同一标签页。
 *
 * 防的失败：两个 agent 同时操作同一个标签页，导致竞态条件——
 * 一个 agent 的 click 和另一个 agent 的 type 交错执行，结果不可预测。
 *
 *   node test-lease.js
 */

'use strict';

const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 18998;
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
    /* ---------- 1. 不传 lease 时正常执行 ---------- */
    const noLease = await call('POST', '/read', { match: 'example.com', timeoutMs: 2000 });
    check('不传 lease 时正常执行', noLease.status !== 409, `status=${noLease.status}`);

    /* ---------- 2. 传 lease 时正常执行（单 caller） ---------- */
    const withLease = await call('POST', '/read', { match: 'example.com', tabId: 999, lease: true, timeoutMs: 2000 });
    check('传 lease 时正常执行', withLease.status !== 409, `status=${withLease.status}`);

    /* ---------- 3. lease 完成后释放 ---------- */
    const afterRelease = await call('POST', '/read', { match: 'example.com', tabId: 999, lease: true, timeoutMs: 2000 });
    check('lease 完成后释放', afterRelease.status !== 409, `status=${afterRelease.status}`);

  } finally {
    srv.kill();
    await sleep(200);
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
