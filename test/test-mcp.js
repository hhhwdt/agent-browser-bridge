#!/usr/bin/env node
/**
 * mcp.js 的协议层测试：自己充当一个 MCP 客户端，用 stdio 和它对话。
 *
 * 不依赖任何 MCP SDK——被测的就是那份手写的 JSON-RPC 实现，
 * 用官方 SDK 来测反而会把要验证的东西盖过去。
 *
 * 握手、工具清单、错误映射这几项不需要桥接服务；只有真正调用工具的几项需要，
 * 桥接或扩展不在时会跳过并说明。
 *
 *   node test-mcp.js
 */

'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createClient } = require('../src/client.js');

const SERVER = path.join(__dirname, '..', 'src', 'mcp.js');
/** 测试自己收尾用（只清自己开的标签页），不走被测的 MCP 通道 */
const bridge = createClient();

let pass = 0;
let fail = 0;
let skipped = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)}`);
  }
}

function skip(name, why) {
  skipped++;
  console.log(`  skip ${name}  （${why}）`);
}

/** 一个极简 MCP 客户端：拉子进程、按行收发 JSON-RPC。 */
class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) { continue; }
        let msg;
        try { msg = JSON.parse(line); } catch (e) {
          // stdout 上出现非协议内容就是协议违规，这里记录下来让断言去报
          this.protocolGarbage = (this.protocolGarbage || []).concat(line.slice(0, 200));
          continue;
        }
        const waiter = this.pending.get(msg.id);
        if (waiter) { this.pending.delete(msg.id); waiter(msg); }
        else { this.unmatched = (this.unmatched || []).concat(msg); }
      }
    });
  }

  /** 发一个请求并等它的响应。 */
  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) { msg.params = params; }
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) { msg.params = params; }
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  kill() {
    try { this.child.kill(); } catch (e) { /* 已退出 */ }
  }
}

(async () => {
  const c = new McpClient();
  try {
    console.log('\n[1] initialize 握手');
    const init = await c.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-mcp', version: '1.0.0' }
    });
    check('有 result', !!init.result, init);
    const r = init.result || {};
    check('回带 protocolVersion', typeof r.protocolVersion === 'string' && r.protocolVersion.length > 0, r.protocolVersion);
    check('声明 tools 能力', !!(r.capabilities && r.capabilities.tools), r.capabilities);
    check('有 serverInfo', !!(r.serverInfo && r.serverInfo.name && r.serverInfo.version), r.serverInfo);
    check('有 instructions（模型会读到的工作纪律）',
      typeof r.instructions === 'string' && r.instructions.length > 100, (r.instructions || '').length);
    c.notify('notifications/initialized', {});

    console.log('\n[2] tools/list');
    const list = await c.request('tools/list', {});
    const tools = (list.result && list.result.tools) || [];
    check('工具数 > 10', tools.length > 10, tools.length);
    check('每个工具都有 name / description / inputSchema',
      tools.every((t) => t.name && t.description && t.inputSchema), tools.find((t) => !t.name || !t.description || !t.inputSchema));
    check('inputSchema 都是 object 类型',
      tools.every((t) => t.inputSchema.type === 'object' && t.inputSchema.properties),
      tools.filter((t) => t.inputSchema.type !== 'object').map((t) => t.name));
    check('工具名唯一', new Set(tools.map((t) => t.name)).size === tools.length);
    check('工具名统一 browser_ 前缀', tools.every((t) => t.name.startsWith('browser_')),
      tools.filter((t) => !t.name.startsWith('browser_')).map((t) => t.name));
    check('required 里列出的字段都在 properties 里',
      tools.every((t) => (t.inputSchema.required || []).every((k) => k in t.inputSchema.properties)),
      tools.filter((t) => (t.inputSchema.required || []).some((k) => !(k in t.inputSchema.properties))).map((t) => t.name));
    check('additionalProperties 全部显式设为 false',
      tools.every((t) => t.inputSchema.additionalProperties === false),
      tools.filter((t) => t.inputSchema.additionalProperties !== false).map((t) => t.name));
    check('每个工具的描述都写了用途（> 20 字）',
      tools.every((t) => t.description.length > 20),
      tools.filter((t) => t.description.length <= 20).map((t) => t.name));
    console.log(`     （${tools.length} 个工具: ${tools.map((t) => t.name.replace('browser_', '')).join(', ')}）`);

    console.log('\n[3] 协议边角');
    const pong = await c.request('ping', {});
    check('ping 回空 result', pong.result && Object.keys(pong.result).length === 0, pong);
    const bad = await c.request('no/such/method', {});
    check('未知方法回 -32601', bad.error && bad.error.code === -32601, bad);
    const noName = await c.request('tools/call', {});
    check('tools/call 缺 name 回 -32602', noName.error && noName.error.code === -32602, noName);
    const unknown = await c.request('tools/call', { name: 'browser_nope', arguments: {} });
    check('未知工具回 isError 结果（不是协议错误）',
      unknown.result && unknown.result.isError === true, unknown);
    check('无 id 的通知不产生响应', !c.unmatched, c.unmatched);
    check('stdout 上只有协议消息', !c.protocolGarbage, c.protocolGarbage);

    console.log('\n[4] 真实调用（需要桥接服务与扩展）');
    // CI 里没有浏览器，等了也是白等：设 ABB_MCP_OFFLINE=1 直接跳过这一节，
    // 上面三节（握手、工具清单、协议边角）本身就是协议层要验的全部内容。
    //
    // 不在 CI 里时也只等 8 秒：扩展重连通常一两秒就够；如果一直连不上，
    // 多半是用户还没加载扩展——那不是等能解决的问题，早点说清楚更好。
    const ready = process.env.ABB_MCP_OFFLINE === '1'
      ? false
      : await bridge.waitUntilReady(8000);
    if (!ready) {
      skip('全部真实调用',
        process.env.ABB_MCP_OFFLINE === '1'
          ? '按 ABB_MCP_OFFLINE=1 跳过'
          : '扩展未连上（若是首次使用，先按 QUICKSTART 加载扩展并授权站点）');
    } else {
      const status = await c.request('tools/call', { name: 'browser_status', arguments: {} });
      const statusText = status.result && status.result.content && status.result.content[0] && status.result.content[0].text;
      check('browser_status 返回文本', typeof statusText === 'string' && statusText.length > 0, statusText);
      check('browser_status 里能看到扩展版本', /扩展版本/.test(statusText || ''), statusText);

      const tabs = await c.request('tools/call', { name: 'browser_list_tabs', arguments: {} });
      const tabsText = tabs.result.content[0].text;
      check('browser_list_tabs 列出标签页', /个标签页/.test(tabsText), tabsText.slice(0, 120));

      // 在桥接自己的地址上开一个后台标签页来验证读写（该 origin 天然已授权）
      const nav = await c.request('tools/call', {
        name: 'browser_navigate',
        arguments: { url: 'http://127.0.0.1:18777/health', newTab: true }
      });
      const navText = nav.result.content[0].text;
      check('browser_navigate 新建后台标签页', /后台新建/.test(navText), navText.slice(0, 160));
      const tabId = (navText.match(/标签页: (\d+)/) || [])[1];

      if (tabId) {
        const read = await c.request('tools/call', {
          name: 'browser_read_page',
          arguments: { tabId: Number(tabId) }
        });
        check('browser_read_page 读到内容', /字符数: [1-9]/.test(read.result.content[0].text),
          read.result.content[0].text.slice(0, 200));

        const shot = await c.request('tools/call', {
          name: 'browser_screenshot',
          arguments: { tabId: Number(tabId) }
        });
        const blocks = shot.result.content || [];
        check('browser_screenshot 返回 image 内容块',
          blocks.some((b) => b.type === 'image' && b.data && b.mimeType === 'image/png'),
          blocks.map((b) => b.type));

        // 错误映射：不存在的标签页应该回 isError 且带可照做的提示
        const missing = await c.request('tools/call', {
          name: 'browser_read_page',
          arguments: { tabId: 999999999 }
        });
        const mt = missing.result.content[0].text;
        check('找不到标签页时 isError=true', missing.result.isError === true, missing.result);
        check('错误信息里带错误码', /no_tab_matched/.test(mt), mt.slice(0, 200));

        // 只清自己那个标签页的标记，且要在关掉它之前清。
        // 刻意不调 browser_clear_marks：它是全局清除，会把这个浏览器里你（或你正在跑的
        // agent）在其他页面留下的标记一起清掉。它出现在 tools/list 里就够了，
        // 清除逻辑本身由 test-live.js 的收尾步骤覆盖。
        try {
          await bridge.unmark({ tabId: Number(tabId) });
        } catch (e) { /* 忽略 */ }

        const closed = await c.request('tools/call', {
          name: 'browser_close_tab',
          arguments: { tabId: Number(tabId) }
        });
        check('browser_close_tab 关掉自己开的标签页', /已关闭/.test(closed.result.content[0].text),
          closed.result.content[0].text.slice(0, 120));
      }
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL 抛出异常: ${e && e.message ? e.message : e}`);
  } finally {
    if (c.stderr.trim()) {
      console.log(`\n服务端 stderr（前 400 字）:\n${c.stderr.trim().slice(0, 400)}`);
    }
    c.kill();
  }

  console.log(`\n通过 ${pass}，失败 ${fail}，跳过 ${skipped}`);
  process.exit(fail === 0 ? 0 : 1);
})();
