/**
 * CLI 管理类命令：token / log / batch。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getConfigDir } = require('../../config-dir.js');

/** token 命令：显示 token 文件路径和内容。 */
async function cmdToken(args) {
  const tokenFile = path.join(getConfigDir(), 'token');

  if (args.show) {
    try {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      console.log(token);
    } catch (e) {
      console.error(`无法读取 token 文件: ${tokenFile}`);
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  console.log(`Token 文件: ${tokenFile}`);
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    console.log(`Token 长度: ${token.length} 字符`);
    console.log('把 token 粘贴到扩展弹窗的输入框里');
  } catch (e) {
    console.error('Token 文件不存在。请先启动桥接服务生成 token。');
  }
}

/** log 命令：读取审计日志。 */
async function cmdLog(args) {
  const logFile = args._[1] || path.join(getConfigDir(), 'audit.jsonl');

  let content;
  try {
    content = fs.readFileSync(logFile, 'utf8');
  } catch (e) {
    console.error(`无法读取日志文件: ${logFile}`);
    console.error(e.message);
    process.exit(1);
  }

  const lines = content.split('\n').filter((l) => l.trim());
  const tail = args.tail ? parseInt(args.tail, 10) : 50;
  const tailLines = lines.slice(-tail);

  if (args.json) {
    const entries = tailLines.map((l) => JSON.parse(l));
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  for (const line of tailLines) {
    const entry = JSON.parse(line);
    const target = entry.target || {};
    const targetStr = target.tabId ? `tab=${target.tabId}` : (target.match || target.host || '-');
    console.log(`${entry.timestamp}  ${entry.action}  ${entry.outcome}  ${entry.duration}ms  ${targetStr}`);
  }
}

/** batch 命令：从 JSON 文件读步骤列表，批量执行。 */
async function cmdBatch(args, ctx) {
  const { client, timeoutMs } = ctx;
  const file = args._[1];
  if (!file) {
    console.error('用法: node src/cli.js batch <steps.json>');
    process.exit(1);
  }

  let steps;
  try {
    steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`无法读取步骤文件: ${file}`);
    console.error(e.message);
    process.exit(1);
  }

  if (!Array.isArray(steps)) {
    console.error('步骤文件必须是 JSON 数组');
    process.exit(1);
  }

  const data = await client.batch(steps, { timeoutMs });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }

  for (const r of (data.results || [])) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    console.log(`  ${mark}  步骤 ${r.step}  ${r.action}  ${r.ok ? '' : r.error || ''}`);
  }
}

module.exports = { cmdToken, cmdLog, cmdBatch };
