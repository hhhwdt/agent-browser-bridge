/**
 * Agent Browser Bridge —— WebSocket 任务通道（RFC 6455 最小实现，零依赖）。
 *
 * 为什么自己写：桥接的硬约束是"只用 Node 原生模块"（见 ROADMAP "Any dependency"），
 * Node 标准库没有 WebSocket 服务端，所以这里实现握手、帧编解码、ping/pong、close。
 * 协议只覆盖"扩展 <-> 服务端"这一种点对点场景，不支持广播与子协议协商。
 *
 * 通道语义：
 *   - 连接只负责"任务下达"。鉴权放在首条 hello 消息（token + 扩展 ID），不放在升级
 *     请求头里——浏览器 WebSocket API 不允许自定义请求头。
 *   - 鉴权成功回 {type:"ready"}，之后任务以 {type:"task", task} 逐条推下。
 *   - 鉴权后的文本帧收 {type:"result", id, result}：任务结果经这条通道回传，
 *     与 HTTP POST /result 共用同一结算路径（queue.recordResult）。channel
 *     不在（断开瞬间、或还在轮询模式）时扩展回落 HTTP /result，两条路并存。
 *   - 每 20 秒两条心跳：控制帧 ping（死连接检测）与 {"type":"ka"} 文本帧。
 *     MV3 service worker 的 idle 重置只认进入 JS 事件循环的 WebSocket 往来，
 *     自动 pong 不算活动，因此保活必须用数据帧。间隔短于浏览器的 30 秒 idle 下限，
 *     桥接在线时扩展的服务脚本不会被回收。
 *
 * 已知取舍：消息分片做了支持（RFC 允许浏览器随意分片）；控制帧本身只看 opcode。
 */

'use strict';

const crypto = require('node:crypto');
const { TOKEN } = require('./token.js');
const { NO_TOKEN, allowedExtensionIds } = require('./config.js');
const { normalizeBrowser, registerWsChannel, unregisterWsChannel, recordResult } = require('./queue.js');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024;       // 未鉴权阶段的帧（只装身份 hello），1MB 防御上限
// 鉴权后允许 result 上行：HTTP /result 的 JSON 体上限是 32MB，这里放宽到
// 34MB 给 {id, result} 包裹留余量。分片后的消息总量不再封顶——能过鉴权的
// 本机扩展是可信端，装不下超大结果时 HTTP 兜底也过不去同样的大小。
const MAX_RESULT_PAYLOAD = 34 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10000;        // 握手成功后多久还没发身份就断开
const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 50000;         // 连续两个 ping 没回 pong 就断开

/** RFC 6455 §1.3 的握手应答。单独导出是为了用该节的样例值做单元测试。 */
function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

