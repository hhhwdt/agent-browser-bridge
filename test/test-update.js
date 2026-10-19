#!/usr/bin/env node
/**
 * 更新检查的版本比较测试。
 *
 * 防的失败：版本比较错误导致用户看到错误的更新提示，或者该提示时没提示。
 * 手写 semver 比较（项目零依赖），边界情况容易出错。
 *
 *   node test-update.js
 */

'use strict';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

// 与 cli.js / server.js 相同的比较逻辑
function isNewerVersion(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) { return true; }
    if (na < nb) { return false; }
  }
  return false;
}

(async () => {
  check('1.8.0 > 1.7.1', isNewerVersion('1.8.0', '1.7.1'));
  check('1.7.1 > 1.7.0', isNewerVersion('1.7.1', '1.7.0'));
  check('2.0.0 > 1.9.9', isNewerVersion('2.0.0', '1.9.9'));
  check('1.7.1 不大于 1.7.1', !isNewerVersion('1.7.1', '1.7.1'));
  check('1.7.0 不大于 1.7.1', !isNewerVersion('1.7.0', '1.7.1'));
  check('1.6.9 不大于 1.7.0', !isNewerVersion('1.6.9', '1.7.0'));
  check('1.10.0 > 1.9.0', isNewerVersion('1.10.0', '1.9.0'));
  check('1.0.0 不大于 1.0.0', !isNewerVersion('1.0.0', '1.0.0'));

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
