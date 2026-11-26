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

/**
 * 审计统计：把"桥接花了多少"和"动作之间等了多久"分开。
 * 后者包含模型思考和客户端处理，是"感觉慢"时最容易被误算到桥接头上的那部分。
 */
function printStats(lines) {
  const rows = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
  }
  if (rows.length === 0) {
    console.log('日志里没有可解析的记录');
    return;
  }

  const pct = (arr, p) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  };

  const byAction = new Map();
  for (const row of rows) {
    const duration = typeof row.duration === 'number' ? row.duration : 0;
    if (!byAction.has(row.action)) { byAction.set(row.action, []); }
    byAction.get(row.action).push(duration);
  }

  console.log(`共 ${rows.length} 条记录\n`);
  console.log('动作耗时（桥接 + 扩展 + 页面，ms）');
  const actions = Array.from(byAction.entries()).sort((a, b) => b[1].length - a[1].length);
  for (const [action, durations] of actions) {
    console.log('  ' + String(action).padEnd(12)
      + ' n=' + String(durations.length).padStart(4)
      + '  p50=' + String(Math.round(pct(durations, 0.5))).padStart(5)
      + '  p90=' + String(Math.round(pct(durations, 0.9))).padStart(5)
      + '  max=' + Math.round(Math.max.apply(null, durations)));
  }

  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = Date.parse(rows[i - 1].timestamp);
    const next = Date.parse(rows[i].timestamp);
    if (!isFinite(prev) || !isFinite(next)) { continue; }
    const gap = next - prev;
    // 超过 10 分钟的间隔多半是人走开了，不参与统计
    if (gap >= 0 && gap < 10 * 60 * 1000) { gaps.push(gap); }
  }
  if (gaps.length === 0) { return; }

  console.log('\n相邻动作间隔（含 agent 思考与客户端处理，ms）');
  console.log('  n=' + gaps.length
    + '  p50=' + Math.round(pct(gaps, 0.5))
    + '  p90=' + Math.round(pct(gaps, 0.9))
    + '  max=' + Math.round(Math.max.apply(null, gaps)));

  const busy = rows.reduce((sum, row) => sum + (typeof row.duration === 'number' ? row.duration : 0), 0);
  const waiting = gaps.reduce((sum, gap) => sum + gap, 0);
  const total = busy + waiting;
  if (total > 0) {
    console.log('\n桥接忙碌 ' + (busy / 1000).toFixed(1) + 's'
      + '，动作之间等待 ' + (waiting / 1000).toFixed(1) + 's'
      + '（桥接占 ' + ((busy / total) * 100).toFixed(1) + '%）');
    console.log('剩下的时间在 agent 那边：模型思考 + 客户端处理。');
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
  if (args.stats) {
    printStats(lines);
    return;
  }
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
