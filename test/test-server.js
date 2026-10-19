#!/usr/bin/env node
/**
 * 桥接服务的行为测试。自己在一个隔离端口上拉起 server.js，再假扮成扩展跟它对话。
 *
 * 覆盖的是那些"错了不会报错，只会静默做错事"的服务端语义：
 *   - 调用方已放弃（超时）的任务，不能在扩展重连后被重新下发执行
 *   - 回传结果的一方必须就是任务的目标浏览器，否则同机另一个浏览器能冒名结算
 *   - 大结果体（download 的 base64、整页截图）不能被体积上限掐断连接
 *   - 来源校验：带非本机 Origin 的请求一律拒绝；并记录下"不带 Origin 就放行"这个已知缺口
 *
 * 全程不碰 18777 上正在跑的那个实例，也不需要浏览器。
 *
 *   node test-server.js
 */

'use strict';

const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const PORT = 18999;
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
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {};
    const r = http.request({ host: HOST, port: PORT, method, path: httpPath, headers: h, agent: false }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    r.on('error', (e) => resolve({ status: 'ERR', body: String(e.code || e.message) }));
    if (payload) { r.write(payload); }
    r.end();
  });
}

/** 清单公钥推导出的扩展 ID，用于构造"来自本扩展"的来源。 */
const EXT_ID = (() => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  const hex = createHash('sha256').update(Buffer.from(m.key, 'base64')).digest('hex').slice(0, 32);
  return hex.split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
})();

/**
 * 打开一个长轮询。holdMs 后断开，模拟扩展掉线/重连。
 * withOrigin=false 模拟真实扩展——它对 127.0.0.1 有 host_permissions，
 * 请求不算 CORS，因此浏览器不发 Origin 头。
 */
function poll(holdMs, withOrigin) {
  return new Promise((resolve) => {
    const headers = withOrigin === false ? {} : { Origin: 'chrome-extension://' + EXT_ID };
    const r = http.request({ host: HOST, port: PORT, method: 'GET', path: '/poll?browser=edge', agent: false, headers }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    r.on('error', (e) => resolve({ status: 'ERR', body: String(e.code || e.message) }));
    r.end();
    setTimeout(() => { try { r.destroy(); } catch (e) { /* 已断开 */ } }, holdMs);
  });
}

function withOrigin(origin, method, httpPath) {
  return new Promise((resolve) => {
    const r = http.request({
      host: HOST, port: PORT, method, path: httpPath, agent: false, headers: { Origin: origin }
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    r.on('error', (e) => resolve({ status: 'ERR', body: String(e.code || e.message) }));
    r.end();
  });
}

(async () => {
  const srv = spawn(process.execPath, [SERVER, '--port', String(PORT), '--no-token'], { stdio: 'ignore' });
  await sleep(900);

  try {
    console.log('\n[1] 超时的任务不再残留在队列');
    await poll(300);                                   // 先注册一次，让服务端记住 edge 在线
    await sleep(150);
    const dispatched = call('POST', '/close', { tabId: 424242, browser: 'edge', timeoutMs: 1200 });
    await sleep(1700);                                 // 任务在队列里过期
    const r1 = await dispatched;
    check('调用方拿到 timeout', r1.body.includes('"error":"timeout"'), r1.body);
    const p2 = await poll(1500);
    check('重连后不再收到这条过期任务',
      !(p2.status === 200 && p2.body.includes('424242')),
      `status=${p2.status} body=${p2.body.slice(0, 120)}`);

    console.log('\n[2] 正常任务的派发与回传仍然可用');
    const p3 = poll(6000);
    await sleep(300);
    const d2 = call('GET', '/tabs?browser=edge');
    const got = await p3;
    check('任务已下发到扩展', got.status === 200, `status=${got.status} body=${got.body.slice(0, 80)}`);
    let task = {};
    try { task = JSON.parse(got.body); } catch (e) { /* 下面断言会报 */ }
    check('任务带 id 与 browser', typeof task.id === 'number' && task.browser === 'edge', got.body);
    const post = await call('POST', '/result?browser=edge', { id: task.id, result: { ok: true, data: { tabs: [] } } });
    check('正确浏览器回传被接受', post.status === 200 && post.body.includes('"accepted":true'), post.body);
    const r2 = await d2;
    check('调用方拿到结果', r2.status === 200 && r2.body.includes('"ok":true') && r2.body.includes('"tabs"'),
      r2.body.slice(0, 120));

    console.log('\n[3] 结果体不再被 1MB 卡住');
    const big = await call('POST', '/result?browser=edge', { id: 123456, result: { ok: true, data: { base64: 'A'.repeat(2 * 1024 * 1024) } } });
    check('2MB 结果体被接收', big.status === 200, `status=${big.status} body=${big.body.slice(0, 80)}`);
    const big20 = await call('POST', '/result?browser=edge', { id: 123457, result: { ok: true, data: { base64: 'A'.repeat(20 * 1024 * 1024) } } });
    check('20MB 结果体被接收', big20.status === 200, `status=${big20.status} body=${big20.body.slice(0, 80)}`);

    console.log('\n[4] 回传方与任务目标浏览器不一致时被拒绝');
    const p4 = poll(4000);
    await sleep(300);
    const d3 = call('POST', '/close', { tabId: 777, browser: 'edge', timeoutMs: 1500 });
    const got3 = await p4;
    let task3 = {};
    try { task3 = JSON.parse(got3.body); } catch (e) { /* 下面断言会报 */ }
    const wrong = await call('POST', '/result?browser=chrome', { id: task3.id, result: { ok: true, data: { spoofed: true } } });
    check('错误浏览器回传返回 409', wrong.status === 409, `status=${wrong.status} ${wrong.body}`);
    const r3 = await d3;
    check('任务未被冒名结算，仍按超时收场', r3.body.includes('"error":"timeout"'), r3.body.slice(0, 120));

    console.log('\n[5] 来源校验');
    // 这里用 /health（不派发任务）而不是 /tabs：此刻没有扩展在轮询，
    // 派发类接口会一直等到超时才回，白等 30 秒。
    // "不带 Origin 的派发请求确实能到达扩展"这一条由 [2] 覆盖（那里有假扩展接住）。
    const none = await call('GET', '/health');
    check('不带 Origin 的本机请求放行（本机脚本与扩展都走这条路）', none.status === 200, `status=${none.status}`);
    const evil = await withOrigin('https://evil.example', 'GET', '/health');
    check('普通网站来源被 403', evil.status === 403, `status=${evil.status}`);
    const otherExt = await withOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GET', '/health');
    check('不在允许列表的扩展来源被 403', otherExt.status === 403, `status=${otherExt.status}`);

    console.log('\n[6] 记录在案的缺口，不是回归');
    // 不带 Origin 的 /poll 会被接受：网页里一个 <img src=".../poll?browser=edge">
    // 就能冒充在线浏览器、占住任务投递槽（读不到任务内容，但会把任务吞掉）。
    // 堵它需要共享密钥，见 SECURITY.md。
    const bare = await poll(800, false);
    check('不带 Origin 的 /poll 仍被接受（已知缺口）', bare.status !== 403, `status=${bare.status}`);
    const held = poll(1200, false);
    await sleep(400);
    const h2 = JSON.parse((await call('GET', '/health')).body || '{}');
    check('真扩展（不带 Origin）会被记为在线', (h2.browsers || []).includes('edge'), JSON.stringify(h2.browsers));
    await held;
  } finally {
    srv.kill();
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
