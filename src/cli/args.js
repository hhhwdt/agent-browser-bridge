/**
 * CLI 参数辅助：数字解析与目标校验。
 */

'use strict';

/** string -> number；空与非法值返回 undefined。 */
function num(v) {
  if (v === undefined || v === null || v === '') { return undefined; }
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** 标签页定位三选一校验，缺失即退出。 */
function requireTarget(args) {
  if (!args.match && !args.url && args.tabId === undefined) {
    console.error('需要 --match、--url 或 --tabId 之一来定位标签页');
    process.exit(1);
  }
}

module.exports = { num, requireTarget };