/** 编码一个不掩码的文本帧（服务端 -> 客户端方向按协议必须不掩码）。 */
function encodeText(str) {
  const payload = Buffer.from(String(str), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 编码一个控制帧（close/ping/pong，载荷 ≤ 125 字节）。 */
function encodeControl(opcode, payload) {
  const head = Buffer.from([0x80 | opcode, payload.length]);
  return Buffer.concat([head, Buffer.from(payload || Buffer.alloc(0))]);
}

function attach(server) {
  server.on('upgrade', handleUpgrade);
}

function destroyQuietly(socket) {
  try { socket.destroy(); } catch (e) { /* 已断开 */ }
}

function handleUpgrade(req, socket) {
  const wantsWs = req.method === 'GET'
    && typeof req.url === 'string' && req.url.startsWith('/ws')
    && /websocket/i.test(String(req.headers.upgrade || ''))
    && typeof req.headers['sec-websocket-key'] === 'string';
  if (!wantsWs) {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch (e) { /* 已断开 */ }
    return;
  }

  const accept = acceptKey(req.headers['sec-websocket-key']);
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', ''
  ];
  socket.write(lines.join('\r\n'));

  const session = {
    buffer: Buffer.alloc(0),
    fragments: null,        // 分片中的消息：{ parts: [Buffer] }
    lastPong: Date.now(),
    pingTimer: null,
    helloTimer: null,
    closed: false,
    browser: null
  };

  const sendObj = (obj) => {
    if (session.closed) { return false; }
    try { socket.write(encodeText(JSON.stringify(obj))); } catch (e) { close(1011); return false; }
    return true;
  };

  const channel = {
    sendTask: (task) => sendObj({ type: 'task', task }),
    // 同一浏览器的新通道顶替时由 registerWsChannel 调用
    // close 支持透传自定义 close 码（顶替用 4420；缺省为正常 1000）
    close: (c) => close(c === undefined ? 1000 : c)
  };

  function close(code) {
    if (session.closed) { return; }
    session.closed = true;
    try {
      socket.write(encodeControl(0x8, Buffer.from([(code >> 8) & 0xff, code & 0xff])));
    } catch (e) { /* 已断开 */ }
    clearTimeout(session.helloTimer);
    clearInterval(session.pingTimer);
    clearInterval(session.kaTimer);
    // 给 close 回执留一点时间；对端可能根本不再回包
    setTimeout(() => destroyQuietly(socket), 500);
    if (session.browser) {
      unregisterWsChannel(session.browser, channel);
      console.log(`[ws] ${session.browser} 已断开（code=${code}）`);
    }
  }

  function handleHello(data) {
    const idOk = data && data.type === 'hello'
      && typeof data.extensionId === 'string'
      && allowedExtensionIds.has(String(data.extensionId).toLowerCase())
      && typeof data.browser === 'string'
      && normalizeBrowser(data.browser) !== 'unknown';
    // token 校验：--no-token 时允许任何值，与 HTTP 路由的策略一致
    const tokenOk = NO_TOKEN
      || (data && typeof data.token === 'string' && data.token === TOKEN);

    if (!idOk) {
      sendObj({ type: 'error', error: 'extension_not_allowed' });
      close(4403);
      return;
    }
    if (!tokenOk) {
      sendObj({ type: 'error', error: 'token_rejected' });
      close(4401);
      return;
    }

    session.browser = normalizeBrowser(data.browser);
    registerWsChannel(session.browser, channel);
    clearTimeout(session.helloTimer);
    console.log(`[ws] ${session.browser} 已连接（${String(data.extensionId).slice(0, 8)}…）`);
    sendObj({ type: 'ready' });

    // 心跳双轨：控制帧 ping 负责死连接检测（浏览器自动 pong），数据帧负责
    // service worker 的"活动"——ping/pong 由网络栈应答，不进 JS 事件循环，
    // 不重置 MV3 idle 计时器；会触发 onmessage 的文本帧才会。错开 10 秒发送。
    session.pingTimer = setInterval(() => {
      if (session.closed) { return; }
      if (Date.now() - session.lastPong > PONG_TIMEOUT_MS) {
        close(1001);
        return;
      }
      try { socket.write(encodeControl(0x9, Buffer.alloc(0))); } catch (e) { /* 已断开 */ }
    }, PING_INTERVAL_MS);
    session.kaTimer = setInterval(() => {
      if (session.closed) { return; }
      try { socket.write(encodeText('{"type":"ka"}')); } catch (e) { /* 已断开 */ }
    }, PING_INTERVAL_MS);
  }

  function dispatchMessage(opcode, payload) {
    if (opcode === 9) {           // ping -> pong
      try { socket.write(encodeControl(0xA, payload)); } catch (e) { /* 已断开 */ }
      return;
    }
    if (opcode === 10) { session.lastPong = Date.now(); return; }   // pong
    if (opcode === 8) { close(1000); return; }                      // close 回执
    if (session.browser === null) {
      let hello = null;
      try { hello = JSON.parse(payload.toString('utf8')); } catch (e) { close(1002); return; }
      handleHello(hello);
      return;
    }
    // 鉴权后的文本帧：result 上行结算 pending，其余是杂音，忽略不回包
    let msg = null;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { return; }
    if (msg && msg.type === 'result' && typeof msg.id === 'number') {
      // 回传方就是持有这条通道的浏览器，无需再比对 browser 字段。
      // 对不上（id 已超时或从未存在）与 HTTP 侧 accepted:false 同义，静默。
      recordResult(session.browser, msg.id, msg.result);
    }
  }

  // 帧解析。分片消息在这里拼完整后才交给 dispatch。
  //
  // 半帧到达的处理：帧可能被拆成任意多段 socket 数据，这里必须留在"尚未收完的
  // 帧"从它自己的帧头重新解析——半帧 break 时 offset 已越过帧头（甚至吃进了
  // 掩码字节），照 b.subarray(offset) 截会把掩码字节当成帧头直接 close(1002)
  // （大 result 帧几乎必然分多段到达）。完整消费的边界见 parseFrames 尾部的
  // consumed 截断说明。
  function parseFrames() {
    // 帧上限按鉴权状态取：hello 阶段 1MB，鉴权后放大到 result 上行需要的 34MB
    const cap = session.browser ? MAX_RESULT_PAYLOAD : MAX_PAYLOAD;
    const buf = session.buffer;
    let offset = 0;
    let consumed = 0;
    for (;;) {
      if (buf.length - offset < 2) { break; }
      const b0 = buf[offset];
      const b1 = buf[offset + 1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      offset += 2;

      if (len === 126) {
        if (buf.length - offset < 2) { break; }
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length - offset < 8) { break; }
        const big = buf.readBigUInt64BE(offset);
        offset += 8;
        len = big > BigInt(cap) ? cap + 1 : Number(big);
      }
      if (len > cap) { close(1009); return; }
      if (!masked) {
        // RFC 6455：客户端帧必须掩码。不守规矩的客户端（手写脚本）直接断
        close(1002);
        return;
      }
      if (buf.length - offset < 4 + len) { break; }

      const key = Buffer.from([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]]);
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) { payload[i] ^= key[i & 3]; }
      offset += 4 + len;

      if (!fin && (opcode === 1 || opcode === 2)) {
        session.fragments = { parts: [payload] };
        continue;
      }
      if (opcode === 0) {
        if (!session.fragments) { close(1002); return; }
        session.fragments.parts.push(payload);
        if (!fin) { continue; }
        dispatchMessage(1, Buffer.concat(session.fragments.parts));
        session.fragments = null;
        consumed = offset;
        continue;
      }
      dispatchMessage(opcode, payload);
      consumed = offset;
    }
    // 截断的边界是"最后一个已完整消费的帧"之后：完整帧一律立即消费，只有
    // 尚未收完的帧（可能停在帧头或载荷中间）才保留待下一轮。此前按"最后
    // 尝试解析的帧头"截断，会把已派发的最后一帧整帧留在缓冲区里，下一批
    // 数据到达时原样重放；若最后一帧恰好是某个分片消息的.fin 续帧，重放的
    // 续帧会撞上已复位的 fragments 直接 close(1002)，把同批还没解析的消息
    // 一起吞掉——test-mcp 里"截图（大结果被浏览器分片）后的下一个任务必超时"
    // 就是这么来的。
    session.buffer = buf.subarray(consumed);
  }

  socket.on('data', (chunk) => {
    session.buffer = Buffer.concat([session.buffer, chunk]);
    parseFrames();
  });
  socket.on('error', () => close(1011));
  socket.on('close', () => close(1000));

  // 身份等待：握手成功但迟迟不发 hello 的连接不值得保留
  session.helloTimer = setTimeout(() => { close(1008); }, HELLO_TIMEOUT_MS);
}

module.exports = { attach, acceptKey, encodeText, encodeControl };
