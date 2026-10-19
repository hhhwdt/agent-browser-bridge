#!/usr/bin/env node
/**
 * 审计日志测试：隔离端口起 server.js，假扮扩展派发动作，检查日志文件。
 *
 * 防的失败：审计日志泄露页面内容。一个会泄露"谁读了什么页面"的日志比没有日志更糟——
 * 它把用户的浏览历史放在一个文件里，任何能读该文件的人都能看到。
 *
 * 同时验证：每个派发动作产生一行、失败记录错误码、非动作路由不记录、文件轮转。
 *
 *   node test-audit.js
 */

'use strict';

const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = 18995;
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
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: httpPath,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (data) { req.write(data); }
    req.end();
  });
}

/** 读日志文件，返回解析后的条目数组。 */
function readLog(logFile) {
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    return content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

(async () => {
  // 用临时目录做日志文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-audit-'));
  const logFile = path.join(tmpDir, 'audit.jsonl');

  const server = spawn(process.execPath, [SERVER, '--port', String(PORT), '--log-file', logFile, '--no-token'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // 等服务启动
  await sleep(1200);

  try {
    /* ---------- 1. 非动作路由不记录 ---------- */
    await call('GET', '/health');
    await call('GET', '/tabs');
    await sleep(300);

    let entries = readLog(logFile);
    check('非动作路由不产生日志', entries.length === 0, `有 ${entries.length} 条`);

    /* ---------- 2. 动作路由产生一行 ---------- */
    // 先注册一个假扩展
    await call('POST', '/result', {
      taskId: 'test-1',
      browser: 'chrome',
      ok: true,
      data: { text: '这是页面内容，不应出现在日志里' }
    });

    // 派发一个 read 动作（短超时，让 dispatch 快速返回）
    await call('POST', '/read', { match: 'example.com', tabId: 999, timeoutMs: 2000 });
    await sleep(2500);

    entries = readLog(logFile);
    check('动作路由产生一行日志', entries.length === 1, `有 ${entries.length} 条`);

    if (entries.length === 1) {
      const e = entries[0];
      check('日志包含时间戳', typeof e.timestamp === 'string' && e.timestamp.length > 0);
      check('日志包含动作名', e.action === 'read', `action=${e.action}`);
      check('日志包含结果', e.outcome === 'timeout' || e.outcome === 'extension_not_connected' || e.outcome === 'no_tab_matched',
        `outcome=${e.outcome}`);
      check('日志包含耗时', typeof e.duration === 'number' && e.duration >= 0);
      check('日志包含调用方', typeof e.caller === 'number');
    }

    /* ---------- 3. 不记录页面内容 ---------- */
    const logContent = fs.readFileSync(logFile, 'utf8');
    check('日志不包含页面文本', !logContent.includes('这是页面内容'));
    check('日志不包含选择器内容', !logContent.includes('example.com/page-content'));

    /* ---------- 4. 多个动作产生多行 ---------- */
    await call('POST', '/click', { match: 'test.com', selector: '#btn', timeoutMs: 2000 });
    await call('POST', '/type', { match: 'test.com', selector: '#input', value: 'hello', timeoutMs: 2000 });
    await sleep(2500);

    entries = readLog(logFile);
    check('多个动作产生多行日志', entries.length === 3, `有 ${entries.length} 条`);

    /* ---------- 5. 文件轮转 ---------- */
    // 写一个接近上限的文件
    const bigLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      action: 'pad',
      target: {},
      outcome: 'ok',
      duration: 0,
      caller: 0
    }) + '\n';
    // 写足够多的行使文件超过 10MB
    const padCount = Math.ceil((10 * 1024 * 1024) / bigLine.length) + 1;
    const padContent = bigLine.repeat(padCount);
    fs.writeFileSync(logFile, padContent, 'utf8');

    // 触发一次动作，应该导致轮转
    await call('POST', '/read', { match: 'rotate-test.com', timeoutMs: 2000 });
    await sleep(2500);

    const rotatedFile = logFile + '.1';
    check('轮转文件存在', fs.existsSync(rotatedFile));
    check('新日志文件存在', fs.existsSync(logFile));

    if (fs.existsSync(rotatedFile)) {
      const rotatedContent = fs.readFileSync(rotatedFile, 'utf8');
      check('轮转文件包含旧日志', rotatedContent.includes('"action":"pad"'));
    }

    // 清理
    try { fs.unlinkSync(logFile); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(rotatedFile); } catch (e) { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch (e) { /* ignore */ }

  } finally {
    server.kill();
    await sleep(200);
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
