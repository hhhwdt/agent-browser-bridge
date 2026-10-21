#!/usr/bin/env node
/**
 * WebSocket 任务通道测试：隔离端口上拉起 server.js，假扮扩展走新通道。
 *
 * 要挡的失败：
 *   - 握手算错（Sec-WebSocket-Accept）会让任何 WebSocket 库立刻断开
 *   - 推送失效：任务只进长轮询，WS 通道形同虚设
 *   - 鉴权失效：假扩展 ID / 错 token 也能注册通道，等于绕过了允许列表
 *   - 顶替语义：同一浏览器的第二个连接必须顶掉第一个，不能双通道双投递
 *
 *   node test-ws.js
 */

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { acceptKey, encodeText } = require('../src/server/ws.js');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const EXT_ID = 'nbopjoejgialcnmjcefaciebicahjhpp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`); }
}

function call(port, body, token) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {};
    if (token) { headers['X-ABB-Token'] = token; }
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: body && body.__path ? body.__path : '/close', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (e) => resolve({ status: 'ERR', body: String(e.code || e.message) }));
    if (payload) { req.write(payload); }
    req.end();
  });
}

/**
 * 极简 WS 客户端：握手 -> 收发帧。只支持客户端侧用得到的行为
 * （发送带掩码文本帧、接收不掩码帧、识别 close 码）。
 */
function wsConnect(port, helloData) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    let handshakeBuf = Buffer.alloc(0);
    const client = { frames: [], closed: null, closeCode: null, accept: null, onTask: null, ready: null, closedPromise: null };

    client.sendText = (str) => { socket.write(maskedFrame(0x1, Buffer.from(str, 'utf8'))); };
    client.sendRaw = (buf) => { socket.write(buf); };
    client.close = () => { try { socket.write(maskedFrame(0x8, Buffer.alloc(0))); socket.destroy(); } catch (e) { /* 已断开 */ } };

    socket.on('error', (e) => {
      if (!handshakeBuf.length && !client.frames.length) {
        client.error = String(e.code || e.message);
        resolve(client);
      }
    });

    socket.on('data', (chunk) => {
      // 握手应答还没读完时先找它的结尾
      if (client.accept === null) {
        handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
        const idx = handshakeBuf.indexOf('\r\n\r\n');
        if (idx < 0) { return; }
        const text = handshakeBuf.subarray(0, idx).toString('utf8');
        const m = text.match(/Sec-WebSocket-Accept:\s*(\S+)/i);
        client.accept = m ? m[1] : '(missing)';
        handshakeBuf = handshakeBuf.subarray(idx + 4);
        resolve(client);
        if (handshakeBuf.length) { feed(handshakeBuf); }
        handshakeBuf = Buffer.alloc(0);
        return;
      }
      feed(chunk);
    });

    function feed(buf) {
      // 只解析完整帧（内外消息都 <125 字节，无跨 chunk 分帧的复杂度）
      let messages = [];
      let offset = 0;
      for (;;) {
        if (buf.length - offset < 2) { break; }
        const opcode = buf[offset] & 0x0f;
        let len = buf[offset + 1] & 0x7f;
        offset += 2;
        if (len === 126) {
          if (buf.length - offset < 2) { break; }
          len = buf.readUInt16BE(offset);
          offset += 2;
        }
        if (buf.length - offset < len) { break; }
        messages.push({ opcode, payload: buf.subarray(offset, offset + len) });
        offset += len;
      }
      for (const f of messages) {
        if (f.opcode === 8) {
          client.closed = true;
          client.closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null;
          socket.destroy();
          if (client.closedPromise) { client.closedPromise(); }
          return;
        }
        if (f.opcode === 1) {
          try {
            const msg = JSON.parse(f.payload.toString('utf8'));
            if (msg.type === 'ready' && client.ready) { client.ready(msg); }
            if (msg.type === 'task' && client.onTask) { client.onTask(msg.task); }
          } catch (e) { /* 忽略坏帧 */ }
        }
      }
    }

    socket.once('connect', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\n'
        + 'Host: 127.0.0.1\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    if (helloData !== undefined) {
      client.readyWait = new Promise((r) => { client.ready = (msg) => { client.readyMsg = msg; r(msg); }; });
      // 握手应答到达后再发 hello：resolve 发生在第一个 data 事件里
      const origResolve = client.ready;
      setTimeout(() => { if (client.accept !== null) { client.sendText(JSON.stringify(helloData)); } }, 30);
    }
  });
}

