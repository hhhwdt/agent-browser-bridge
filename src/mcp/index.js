#!/usr/bin/env node
/**
 * Agent Browser Bridge —— MCP 服务（入口）。
 *
 * 把桥接的能力暴露成 MCP 工具，任何支持 MCP 的 agent（Claude Code、Cursor、Cline…）
 * 配一行就能用，不需要自己写代码调 client.js。
 *
 * 传输自己实现：MCP 的 stdio 传输就是「JSON-RPC 2.0，一行一条消息」，
 * 工具类服务只需要 initialize / tools/list / tools/call 三个方法，
 * 为此引入 @modelcontextprotocol/sdk 会让本仓库丢掉「零依赖」这个特点。
 *
 * 两条硬约束：
 *   - stdout 只走协议消息。任何日志、警告、堆栈都必须写 stderr，
 *     往 stdout 打一行普通文字就会破坏协议，客户端会直接判定服务异常。
 *   - 每条消息必须单行，不能内嵌换行。
 *
 * 用法：
 *   node src/mcp.js               作为 MCP 服务运行（由客户端拉起）
 *   node src/mcp.js --list-tools  只打印工具清单，便于人工核对
 *
 * 注册到 Claude Code（在仓库根目录执行，路径交给 shell 展开，不必写死）：
 *   claude mcp add -s user browser -- node "$PWD/src/mcp.js"    # macOS / Linux / Git Bash
 *   claude mcp add -s user browser -- node "%CD%\src\mcp.js"    # Windows cmd
 * 或者 npm i -g . 之后直接用 agent-browser-bridge-mcp，完全不涉及路径。
 * 详见 docs/QUICKSTART.md。
 *
 * 模块划分：
 *   tools.js    工具 schema 与 initialize 说明
 *   handlers.js 工具名 -> 桥接调用的实现
 *   ensure.js   必要时把桥接服务拉起来
 *   log.js      stderr 日志与结果包装
 */

'use strict';

const { SERVER_NAME, SERVER_VERSION } = require('./meta.js');
const { TOOLS, INSTRUCTIONS } = require('./tools.js');
const { callTool } = require('./handlers.js');
const { ensureBridge } = require('./ensure.js');
const { log } = require('./log.js');

/**
 * 本实现支持的 MCP 协议版本。
 * 客户端请求的版本只要是个字符串就照原样回，因为工具类服务用到的这三个方法
 * （initialize / tools/list / tools/call）在这些版本之间没有差异；
 * 硬性拒绝反而会让新版本客户端连不上。
 */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/* ------------------------------------------------------------------ *
 * MCP stdio 传输
 * ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  // 通知（没有 id）不需要回应
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id');

  if (msg.method === 'initialize') {
    const asked = msg.params && msg.params.protocolVersion;
    sendResult(msg.id, {
      protocolVersion: typeof asked === 'string' && asked ? asked : FALLBACK_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS
    });
    return;
  }

  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
    return;
  }

  if (msg.method === 'ping') {
    if (isRequest) { sendResult(msg.id, {}); }
    return;
  }

  if (msg.method === 'tools/list') {
    sendResult(msg.id, { tools: TOOLS });
    return;
  }

  if (msg.method === 'tools/call') {
    const p = msg.params || {};
    if (!p.name) {
      sendError(msg.id, -32602, '缺少 params.name');
      return;
    }
    const result = await callTool(p.name, p.arguments);
    sendResult(msg.id, result);
    return;
  }

  if (isRequest) {
    sendError(msg.id, -32601, `不支持的方法: ${msg.method}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list-tools')) {
    console.log(`${TOOLS.length} 个工具：`);
    for (const t of TOOLS) {
      const req = (t.inputSchema.required || []).join(', ');
      console.log(`  ${t.name}${req ? '  (必填: ' + req + ')' : ''}`);
      console.log(`      ${t.description.split('\n')[0].slice(0, 140)}`);
    }
    return;
  }

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) { continue; }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        sendError(null, -32700, 'JSON 解析失败');
        continue;
      }
      handleMessage(msg).catch((e) => {
        log('处理消息出错', e && e.stack ? e.stack : e);
        if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
          sendError(msg.id, -32603, String(e && e.message ? e.message : e));
        }
      });
    }
  });

  process.stdin.on('end', () => process.exit(0));

  // 未处理的异常不能让进程带着半截协议状态死掉，记到 stderr 供排查
  process.on('unhandledRejection', (e) => log('未处理的拒绝', e && e.stack ? e.stack : e));
  process.on('uncaughtException', (e) => log('未捕获异常', e && e.stack ? e.stack : e));

  // 启动时就把桥接准备好，别让第一次工具调用承担这个延迟
  ensureBridge().catch((e) => {
    log('桥接服务不可用：' + (e && e.message ? e.message : e));
    log('工具仍会列出，但调用会返回明确错误。');
  });

  log(`已启动（v${SERVER_VERSION}，${TOOLS.length} 个工具）`);
}

main();
