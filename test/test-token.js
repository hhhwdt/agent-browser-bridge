#!/usr/bin/env node
/**
 * 共享 token 测试：隔离端口起 server.js（带 token），验证校验逻辑。
 *
 * 防的失败：token 校验被绕过或误拒。
 *   - 绕过：没有 token 的请求能驱动桥接（等于没加 token）
 *   - 误拒：带正确 token 的请求被拒绝（用户配了 token 却用不了）
 *
 *   node test-token.js
 */

'use strict';

const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = 18996;
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

function call(method, httpPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) { headers['X-ABB-Token'] = token; }
    const req = http.request({ hostname: HOST, port: PORT, path: httpPath, method, headers }, (res) => {
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-token-'));
  const tokenFile = path.join(tmpDir, 'token');

  const server = spawn(process.execPath, [SERVER, '--port', String(PORT), '--token-file', tokenFile], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // 等服务启动并生成 token
  await sleep(1500);

  try {
    // 读生成的 token
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    check('token 文件已生成', token.length === 64, `长度=${token.length}`);

    /* ---------- 1. /health 不需要 token ---------- */
    const h = await call('GET', '/health');
    check('/health 不需要 token', h.status === 200, `status=${h.status}`);

    /* ---------- 2. 没有 token 的请求被拒绝 ---------- */
    const noToken = await call('POST', '/read', { match: 'example.com' });
    check('没有 token 时返回 401', noToken.status === 401, `status=${noToken.status}`);
    check('401 错误码是 token_required', noToken.body.error === 'token_required', `error=${noToken.body.error}`);

    /* ---------- 3. 错误 token 被拒绝 ---------- */
    const wrongToken = await call('POST', '/read', { match: 'example.com' }, 'wrong-token');
    check('错误 token 返回 401', wrongToken.status === 401, `status=${wrongToken.status}`);

    /* ---------- 4. 正确 token 通过 ---------- */
    const good = await call('POST', '/read', { match: 'example.com' }, token);
    check('正确 token 通过', good.status !== 401, `status=${good.status}`);

    /* ---------- 5. token 文件权限 ---------- */
    const stat = fs.statSync(tokenFile);
    // Windows 上 mode 不可靠，只检查文件存在且可读
    check('token 文件可读', stat.isFile());

    /* ---------- 6. --no-token 模式 ---------- */
    // 已经在 test-server.js 里覆盖，这里不重复

  } finally {
    server.kill();
    await sleep(200);
    try { fs.unlinkSync(tokenFile); } catch (e) { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch (e) { /* ignore */ }
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
