/**
 * Agent Browser Bridge —— 审计日志。
 *
 * 记录"什么时间、谁、对哪个目标、做了什么、结果如何"。
 * 只记动作元数据，绝不记页面内容——日志回答的是"动了什么"，不是"页面上有什么"。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { argValue, getConfigDir } = require('./config.js');

/** 审计日志文件路径：--log-file 覆盖，否则用配置目录下的 audit.jsonl。 */
const AUDIT_LOG_FILE = argValue('--log-file', null) || path.join(getConfigDir(), 'audit.jsonl');

/** 日志文件大小上限：10MB。超限时轮转一次（audit.jsonl → audit.1.jsonl）。 */
const AUDIT_LOG_CAP = 10 * 1024 * 1024;

/**
 * 不记录审计日志的动作：查询与诊断类，不是"对页面做了什么"。
 * tabs/frames/media 是查询，diag 是扩展自检，都不算用户动作。
 */
const AUDIT_SKIP = new Set(['tabs', 'frames', 'media', 'diag']);

/**
 * 写一条审计日志。
 * entry: { timestamp, action, target, outcome, duration, caller }
 * 失败时只打 stderr，不影响主功能。
 */
function logAudit(entry) {
  if (AUDIT_SKIP.has(entry.action)) { return; }
  try {
    const line = JSON.stringify(entry) + '\n';

    // 检查是否需要轮转
    try {
      const stat = fs.statSync(AUDIT_LOG_FILE);
      if (stat.size >= AUDIT_LOG_CAP) {
        const rotated = AUDIT_LOG_FILE + '.1';
        try { fs.unlinkSync(rotated); } catch (e) { /* 不存在则忽略 */ }
        fs.renameSync(AUDIT_LOG_FILE, rotated);
      }
    } catch (e) {
      // 文件不存在，无需轮转
    }

    // 目录可能不存在（--log-file 自定义路径、新机器首次使用）——appendFile 不会自动建
    try {
      fs.mkdirSync(path.dirname(AUDIT_LOG_FILE), { recursive: true });
    } catch (e) {
      // 已存在则忽略
    }

    fs.appendFileSync(AUDIT_LOG_FILE, line, 'utf8');
  } catch (e) {
    console.error('[audit] 写入失败:', e.message);
  }
}

module.exports = { logAudit };
