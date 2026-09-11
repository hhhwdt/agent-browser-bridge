#!/usr/bin/env node
/**
 * 扩展来源允许列表的测试。隔离端口起 server.js，只发请求，不需要浏览器。
 *
 * 要验的是"谁能驱动桥接"这条线到底画在哪：
 *   - 允许列表内的扩展、本机 http 来源、不带 Origin 的本机请求：放行
 *   - 其他扩展、Firefox 的 moz-extension、普通网站：403
 *
 * 也顺手把"清单公钥推导出的 ID == 服务端常量"钉住：换 key 时忘记同步，
 * 运行期不会有任何可见症状，只有这个断言会报。
 *
 *   node test-allowlist.js
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const REPO = path.join(__dirname, '..');
const PORT = 18994;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`); }
}

/** Chrome 的扩展 ID 算法：sha256(DER/SPKI 公钥) 取前 16 字节，每个 nibble 映射到 a-p。 */
function extensionIdFromBase64Key(b64) {
  const der = Buffer.from(b64, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return hex.split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function get(httpPath, origin) {
  return new Promise((resolve) => {
    const headers = origin ? { Origin: origin } : {};
    const r = http.request({ host: HOST, port: PORT, method: 'GET', path: httpPath, headers, agent: false }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    r.on('error', (e) => resolve({ status: 'ERR', body: String(e.code || e.message) }));
    r.end();
  });
}

function startServer(extraArgs) {
  return spawn(process.execPath, [path.join(REPO, 'src', 'server.js'), '--port', String(PORT)].concat(extraArgs || []), { stdio: 'ignore' });
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'extension', 'manifest.json'), 'utf8'));
  const serverSrc = fs.readFileSync(path.join(REPO, 'src', 'server.js'), 'utf8');

  console.log('\n[1] 清单公钥推导的 ID 与服务端常量一致');
  check('清单里有 key', typeof manifest.key === 'string' && manifest.key.length > 100);
  const derived = extensionIdFromBase64Key(manifest.key);
  const declared = (/const DEFAULT_EXTENSION_ID = '([^']+)'/.exec(serverSrc) || [])[1];
  check('推导结果形如 32 位 a-p', /^[a-p]{32}$/.test(derived), derived);
  check('服务端常量与清单一致（换 key 时最容易忘记同步这里）', declared === derived,
    `服务端=${declared} 清单=${derived}`);

  console.log('\n[2] 默认只放行这个扩展');
  let srv = startServer();
  await sleep(900);
  try {
    const right = await get('/health', 'chrome-extension://' + derived);
    check('允许列表内的扩展来源被放行', right.status === 200, `status=${right.status}`);
    const health = JSON.parse(right.body || '{}');
    check('/health 报出允许列表',
      Array.isArray(health.allowedExtensionIds) && health.allowedExtensionIds.includes(derived),
      JSON.stringify(health.allowedExtensionIds));

    const other = await get('/health', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    check('其他扩展来源被 403', other.status === 403, `status=${other.status} ${other.body.slice(0, 80)}`);
    check('403 里给出可照做的提示（含 --allow-extension）',
      other.body.includes('--allow-extension'), other.body.slice(0, 120));

    const moz = await get('/health', 'moz-extension://11111111-2222-3333-4444-555555555555');
    check('Firefox 来源默认被拒（ID 方案不同，需要显式追加）', moz.status === 403, `status=${moz.status}`);

    const noOrigin = await get('/health');
    check('不带 Origin 的本机请求放行', noOrigin.status === 200, `status=${noOrigin.status}`);

    const local = await get('/health', 'http://127.0.0.1:1234');
    check('本机 http 来源放行', local.status === 200, `status=${local.status}`);

    const evil = await get('/health', 'https://evil.example');
    check('普通网站来源被 403', evil.status === 403, `status=${evil.status}`);
  } finally { srv.kill(); }
  await sleep(300);

  console.log('\n[3] --allow-extension 可以追加 ID');
  const extraId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  srv = startServer(['--allow-extension', extraId]);
  await sleep(900);
  try {
    check('追加的 ID 被放行', (await get('/health', 'chrome-extension://' + extraId)).status === 200);
    check('默认 ID 仍然有效', (await get('/health', 'chrome-extension://' + derived)).status === 200);
    check('未追加的 ID 仍被拒',
      (await get('/health', 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).status === 403);
    const health = JSON.parse((await get('/health')).body || '{}');
    check('允许列表同时含两个 ID', (health.allowedExtensionIds || []).length === 2,
      JSON.stringify(health.allowedExtensionIds));
  } finally { srv.kill(); }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
