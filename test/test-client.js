#!/usr/bin/env node
/**
 * 命令行与客户端库的参数/错误测试。不需要浏览器，也不需要桥接服务。
 *
 * 两个曾经出错的地方：
 *   - 重复的 --file / --header 只保留了最后一个，于是"可重复"的参数实际上传不出去
 *   - 请求超时被报成 bridge_unavailable（"服务未启动"），排查方向完全相反
 *
 *   node test-client.js
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const REPO = path.join(__dirname, '..');
// parseArgs 在 src/cli/index.js；eval 的 --file 读取在 src/cli/commands/info.js。
const cliIndexSrc = fs.readFileSync(path.join(REPO, 'src', 'cli', 'index.js'), 'utf8');
const infoCmdSrc = fs.readFileSync(path.join(REPO, 'src', 'cli', 'commands', 'info.js'), 'utf8');

/* ------------------------------------------------------------------ *
 * read.js 的参数解析：抽真实源码里的 parseArgs 来跑
 * ------------------------------------------------------------------ */
const parseArgsBody = cliIndexSrc.slice(cliIndexSrc.indexOf('function parseArgs'), cliIndexSrc.indexOf('function usage'));
const parseArgs = new Function('argv', parseArgsBody + '\nreturn parseArgs(argv);');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`); }
}

const multiFile = parseArgs(['node', 'read.js', 'upload', '--match', 'x', '--file', 'a.pdf', '--file', 'b.pdf', '--file', 'c.pdf']);
check('重复 --file 全部保留',
  JSON.stringify(multiFile.file) === '["a.pdf","b.pdf","c.pdf"]', JSON.stringify(multiFile.file));

const multiHeader = parseArgs(['node', 'read.js', 'download', '--url', 'u', '--header', 'X-A: 1', '--header', 'X-B: 2']);
check('重复 --header 全部保留',
  JSON.stringify(multiHeader.header) === '["X-A: 1","X-B: 2"]', JSON.stringify(multiHeader.header));

const singleFile = parseArgs(['node', 'read.js', 'upload', '--file', 'only.pdf']);
check('单个 --file 也是数组（读取处不必区分两种形态）',
  Array.isArray(singleFile.file) && singleFile.file[0] === 'only.pdf', JSON.stringify(singleFile.file));

const evalFile = parseArgs(['node', 'read.js', 'eval', '--file', 'code.js']);
check('eval 的 --file 同样是数组', Array.isArray(evalFile.file) && evalFile.file[0] === 'code.js',
  JSON.stringify(evalFile.file));
check('eval 读取处取的是 args.file[0]', infoCmdSrc.includes('fs.readFileSync(args.file[0]'));

const repeated = parseArgs(['node', 'read.js', 'read', '--match', 'a', '--match', 'b', '--links']);
check('非可重复参数仍然后者覆盖', repeated.match === 'b', repeated.match);
check('布尔开关不受影响', repeated.links === true);

/* ------------------------------------------------------------------ *
 * client.js 的错误归类
 * ------------------------------------------------------------------ */
const { createClient } = require('../src/client.js');

const slow = http.createServer(() => { /* 故意不响应 */ });
slow.listen(18996, '127.0.0.1', async () => {
  const timingOut = createClient({ port: 18996 });
  try {
    await timingOut.tabs({ timeoutMs: 300 });
    check('请求超时应抛错', false);
  } catch (e) {
    check('请求超时抛 BridgeError 且 code=timeout（不是"服务未启动"）',
      e.name === 'BridgeError' && e.code === 'timeout', `${e.name}/${e.code}`);
  }

  const noServer = createClient({ port: 18995 });   // 这个端口上没有服务
  try {
    await noServer.tabs({ timeoutMs: 300 });
    check('连不上时应抛错', false);
  } catch (e) {
    check('连不上仍抛 BridgeUnavailableError',
      e.name === 'BridgeUnavailableError' && e.code === 'bridge_unavailable', `${e.name}/${e.code}`);
  }

  slow.close();
  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
});
