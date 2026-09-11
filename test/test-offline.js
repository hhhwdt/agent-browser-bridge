#!/usr/bin/env node
/**
 * 离线测试总入口：跑完所有不需要浏览器、不需要 test-config.js 的套件。
 *
 * 这些套件都不碰 18777 上正在跑的那个桥接实例（各自在隔离端口上起自己的服务），
 * 因此可以在 CI 里跑，也可以在改完代码后随手跑一遍。
 *
 *   node test-offline.js
 *
 * 需要浏览器的部分另有两个入口：
 *   node test-live.js    真机冒烟（仍不需要配置，用桥接自己的地址当测试床）
 *   node test-basic.js   等需要 test-config.js 的套件
 *
 * 环境变量：
 *   ABB_MCP_OFFLINE=1  跳过 test-mcp.js 里需要扩展的部分（CI 用），只验协议
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUITES = [
  ['服务脚本模块图能否加载', 'test-sw-load.js'],
  ['服务端派发、队列、结果体与来源校验', 'test-server.js'],
  ['eval 的执行次数与取值语义', 'test-eval.js'],
  ['写操作只在一个框架里执行', 'test-frame-targeting.js'],
  ['命令行参数解析与客户端错误归类', 'test-client.js'],
  ['扩展来源允许列表', 'test-allowlist.js'],
  ['注入函数自包含', path.join('..', 'tools', 'check-inject-scope.js')],
  ['扩展 ID 与清单公钥一致', path.join('..', 'tools', 'check-extension-id.js')],
  ['MCP 协议（自己充当客户端）', 'test-mcp.js']
];

const results = [];
for (const [label, file] of SUITES) {
  console.log(`\n${'='.repeat(64)}\n${label}  ——  ${file}\n${'='.repeat(64)}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  results.push({ label, file, ok: r.status === 0, status: r.status });
}

console.log(`\n${'='.repeat(64)}\n汇总\n${'='.repeat(64)}`);
for (const r of results) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.file.padEnd(26)} ${r.label}`);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length} 个套件失败：${failed.map((r) => r.file).join(', ')}`
  : `\n${results.length} 个套件全部通过`);
process.exit(failed.length ? 1 : 0);
