#!/usr/bin/env node
/**
 * wait 的条件语义测试：从 extension/sw/ 里抽出真实的 waitInPage 源码，在 Node 里用假 DOM + 假时钟驱动。
 *
 * 抽真源码而不是抄一份逻辑，是为了让测试跟着实现走——抄一份的话，实现改了测试还在验旧行为。
 *
 * 防的失败：等待条件不成立却被报为已成立。对一个"等异步 UI 刷新后再操作"的动作，
 * 误报成立意味着下一步在页面还没准备好的时候就执行了——轻则拿到旧数据，重则点错元素。
 * 每种条件都要断言两条路径：成立时返回 ok:true，不成立时返回 wait_timeout。
 *
 *   node test-wait.js
 */

'use strict';

const { extractFunction } = require('./sw-source.js');

const found = extractFunction('waitInPage');
if (!found) {
  console.error('在 extension/sw/ 里找不到 waitInPage，测试无法进行');
  process.exit(1);
}
const waitInPage = new Function('return ' + found.src)();

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

/**
 * 装一套假 DOM + 假时钟。
 * opts:
 *   selectorMatched  querySelector 是否命中
 *   count            querySelectorAll 返回的 length
 *   bodyText         body.innerText
 *   href             location.href
 *   resourceCount    performance.getEntriesByType 返回的数组长度
 */
function installFakeDom(opts) {
  const o = Object.assign({
    selectorMatched: false,
    count: 0,
    bodyText: '',
    href: 'http://example.com/',
    resourceCount: 0,
    growResources: false
  }, opts);

  const fakeEl = {
    getBoundingClientRect: () => ({ width: 100, height: 50 })
  };

  globalThis.window = { top: null }; // isMainFrame 检测：window === window.top 为 true
  globalThis.document = {
    querySelector: (sel) => (o.selectorMatched ? fakeEl : null),
    querySelectorAll: () => ({ length: o.count }),
    body: { innerText: o.bodyText }
  };
  globalThis.location = { href: o.href };
  let resourceCounter = o.resourceCount;
  globalThis.performance = {
    getEntriesByType: () => {
      // growResources 时每次调用返回递增长度，模拟资源一直在加载
      if (o.growResources) { resourceCounter++; }
      return new Array(resourceCounter);
    }
  };

  // 假时钟：setTimeout 同步推进时间，让 poll 循环在微任务里跑完
  let now = 0;
  globalThis.Date.now = () => now;
  globalThis.setTimeout = (fn, ms) => { now += ms; if (fn) { fn(); } return 0; };

  /** 改变资源数量，用于 idle 条件"资源增长后重新计时"的场景。 */
  return {
    setResourceCount(n) { o.resourceCount = n; },
    get now() { return now; }
  };
}