/** 客户端 -> 服务端方向的帧必须掩码。 */
function maskedFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) { masked[i] ^= mask[i & 3]; }
  let header;
  if (payload.length < 126) { header = Buffer.from([0x80 | opcode, 0x80 | payload.length]); }
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    // result 上行会出现几 MB 的帧，需要 64 位长度
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** 与 maskedFrame 相同，但允许关掉 FIN 位：模拟浏览器把大消息拆成分片帧。 */
function maskedFragment(opcode, payload, fin) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) { masked[i] ^= mask[i & 3]; }
  const head = fin ? 0x80 : 0;
  let header;
  if (payload.length < 126) { header = Buffer.from([head | opcode, 0x80 | payload.length]); }
  else {
    header = Buffer.alloc(4);
    header[0] = head | opcode; header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** 解服务端发来的帧（不掩码）。用于 encodeText 的边界测试。 */
function decodeServerFrames(buf) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 2) { break; }
    const opcode = buf[offset] & 0x0f;
    let len = buf[offset + 1] & 0x7f;
    offset += 2;
    if (len === 126) { len = buf.readUInt16BE(offset); offset += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(offset)); offset += 8; }
    frames.push({ opcode, payload: Buffer.from(buf.subarray(offset, offset + len)).toString('utf8') });
    offset += len;
  }
  return frames;
}

