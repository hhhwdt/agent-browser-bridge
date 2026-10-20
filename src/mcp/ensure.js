/**
 * 桥接服务的可用性。
 *
 * 没有这一步，新用户从「装好扩展」到「第一次成功调用」之间会卡在
 * 「桥接服务未启动」上——这是这类工具最常见的第一次失败。
 */

'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { BridgeUnavailableError } = require('../client.js');
const { ab } = require('./bridge.js');
const { log } = require('./log.js');

/**
 * 并发调用共享同一个进行中的探测：启动时的预热和第一次工具调用的重试会同时进来，
 * 各自 spawn 一次就会出现两个进程（第二个 EADDRINUSE 直接退出，白拉一次）。
 */
let bridgeInFlight = null;

function ensureBridge() {
  if (bridgeInFlight) { return bridgeInFlight; }
  bridgeInFlight = doEnsureBridge().finally(() => { bridgeInFlight = null; });
  return bridgeInFlight;
}

async function doEnsureBridge() {
  try {
    const h = await ab.health();
    if (h && h.extensionConnected) { return; }
    throw new Error('桥接服务在运行，但没有浏览器扩展连上来。'
      + '请确认已在浏览器里加载并启用 Agent Browser Bridge 扩展（edge://extensions 或 chrome://extensions）。');
  } catch (e) {
    if (!(e instanceof BridgeUnavailableError)) { throw e; }
  }

  // 端口上没有服务：自己起一个。detached + unref 让它脱离本进程存活，
  // 因为扩展要一直有地方轮询，本进程被客户端关掉不该把桥接一起带走。
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'ignore' });
  child.unref();
  log(`桥接服务未在运行，已在后台启动（pid ${child.pid}）`);

  const deadline = Date.now() + 8000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const h = await ab.health();
      if (h) { return; }
    } catch (e) {
      if (Date.now() >= deadline) {
        throw new Error('已尝试启动桥接服务，但 8 秒内没有响应。'
          + `请手动运行 node ${serverPath} 查看原因。`);
      }
    }
  }
}

module.exports = { ensureBridge };
