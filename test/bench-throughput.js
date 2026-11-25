#!/usr/bin/env node
/**
 * 吞吐基准：串行 / 同标签页并发 / 多标签页并发，各测一遍。
 *
 * 这不是断言套件，不进 test-offline.js，也不该进 CI——它需要一个正在运行的桥接
 * 和一个连着扩展的浏览器。它存在的理由是让"优化了"有数字可对比：
 *
 *   node test/bench-throughput.js                 # 默认 8 个标签页、3 轮
 *   node test/bench-throughput.js --tabs 4 --rounds 5
 *
 * 只在桥接自己的地址上开后台标签页（该 origin 天然已授权，不需要授权提示），
 * 跑完把每一个都关掉。
 *
 * 参考数字（2026-11，本机 Windows/Edge，本地页面所以没有网络延迟，属于最好情况）：
 *
 *   场景                    标记节流 + 异步审计之前      之后
 *   eval 串行               13.0 ms/次（77 ops/s）       3.5 ms/次（285 ops/s）
 *   eval 同标签页并发 10    —（175 ops/s）              1030 ops/s
 *   eval 8 标签页并发       270 ops/s                    1034 ops/s
 *   tabs 串行（地板）       1.6 ms/次                    1.7 ms/次
 *
 * 串行那行测的是"已标记过的标签页"的稳态：第一个动作仍然要打全套标记，这是设计。
 */

'use strict';

const path = require('node:path');
const { createClient } = require(path.join(__dirname, '..', 'src', 'client.js'));

const argv = process.argv.slice(2);
function argNum(flag, fallback) {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? parseInt(argv[i + 1], 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const TABS = argNum('--tabs', 8);
const ROUNDS = argNum('--rounds', 3);
const SERIAL = argNum('--serial', 20);
const PAGE = 'http://127.0.0.1:18777/health';
const CODE = 'return 1';

const ab = createClient();
const ms = () => Number(process.hrtime.bigint()) / 1e6;
const r1 = (n) => Math.round(n * 10) / 10;

(async () => {
  const tabs = [];
  try {
    const first = await ab.navigate({ url: PAGE, newTab: true });
    tabs.push(first.tabId);
    for (let i = 0; i < 3; i++) { await ab.evalPage({ tabId: first.tabId, code: CODE }); }

    // 地板：只查标签页，不注入、不打标记
    let t = ms();
    for (let i = 0; i < SERIAL; i++) { await ab.action('tabs'); }
    const floor = ms() - t;

    // 串行
    const each = [];
    t = ms();
    for (let i = 0; i < SERIAL; i++) {
      const a = ms();
      await ab.evalPage({ tabId: first.tabId, code: CODE });
      each.push(ms() - a);
    }
    const serial = ms() - t;

    // 同一标签页并发
    t = ms();
    await Promise.all(Array.from({ length: 10 }, () => ab.evalPage({ tabId: first.tabId, code: CODE })));
    const sameTab = ms() - t;

    // 多标签页并发
    for (let i = 1; i < TABS; i++) {
      const n = await ab.navigate({ url: PAGE + '?bench=' + i, newTab: true });
      tabs.push(n.tabId);
    }
    t = ms();
    let ops = 0;
    for (let r = 0; r < ROUNDS; r++) {
      await Promise.all(tabs.map((id) => ab.evalPage({ tabId: id, code: CODE })));
      ops += tabs.length;
    }
    const multi = ms() - t;

    // 读取一次，看载荷成本
    t = ms();
    const rd = await ab.read({ tabId: tabs[0] });
    const readMs = ms() - t;

    const sorted = each.slice().sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

    console.log('\n吞吐基准（本地页面，无网络延迟）');
    console.log('  tabs 串行 %s 次         : 均值 %s ms → %s ops/s', SERIAL, r1(floor / SERIAL), r1((SERIAL * 1000) / floor));
    console.log('  eval 串行 %s 次         : 均值 %s ms，p50 %s，p90 %s → %s ops/s',
      SERIAL, r1(serial / SERIAL), r1(pct(0.5)), r1(pct(0.9)), r1((SERIAL * 1000) / serial));
    console.log('  eval 同标签页并发 10    : %s ms → %s ops/s', r1(sameTab), r1(10000 / sameTab));
    console.log('  eval %s 标签页 × %s 轮 : %s 次 %s ms → %s ops/s',
      TABS, ROUNDS, ops, r1(multi), r1((ops * 1000) / multi));
    console.log('  read 一次               : %s ms，正文 %s 字符', r1(readMs), rd.text ? rd.text.length : 0);
  } finally {
    for (const id of tabs) {
      try { await ab.close({ tabId: id }); } catch (e) { /* 已关闭 */ }
    }
    console.log('\n已关闭 %s 个临时标签页', tabs.length);
  }
})().catch((e) => {
  console.error('基准失败:', e && e.message ? e.message : e);
  process.exit(1);
});