(async () => {

  console.log('\n[1] 握手应答与文本帧编码');
  {
    // RFC 6455 §1.3 的样例值
    check('acceptKey 与 RFC 样例一致', acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      acceptKey('dGhlIHNhbXBsZSBub25jZQ=='));

    for (const size of [50, 300, 70000]) {
      const payload = 'x'.repeat(size);
      const frames = decodeServerFrames(encodeText(JSON.stringify({ n: size, p: payload })));
      let ok = frames.length === 1 && frames[0].opcode === 1;
      try {
        const parsed = JSON.parse(frames[0].payload);
        ok = ok && parsed.n === size && parsed.p.length === size;
      } catch (e) { ok = false; }
      check(`encodeText 编码 ${size} 字节的帧可解析`, ok);
    }
  }

  console.log('\n[2] WS 通道：无需轮询即可收到推送任务');
  {
    const PORT = 18993;
    const srv = spawn(process.execPath, [SERVER, '--port', String(PORT), '--no-token'], { stdio: 'ignore' });
    await sleep(900);
    try {
      const hello = { type: 'hello', token: 'x', extensionId: EXT_ID, browser: 'edge', version: '1.9.0' };
      const ws = await wsConnect(PORT, hello);
      const ready = await Promise.race([ws.readyWait, sleep(3000).then(() => null)]);
      check('鉴权通过并收到 ready', ready && ready.type === 'ready');

      const dispatch = call(PORT, { tabId: 778899, browser: 'edge', timeoutMs: 5000, __path: '/close' });
      const push = await Promise.race([
        new Promise((r) => { ws.onTask = (t) => r(t); }),
        sleep(3000).then(() => null)
      ]);
      check('任务无需轮询在 WS 上直接下达',
        push && push.id && push.browser === 'edge' && push.tabId === 778899, JSON.stringify(push));

      // 结果仍走 HTTP 回传
      const result = call(PORT, { __path: '/result?browser=edge', id: push.id, result: { ok: true, data: { tabId: 778899 } } });
      const caller = await dispatch;
      check('调用方收到 ok 结果', caller.status === 200 && caller.body.includes('"ok":true'), caller.body);
      await result;
      ws.close();
    } finally {
      srv.kill();
      await sleep(300);
    }
  }

  console.log('\n[3] 假扩展 ID / 错误 token 的通道被拒');
  {
    const PORT = 18992;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-ws-token-'));
    const tokenFile = path.join(tmpDir, 'token');
    fs.writeFileSync(tokenFile, 'correct-token-32-bytes-aaaaaaaaaaaa', { mode: 0o600 });
    const srv = spawn(process.execPath, [SERVER, '--port', String(PORT), '--token-file', tokenFile], { stdio: 'ignore' });
    await sleep(900);
    try {
      const badId = await wsConnect(PORT, { type: 'hello', token: 'correct-token-32-bytes-aaaaaaaaaaaa', extensionId: 'not-an-allowed-id', browser: 'chrome', version: '1.9.0' });
      const done1 = new Promise((r) => { badId.closedPromise = r; });
      const badHandshakeResolve = await Promise.race([badId, sleep(2000).then(() => null)]);
      check('握手应答带 Accept 头', badHandshakeResolve
        && typeof badHandshakeResolve.accept === 'string' && badHandshakeResolve.accept.length >= 27,
        badHandshakeResolve && badHandshakeResolve.accept);
      await Promise.race([done1, sleep(2500)]);
      check('假扩展 ID 以 4403 关闭', badId.closeCode === 4403, String(badId.closeCode));

      const good = await wsConnect(PORT, { type: 'hello', token: 'correct-token-32-bytes-aaaaaaaaaaaa', extensionId: EXT_ID, browser: 'chrome', version: '1.9.0' });
      const ready = await Promise.race([good.readyWait, sleep(3000).then(() => null)]);
      check('正确 token 与 ID 收到 ready', ready && ready.type === 'ready');

      const wrong = await wsConnect(PORT, { type: 'hello', token: 'wrong-token', extensionId: EXT_ID, browser: 'chrome', version: '1.9.0' });
      const done2 = new Promise((r) => { wrong.closedPromise = r; });
      await Promise.race([wrong, sleep(2000).then(() => null)]);
      await Promise.race([done2, sleep(2500)]);
      check('错 token 以 4401 关闭', wrong.closeCode === 4401, String(wrong.closeCode));
      good.close();
    } finally {
      srv.kill();
      await sleep(300);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ }
    }
  }

  console.log('\n[4] 同浏览器的第二个通道顶掉第一个');
  {
    const PORT = 18991;
    const srv = spawn(process.execPath, [SERVER, '--port', String(PORT), '--no-token'], { stdio: 'ignore' });
    await sleep(900);
    try {
      const hello = { type: 'hello', token: 'x', extensionId: EXT_ID, browser: 'chrome', version: 'x' };
      const first = (await wsConnect(PORT, hello));
      await Promise.race([first.readyWait, sleep(2000).then(() => null)]);
      const firstClosed = new Promise((r) => { first.closedPromise = r; });

      const second = (await wsConnect(PORT, hello));
      await Promise.race([second.readyWait, sleep(2000).then(() => null)]);

      // 给服务端一点时间处理顶替，再投任务：只能到第二个通道
      await sleep(200);
      call(PORT, { tabId: 555, browser: 'chrome', timeoutMs: 4000, __path: '/close' });
      const gotOnSecond = await Promise.race([
        new Promise((r) => { second.onTask = () => r(true); }),
        sleep(2000).then(() => false)
      ]);
      const state = await Promise.race([firstClosed.then(() => 'closed'), sleep(1500).then(() => 'open')]);
      check('新通道收到任务', gotOnSecond === true, String(gotOnSecond));
      check('旧通道被顶替关闭', state === 'closed', state);
      // 顶替用专用 close 码 4420：扩展端据此知道"别重连，新实例已接管"。
      // 若发 1000，旧实例的重连定时器会反过来追杀新通道，形成追逐死循环。
      check('顶替的 close 码是 4420', first && first.closeCode === 4420, String(first && first.closeCode));
      second.close();
    } finally {
      srv.kill();
      await sleep(300);
    }
  }

  console.log('\n[5] 结果经 WS 上行结算任务');
  {
    const PORT = 18990;
    const srv = spawn(process.execPath, [SERVER, '--port', String(PORT), '--no-token'], { stdio: 'ignore' });
    await sleep(900);
    try {
      const hello = { type: 'hello', token: 'x', extensionId: EXT_ID, browser: 'edge', version: 'x' };
      const ws = await wsConnect(PORT, hello);
      await Promise.race([ws.readyWait, sleep(3000).then(() => null)]);

      // 正常路径：任务从 WS 下来，结果也从 WS 回去
      const dispatch = call(PORT, { tabId: 778899, browser: 'edge', timeoutMs: 5000, __path: '/close' });
      const push = await Promise.race([
        new Promise((r) => { ws.onTask = (t) => r(t); }),
        sleep(3000).then(() => null)
      ]);
      check('WS 通道上下发闭环的任务已投递', push && push.id, JSON.stringify(push));
      ws.sendText(JSON.stringify({ type: 'result', id: push.id, result: { ok: true, data: { tabId: 778899 } } }));
      const caller = await dispatch;
      check('结果帧在服务端结算，调用方收到 ok',
        caller.status === 200 && caller.body.includes('"ok":true'), caller.body.slice(0, 200));

      // 杂音 result（id 已超时/不存在）不能弄断通道
      ws.sendText(JSON.stringify({ type: 'result', id: 999999, result: { ok: true } }));
      await sleep(400);
      const dispatch2 = call(PORT, { tabId: 778900, browser: 'edge', timeoutMs: 5000, __path: '/close' });
      const push2 = await Promise.race([
        new Promise((r) => { ws.onTask = (t) => r(t); }),
        sleep(3000).then(() => null)
      ]);
      check('杂音 result 帧之后通道仍可投递任务', push2 && push2.tabId === 778900, JSON.stringify(push2));
      if (push2) {
        ws.sendText(JSON.stringify({ type: 'result', id: push2.id, result: { ok: true, data: {} } }));
        const caller2 = await dispatch2;
        check('第二个任务同样经 WS 回传成功', caller2.status === 200, caller2.body.slice(0, 200));
      }

      // 大结果：几 MB 的单帧（download base64 场景）必须能原样回传
      const big = 'a'.repeat(2 * 1024 * 1024);
      const dispatch3 = call(PORT, { tabId: 778901, browser: 'edge', timeoutMs: 8000, __path: '/close' });
      const push3 = await Promise.race([
        new Promise((r) => { ws.onTask = (t) => r(t); }),
        sleep(3000).then(() => null)
      ]);
      ws.sendText(JSON.stringify({ type: 'result', id: push3.id, result: { ok: true, data: { blob: big } } }));
      const caller3 = await dispatch3;
      check('2MB 的结果帧完整回传',
        caller3.status === 200 && caller3.body.length > big.length, `body=${caller3.body.length}`);
      // 分片消息收完后再发下一批：浏览器会把大结果拆成分片帧（首帧 opcode=1
      // 无 FIN、续帧 opcode=0 带 FIN）。续帧完整派发后必须在缓冲区里消费掉，
      // 否则下一批数据到达时重放续帧会撞上已复位的 fragments 立即 close(1002)，
      // 把同批甚至后面的结果一起吞掉（test-mcp 截图后坏读必超时的根因）。
      const fragJson = JSON.stringify({ type: 'result', id: 777777, result: { ok: true, data: { frag: 'x'.repeat(30000) } } });
      const mid = Math.floor(fragJson.length / 2);
      ws.sendRaw(maskedFragment(0x1, Buffer.from(fragJson.slice(0, mid), 'utf8'), false));
      ws.sendRaw(maskedFragment(0x0, Buffer.from(fragJson.slice(mid), 'utf8'), true));
      const dispatch4 = call(PORT, { tabId: 778902, browser: 'edge', timeoutMs: 8000, __path: '/close' });
      const push4 = await Promise.race([
        new Promise((r) => { ws.onTask = (t) => r(t); }),
        sleep(3000).then(() => null)
      ]);
      // 下一批数据：另一条杂音结果。旧逻辑在这一步会因重放续帧而断开
      ws.sendText(JSON.stringify({ type: 'result', id: 888888, result: { ok: true } }));
      await sleep(600);
      const dispatch5 = call(PORT, { tabId: 778903, browser: 'edge', timeoutMs: 8000, __path: '/close' });
      const push5 = await Promise.race([
        new Promise((r) => { ws.onTask = (t) => r(t); }),
        sleep(3000).then(() => null)
      ]);
      check('分片消息收完后通道不被重放续帧弄断', push4 && push5 && push5.tabId === 778903,
        `push4=${push4 && push4.tabId} push5=${push5 && push5.tabId}`);
      if (push5) {
        ws.sendText(JSON.stringify({ type: 'result', id: push5.id, result: { ok: true, data: {} } }));
        const caller5 = await dispatch5;
        check('分片消息之后的任务仍可正常回传', caller5.status === 200, caller5.body.slice(0, 200));
      }
      ws.close();
    } finally {
      srv.kill();
      await sleep(300);
    }
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
