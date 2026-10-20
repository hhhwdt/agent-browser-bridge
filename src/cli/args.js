/**
 * CLI 参数辅助：取值选项白名单、数字解析与目标校验。
 */

'use strict';

const { CLI_VALUE_OPTS } = require('../actions-registry.js');

/* 不属于任何单个动作的 CLI 级取值选项（可重复的选项在 REPEATABLE_OPTS 里）。 */
const CLI_META_VALUE_OPTS = new Set(['port', 'timeout', 'host', 'out', 'tail', 'file', 'header']);

/**
 * 取值选项 = CLI 级常驻 + 注册表里按动作登记的参数（值可以是别名：
 * 注册表键 idleMs 对应 --idle）。布尔开关不占值，解析器自动处理，
 * 无需在此登记；--其他名字 一律按开关读，老行为不变。
 */
const VALUE_OPTS = new Set(CLI_META_VALUE_OPTS);
for (const [name, flag] of Object.entries(CLI_VALUE_OPTS)) {
  VALUE_OPTS.add(flag === true ? name : flag);
}

function parseArgs(argv) {
  const out = { _: [] };

  // 可重复的选项，重复出现时累加为数组：
  //   --file   upload 传多个文件
  //   --header download 追加多个请求头
  const REPEATABLE_OPTS = new Set(['file', 'header']);

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (VALUE_OPTS.has(key)) {
      if (REPEATABLE_OPTS.has(key)) {
        (out[key] = out[key] || []).push(argv[++i]);
      } else {
        out[key] = argv[++i];
      }
    } else {
      out[key] = true;
    }
  }
  return out;
}

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

module.exports = { VALUE_OPTS, parseArgs, num, requireTarget };
