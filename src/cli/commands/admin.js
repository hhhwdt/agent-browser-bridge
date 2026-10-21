/**
 * CLI 管理类命令：token / log / batch。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfigDir } = require('../../config-dir.js');

/**
 * 生成并落盘一个新 token，返回 { token, file }。
 * 独立成函数而非写在 cmdToken 里：测试用临时目录调用，不碰用户的真实 token。
 * 服务端与 WS 都在启动时读一次 token 文件，重启后新值才生效。
 */
function rotateToken(configDir) {
  const dir = configDir || getConfigDir();
  const file = path.join(dir, 'token');
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return { token, file };
}

/** token 命令：--rotate 生成新 token，否则显示 token 文件路径和内容。 */
async function cmdToken(args) {
  if (args.rotate) {
    const { token, file } = rotateToken();
    console.log(`新 token 已写入: ${file}`);
    console.log(token);
    console.log();
    console.log('生效步骤：');
    console.log('  1. 重启桥接服务（scripts/restart-server.ps1 或你平时的启动命令）；重启前旧 token 仍有效');
    console.log('  2. 每个浏览器的扩展弹窗里粘贴新 token，粘贴后扩展立即自动重连');
    return;
  }

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

module.exports = { cmdToken, cmdLog, cmdBatch, rotateToken };
