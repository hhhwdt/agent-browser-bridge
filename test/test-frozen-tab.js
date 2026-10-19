#!/usr/bin/env node
/**
 * 冻结标签页恢复测试：验证 tabUnresponsive 的 hint 指明下一步（activate 然后重试）。
 *
 * 防的失败：冻结标签页的报错没有指明下一步，用户不知道该先 activate 再重试，
 * 只能手动去浏览器里点标签页唤醒——违背了"后台操作"的初衷。
 *
 *   node test-frozen-tab.js
 */

'use strict';

const { extractFunction } = require('./sw-source.js');

const found = extractFunction('tabUnresponsive');
if (!found) {
  console.error('在 extension/sw/ 里找不到 tabUnresponsive，测试无法进行');
  process.exit(1);
}
const tabUnresponsive = new Function('return ' + found.src)();

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

(async () => {
  // 超时错误：hint 应包含 activate 指引
  const r1 = tabUnresponsive(new Error('operation timeout 12000ms'), 123);
  check('超时错误返回 tab_unresponsive', r1.error === 'tab_unresponsive');
  check('hint 包含 activate 字样', r1.hint && r1.hint.includes('activate'),
    `hint=${r1.hint}`);
  check('hint 包含"重试"字样', r1.hint && r1.hint.includes('重试'),
    `hint=${r1.hint}`);

  // 非超时错误：hint 应为 undefined
  const r2 = tabUnresponsive(new Error('some other error'), 456);
  check('非超时错误返回 inject_failed', r2.error === 'inject_failed');
  check('非超时错误无 hint', r2.hint === undefined);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
