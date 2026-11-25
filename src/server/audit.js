/**
 * Agent Browser Bridge —— 审计日志。
 *
 * 记录"什么时间、谁、对哪个目标、做了什么、结果如何"。
 * 只记动作元数据，绝不记页面内容——日志回答的是"动了什么"，不是"页面上有什么"。
 *
 * 写入是异步的：同一轮事件循环里攒下的行合并成一次 append。以前每条日志要
 * statSync + mkdirSync + appendFileSync 三次同步系统调用，几百 ops/s 时直接把
 * 事件循环堵住；现在热路径只是往数组里 push，落盘在一次异步写里完成，行序由
 * "同一时刻只有一个写入循环"保证。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { argValue, getConfigDir } = require('./config.js');

/** 审计日志文件路径：--log-file 覆盖，否则用配置目录下的 audit.jsonl。 */
const AUDIT_LOG_FILE = argValue('--log-file', null) || path.join(getConfigDir(), 'audit.jsonl');

/** 日志文件大小上限：10MB。超限时轮转一次（audit.jsonl → audit.jsonl.1）。 */
const AUDIT_LOG_CAP = 10 * 1024 * 1024;

/**
 * 不记录审计日志的动作：查询与诊断类，不是"对页面做了什么"。
 * tabs/frames/media 是查询，diag 是扩展自检，都不算用户动作。
 */
const AUDIT_SKIP = new Set(['tabs', 'frames', 'media', 'diag', 'computerWindows']);

/** 待写入的行。合并写入，行序由单一写入循环保证。 */
let pending = [];

/** 文件当前大小。每轮排水前与实际文件对齐一次，批内靠累计。 */
let bytes = 0;

/** 正在进行的写入循环；同一时刻只有一个。 */
let draining = null;

/** 建目录。已存在时忽略。 */
function ensureDir() {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_FILE), { recursive: true });
  } catch (e) {
    // 已存在，或路径不可写（下面 appendFile 会报出来）
  }
}

/** 超过上限就把当前文件轮转成 .1，只保留一份历史。 */
async function rotateIfNeeded(incomingBytes) {
  if (bytes + incomingBytes < AUDIT_LOG_CAP) { return; }

  const rotated = AUDIT_LOG_FILE + '.1';
  try { await fs.promises.unlink(rotated); } catch (e) { /* 不存在则忽略 */ }
  try { await fs.promises.rename(AUDIT_LOG_FILE, rotated); } catch (e) { /* 不存在则忽略 */ }
  bytes = 0;
}

/** 把 pending 里的行写出去；写的过程中新来的行在下一圈继续。 */
async function drain() {
  // 每轮排水前与实际文件对一次大小（异步，一次一批）。文件可能被外部工具或测试
  // 替换/切分，只信内存计数会漏掉轮转时机——这正是原来每条日志 statSync 想解决的。
  try {
    bytes = (await fs.promises.stat(AUDIT_LOG_FILE)).size;
  } catch (e) {
    bytes = 0;
  }

  while (pending.length) {
    const chunk = pending.join('');
    const chunkBytes = Buffer.byteLength(chunk);
    pending = [];
    try {
      ensureDir();
      await rotateIfNeeded(chunkBytes);
      await fs.promises.appendFile(AUDIT_LOG_FILE, chunk, 'utf8');
      bytes += chunkBytes;
    } catch (e) {
      console.error('[audit] 写入失败:', e.message);
      bytes = 0; // 下一次排水会重新 stat，别让计数漂移
    }
  }
}

/**
 * 写一条审计日志。
 * entry: { timestamp, action, target, outcome, duration, caller }
 * 失败时只打 stderr，不影响主功能。
 */
function logAudit(entry) {
  if (AUDIT_SKIP.has(entry.action)) { return; }
  try {
    pending.push(JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[audit] 序列化失败:', e.message);
    return;
  }
  if (!draining) {
    // while 退出与 finally 之间没有 await，新行不可能插进这个窗口
    draining = drain().finally(() => { draining = null; });
  }
}

/**
 * 关闭前把未落盘的行写完。
 * 超时就不等了：退出不能被日志拖住，丢最后几行也好过进程卡死。
 */
async function flushAudit(ms = 2000) {
  if (!draining) { return; }
  await Promise.race([
    draining,
    new Promise((resolve) => { setTimeout(resolve, ms).unref(); })
  ]);
}

module.exports = { logAudit, flushAudit };