(async () => {
  /* ---------- selector 条件 ---------- */
  installFakeDom({ selectorMatched: true });
  let r = await waitInPage({ selector: '#btn', timeoutMs: 1000, pollMs: 100 });
  check('selector 成立时返回 ok', r.ok === true && r.satisfied === true,
    `ok=${r.ok} error=${r.error}`);

  installFakeDom({ selectorMatched: false });
  r = await waitInPage({ selector: '#btn', timeoutMs: 1000, pollMs: 100 });
  check('selector 不成立时返回 wait_timeout',
    r.ok === false && r.error === 'wait_timeout' && r.timeoutMs === 1000,
    `ok=${r.ok} error=${r.error}`);

  /* ---------- selector + disappear ---------- */
  installFakeDom({ selectorMatched: false });
  r = await waitInPage({ selector: '#spin', state: 'disappear', timeoutMs: 1000, pollMs: 100 });
  check('disappear：元素不存在时返回 ok', r.ok === true && r.state === 'disappear',
    `ok=${r.ok} error=${r.error}`);

  installFakeDom({ selectorMatched: true });
  r = await waitInPage({ selector: '#spin', state: 'disappear', timeoutMs: 1000, pollMs: 100 });
  check('disappear：元素仍存在时返回 wait_timeout',
    r.ok === false && r.error === 'wait_timeout',
    `ok=${r.ok} error=${r.error}`);

  /* ---------- text 条件 ---------- */
  installFakeDom({ bodyText: '保存成功' });
  r = await waitInPage({ text: '保存成功', timeoutMs: 1000, pollMs: 100 });
  check('text 成立时返回 ok', r.ok === true, `ok=${r.ok} error=${r.error}`);

  installFakeDom({ bodyText: '正在保存…' });
  r = await waitInPage({ text: '保存成功', timeoutMs: 1000, pollMs: 100 });
  check('text 不成立时返回 wait_timeout', r.ok === false && r.error === 'wait_timeout',
    `ok=${r.ok} error=${r.error}`);

  /* ---------- url 条件 ---------- */
  installFakeDom({ href: 'https://confluence.example.com/pages/123' });
  r = await waitInPage({ url: '/pages/', timeoutMs: 1000, pollMs: 100 });
  check('url 成立时返回 ok', r.ok === true, `ok=${r.ok} error=${r.error}`);

  installFakeDom({ href: 'https://confluence.example.com/pages/123' });
  r = await waitInPage({ url: '/spaces/', timeoutMs: 1000, pollMs: 100 });
  check('url 不成立时返回 wait_timeout', r.ok === false && r.error === 'wait_timeout',
    `ok=${r.ok} error=${r.error}`);

  /* ---------- count 条件 ---------- */
  installFakeDom({ selectorMatched: true, count: 5 });
  r = await waitInPage({ selector: '.item', count: 3, timeoutMs: 1000, pollMs: 100 });
  check('count 达标时返回 ok', r.ok === true, `ok=${r.ok} error=${r.error}`);

  installFakeDom({ selectorMatched: true, count: 2 });
  r = await waitInPage({ selector: '.item', count: 3, timeoutMs: 1000, pollMs: 100 });
  check('count 未达标时返回 wait_timeout', r.ok === false && r.error === 'wait_timeout',
    `ok=${r.ok} error=${r.error}`);

  installFakeDom({ selectorMatched: false, count: 0 });
  r = await waitInPage({ selector: '.item', count: 1, timeoutMs: 1000, pollMs: 100 });
  check('count 无 selector 时永远不成立', r.ok === false && r.error === 'wait_timeout',
    `ok=${r.ok} error=${r.error}`);

  /* ---------- idle 条件 ---------- */
  // 资源数从不变：第一次检查记录时间，之后每轮 pollMs，累计超过 idleMs 后成立
  installFakeDom({ resourceCount: 10 });
  r = await waitInPage({ idleMs: 500, timeoutMs: 5000, pollMs: 200 });
  check('idle 稳定后返回 ok', r.ok === true, `ok=${r.ok} error=${r.error} elapsed=${r.elapsedMs}`);

  // 资源数一直增长：每次检查都重置 idle 计时器，永远不成立
  installFakeDom({ resourceCount: 10, growResources: true });
  r = await waitInPage({ idleMs: 500, timeoutMs: 2000, pollMs: 200 });
  check('idle 持续增长时返回 wait_timeout', r.ok === false && r.error === 'wait_timeout',
    `ok=${r.ok} error=${r.error}`);

  /* ---------- 组合条件：selector + url 同时满足才成立 ---------- */
  installFakeDom({ selectorMatched: true, href: 'https://example.com/done' });
  r = await waitInPage({ selector: '.ok', url: '/done', timeoutMs: 1000, pollMs: 100 });
  check('组合条件都满足时返回 ok', r.ok === true, `ok=${r.ok} error=${r.error}`);

  installFakeDom({ selectorMatched: true, href: 'https://example.com/loading' });
  r = await waitInPage({ selector: '.ok', url: '/done', timeoutMs: 1000, pollMs: 100 });
  check('组合条件其一不满足时返回 wait_timeout',
    r.ok === false && r.error === 'wait_timeout',
    `ok=${r.ok} error=${r.error}`);

  /* ---------- elapsedMs 与超时字段 ---------- */
  installFakeDom({ selectorMatched: false });
  r = await waitInPage({ selector: '#btn', timeoutMs: 1500, pollMs: 300 });
  check('超时返回 elapsedMs 与 timeoutMs',
    r.ok === false && typeof r.elapsedMs === 'number' && r.timeoutMs === 1500,
    `elapsedMs=${r.elapsedMs} timeoutMs=${r.timeoutMs}`);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
