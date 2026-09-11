#!/usr/bin/env node
/**
 * eval 的语义测试：从 extension/sw/ 里抽出真实的 evalInPage 源码，在 Node 里用假 document 驱动。
 *
 * 抽真源码而不是抄一份逻辑，是为了让测试跟着实现走——抄一份的话，实现改了测试还在验旧行为。
 *
 * 覆盖的核心是"代码只执行一次"：曾经的实现在拿不到返回值时会再跑一遍，
 * 于是任何没写 return 的语句（例如 document.querySelector('#x').click()）都会执行两次。
 * 对一个能点按钮、能提交表单的工具，点两次就是事故。
 *
 *   node test-eval.js
 */

'use strict';

const { extractFunction } = require('./sw-source.js');

const found = extractFunction('evalInPage');
if (!found) {
  console.error('在 extension/sw/ 里找不到 evalInPage，测试无法进行');
  process.exit(1);
}
const evalInPage = new Function('return ' + found.src)();

let clicks = 0;
const btn = { click: () => { clicks++; return 'clicked'; } };
globalThis.document = {
  title: 'T',
  querySelector: () => btn
};

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}${detail === undefined ? '' : '  ' + detail}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : detail}`);
  }
}

const cases = [
  // 无 return 的语句：副作用只能发生一次，值取自语句完成值
  { name: '无 return 的单条语句', code: 'document.querySelector("#del").click()', expectClicks: 1 },
  { name: '无 return 的多条语句', code: 'const b = document.querySelector("#del"); b.click()', expectClicks: 1 },
  { name: 'return 风格的副作用', code: 'return document.querySelector("#del").click()', expectClicks: 1 },
  // 取值：裸表达式、尾分号、字符串里恰好含 return 字样
  { name: '裸表达式取值', code: 'document.title', expectClicks: 0, expectValue: 'T' },
  { name: '带尾分号的表达式', code: 'document.title;', expectClicks: 0, expectValue: 'T' },
  { name: '字符串里含 return 字样的表达式', code: '"a return b".toUpperCase()', expectClicks: 0, expectValue: 'A RETURN B' },
  { name: 'return undefined', code: 'return undefined', expectClicks: 0, expectValue: null },
  { name: '返回 Promise 会 await', code: 'return Promise.resolve(42)', expectClicks: 0, expectValue: 42 }
];

(async () => {
  for (const c of cases) {
    clicks = 0;
    const r = await evalInPage(c.code);
    const okClicks = c.expectClicks === undefined || clicks === c.expectClicks;
    const okValue = c.expectValue === undefined || JSON.stringify(r.value) === JSON.stringify(c.expectValue);
    check(c.name, r.ok && okClicks && okValue,
      `执行 ${clicks} 次（期望 ${c.expectClicks}），value=${JSON.stringify(r.value)}`
      + `${r.evalError ? ' err=' + r.evalError : ''}`);
  }

  // 语法错误：必须报错，且因为一行都没执行过，不能留下副作用
  clicks = 0;
  const bad = await evalInPage('return (');
  check('语法错误返回 evalError', !bad.ok && !!bad.evalError,
    bad.evalError ? bad.evalError.slice(0, 60) : JSON.stringify(bad));
  check('语法错误没有产生副作用', clicks === 0, `执行 ${clicks} 次`);

  // 运行期异常：副作用已经发生一次，不能因为报错再重跑
  clicks = 0;
  const boom = await evalInPage('document.querySelector("#del").click(); throw new Error("boom")');
  check('运行期异常只执行一次后报错', !boom.ok && clicks === 1, `执行 ${clicks} 次`);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
