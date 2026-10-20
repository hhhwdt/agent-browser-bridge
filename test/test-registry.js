#!/usr/bin/env node
/**
 * 动作注册表的一致性测试：三方对齐，漂移当场暴露。
 *
 * src/actions-registry.js 是动作元数据（路径、参数、校验、MCP schema、CLI 取值选项）的
 * 单一来源，server 路由、mcp/tools.js、cli/args.js 都由它生成。本测试守住三件事：
 *
 *   1. 注册表 ↔ server 路由表：每个动作的路径都在 src/server/index.js 里注册，
 *      表里多出来的只有传输用的 /poll /result /capabilities。
 *   2. 注册表 ↔ 扩展动作函数：注册表里的每个可派发动作，在 extension/sw/ 里
 *      都有对应的动作函数（动作名还能被 background.js 的 runAction 派发到）。
 *      扩展端是浏览器 ESM，物理上无法共享注册表文件，靠这里锁名字。
 *   3. 注册表 ↔ MCP handlers：生成的工具名与 handlers.js 能处理的工具名一一对应。
 *
 *   node test-registry.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { ACTIONS, MCP_ORDER, CLI_VALUE_OPTS, toolFor } = require('../src/actions-registry.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : detail}`); }
}

/* ------------------------------------------------------------------ *
 * [1] 注册表自洽
 * ------------------------------------------------------------------ */

console.log('\n[1] 注册表自洽');
{
  const mcpNames = [];
  let shapeOk = true;
  let detail = '';
  for (const [name, entry] of Object.entries(ACTIONS)) {
    if (!entry.path || !entry.path.startsWith('/')) {
      shapeOk = false;
      detail += ` ${name}: path 不是 HTTP 路径`;
      continue;
    }
    if (!entry.bespoke && !entry.method && !entry.target) {
      shapeOk = false;
      detail += ` ${name}: 非 bespoke 动作缺 target`;
    }
    if (entry.mcp) { mcpNames.push(entry.mcp); }
  }
  check('每个动作都有合法 path 与 target', shapeOk, detail);

  const dup = mcpNames.filter((n, i) => mcpNames.indexOf(n) !== i);
  if (dup.length) {
    check('MCP 工具名不重复', false, dup.join(', '));
  } else if (mcpNames.length !== MCP_ORDER.length) {
    check('MCP 工具名不重复', false, `动作表 ${mcpNames.length} 个，MCP_ORDER ${MCP_ORDER.length} 个`);
  } else {
    check('MCP 工具名不重复且 ORDER 数量一致', true);
  }

  const missingOrder = mcpNames.filter((n) => !MCP_ORDER.includes(n));
  check('ORDER 覆盖动作表全部工具', missingOrder.length === 0, missingOrder.join(', '));
}

/* ------------------------------------------------------------------ *
 * [2] 生成的 MCP 工具 schema 结构
 * ------------------------------------------------------------------ */

console.log('\n[2] 生成的 MCP 工具 schema');
{
  const tools = MCP_ORDER.map((toolName) => toolFor(toolName));
  const bad = [];
  for (const tool of tools) {
    const schema = tool.inputSchema;
    if (!tool.name || !tool.description) { bad.push(`${tool.name}: name/description 缺失`); continue; }
    if (schema.type !== 'object' || schema.additionalProperties !== false) {
      bad.push(`${tool.name}: schema 顶层不是封闭 object`);
      continue;
    }
    const required = schema.required || [];
    for (const req of required) {
      if (!(req in schema.properties)) { bad.push(`${tool.name}: required 里的 ${req} 不在 properties`); }
    }
  }
  check(`${tools.length} 个工具 schema 结构不变量`, bad.length === 0, bad.join('; '));

  const okExact = JSON.stringify(tools) === JSON.stringify(MCP_ORDER.map((n) => toolFor(n)));
  check('两个工具名都能生成（顺序稳定）', okExact);
}

/* ------------------------------------------------------------------ *
 * [3] 注册表 ↔ server 路由表
 * ------------------------------------------------------------------ */

console.log('\n[3] server 路由表一致性');
{
  const src = fs.readFileSync(path.join(root, 'src', 'server', 'index.js'), 'utf8');
  const rows = /[A-Z]+', \[([^\]]+)\]/g;
  const tablePaths = new Set();
  let m;
  while ((m = rows.exec(src)) !== null) {
    for (const p of m[1].split(',')) {
      const cleaned = p.trim().replace(/^['"]|['"]$/g, '');
      if (cleaned.startsWith('/')) { tablePaths.add(cleaned); }
    }
  }
  const registryPaths = new Set(Object.values(ACTIONS).map((e) => e.path));

  const unregistered = [...registryPaths].filter((p) => !tablePaths.has(p));
  check('注册表每个动作都已挂到路由表', unregistered.length === 0, unregistered.join(', '));

  // 传输路径与 health 的别名不在动作表里，其余多出来的路径都值得怀疑
  const expectedExtras = new Set(['/poll', '/result', '/capabilities']);
  const extras = [...tablePaths].filter((p) => !registryPaths.has(p) && !expectedExtras.has(p));
  check('路由表没有未登记的新路径', extras.length === 0, extras.join(', '));
}

/* ------------------------------------------------------------------ *
 * [4] 注册表 ↔ 扩展动作函数
 * ------------------------------------------------------------------ */

console.log('\n[4] 扩展动作函数覆盖');
{
  // 扩展端无法共享注册表（浏览器 ESM），动作名在这里对齐。
  // diag / reload 由 background.js 的 runAction 直接处理，无独立模块函数。
  const EXTENSION_EXPORTS = {
    tabs: 'listTabs', read: 'readTab', links: 'linksTab', media: 'mediaTab',
    screenshot: 'screenshotTab', eval: 'evalTab', session: 'sessionTab',
    frames: 'framesDiag', activate: 'activateTab', wait: 'waitTab',
    click: 'clickTab', type: 'typeTab', key: 'keyTab', navigate: 'navigateTab',
    upload: 'uploadTab', download: 'downloadTab', save: 'saveTab', grab: 'grabTab'
  };

  const swDir = path.join(root, 'extension', 'sw');
  const exported = new Set();
  for (const f of fs.readdirSync(swDir)) {
    if (!f.endsWith('.js')) { continue; }
    const src = fs.readFileSync(path.join(swDir, f), 'utf8');
    let m;
    const re = /export (?:async )?function (\w+)/g;
    while ((m = re.exec(src)) !== null) { exported.add(m[1]); }
  }

  const missing = [];
  for (const [action, fn] of Object.entries(EXTENSION_EXPORTS)) {
    if (!exported.has(fn)) { missing.push(`${action} → ${fn}`); }
  }
  check('每个可派发动作在扩展端都有动作函数', missing.length === 0, missing.join(', '));

  // mark/unmark 在 marks.js 里，同样按名字对齐
  for (const fn of ['markTask', 'unmarkTask']) {
    if (!exported.has(fn)) { missing.push(fn); }
  }
  check('mark/unmark 在 marks.js 里导出', exported.has('markTask') && exported.has('unmarkTask'));
}

/* ------------------------------------------------------------------ *
 * [5] 注册表 ↔ MCP handlers
 * ------------------------------------------------------------------ */

console.log('\n[5] MCP handlers 覆盖');
{
  const { HANDLERS } = require('../src/mcp/handlers.js');
  const handlerNames = Object.keys(HANDLERS);
  const missing = MCP_ORDER.filter((n) => !handlerNames.includes(n));
  const extra = handlerNames.filter((n) => !MCP_ORDER.includes(n));
  check('handlers 与工具表一一对应', missing.length === 0 && extra.length === 0,
    `缺: ${missing.join(', ')}  多: ${extra.join(', ')}`);
}

/* ------------------------------------------------------------------ *
 * [6] CLI 取值选项快照
 * ------------------------------------------------------------------ */

console.log('\n[6] CLI 取值选项白名单');
{
  // 白名单 = CLI 常驻 + 注册表登记，按快照锁住解析行为：
  // 改名或删项都要动这里，避免悄悄改变某个 --参数 的取值/开关属性。
  const args = require('../src/cli/args.js');
  const expected = new Set([
    'match', 'url', 'tabId', 'frameId', 'browser', 'selector', 'text', 'href',
    'value', 'key', 'index', 'port', 'timeout', 'host', 'idle', 'count', 'tail',
    'code', 'file', 'out', 'format', 'name', 'header', 'filename',
    // --maxBytes 过去不在表里，按开关解析吞噬了真实值，这里一并登记
    'maxBytes'
  ]);
  const got = args.VALUE_OPTS;
  const missing = [...expected].filter((n) => !got.has(n));
  const extra = [...got].filter((n) => !expected.has(n));
  check('VALUE_OPTS 与快照一致', missing.length === 0 && extra.length === 0,
    `缺: ${missing.join(', ')}  多: ${extra.join(', ')}`);

  // 注册表里登记的每个 CLI 旗标都落进了白名单
  const fromRegistry = Object.entries(CLI_VALUE_OPTS).map(([n, f]) => (f === true ? n : f));
  const missed = fromRegistry.filter((n) => !got.has(n));
  check('注册表 CLI 旗标全部并入白名单', missed.length === 0, missed.join(', '));
}

/* ------------------------------------------------------------------ *
 * [7] 注册表 ↔ 对外能力清单
 * ------------------------------------------------------------------ */

console.log('\n[7] CAPABILITIES 能力清单');
{
  const { CAPABILITIES } = require('../src/server/config.js');
  // /health 与 /batch 是控制面，不进能力清单
  const exceptions = new Set(['health', 'batch']);
  const missing = Object.keys(ACTIONS).filter((n) => !exceptions.has(n) && !CAPABILITIES.includes(n));
  check('每个动作都在能力清单里', missing.length === 0, missing.join(', '));
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
