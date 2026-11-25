#!/usr/bin/env node
/**
 * 标记节流测试：同一个标签页上的连续动作，只打一次页面内标记。
 *
 * 防的失败：每个动作都给页面注入两次脚本（图标角点 + 浮层）。这两次注入对用户
 * 可见性没有增量——徽标、标题前缀、角点都还在——却让每个动作多两次往返。批量
 * 抓取时单次 eval 的耗时因此翻倍。节流之后仍然是"没有静默模式"：第一次操作就
 * 打全套标记，只是不再每个动作重画一遍。
 *
 * 用真实的 marks.js + 替身 chrome，不碰浏览器。
 *
 *   node test-mark-throttle.js
 */

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

// 计数：页面注入、徽标/标题接口、落盘
let injects = 0;
let badgeCalls = 0;
let saves = 0;

globalThis.chrome = {
  action: {
    setBadgeText: async () => { badgeCalls++; },
    setBadgeBackgroundColor: async () => { badgeCalls++; },
    setTitle: async () => { badgeCalls++; },
    getBadgeText: async () => ''
  },
  scripting: {
    executeScript: async () => { injects++; return [{ result: { ok: true } }]; }
  },
  storage: {
    local: { get: async () => ({}), set: async () => { saves++; } }
  },
  tabs: { query: async () => [] }
};

// config.js 在导入时读 navigator；Node 自带的 navigator 是只读 getter
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36' },
  configurable: true
});

function reset() { injects = 0; badgeCalls = 0; saves = 0; }

(async () => {
  const marks = await import(pathToFileURL(path.join(__dirname, '..', 'extension', 'sw', 'marks.js')).href);

  // 可控时钟
  const realNow = Date.now;
  let now = 1700000000000;
  Date.now = () => now;

  console.log('\n[1] 首次操作某个标签页');
  reset();
  await marks.markTab(11, 'read');
  check('页面内注入两次（角点 + 浮层）', injects === 2, `注入 ${injects} 次`);
  check('徽标三条接口都调用', badgeCalls === 3, `调用 ${badgeCalls} 次`);
  check('标记落盘一次', saves === 1, `落盘 ${saves} 次`);

  console.log('\n[2] 同一标签页紧接着再来两个动作');
  reset();
  now += 300;
  await marks.markTab(11, 'click');
  now += 300;
  await marks.markTab(11, 'type');
  check('不再注入页面内标记', injects === 0, `注入 ${injects} 次`);
  check('徽标仍在更新，用户能看到最后一次动作', badgeCalls === 6, `调用 ${badgeCalls} 次`);
  check('状态没变，不重复落盘', saves === 0, `落盘 ${saves} 次`);

  console.log('\n[3] 超过刷新间隔后，浮层要重新出现');
  reset();
  now += 5000;
  await marks.markTab(11, 'read');
  check('只注入浮层这一次', injects === 1, `注入 ${injects} 次`);
  check('刷新后不重复落盘', saves === 0, `落盘 ${saves} 次`);

  console.log('\n[4] 清除标记后，下一次动作重新打全套');
  reset();
  await marks.removeBadge(11);        // 清除角点：注入一次
  check('清除时注入一次（恢复站点图标）', injects === 1, `注入 ${injects} 次`);
  reset();
  now += 100;
  await marks.markTab(11, 'read');
  check('重新全量标记', injects === 2, `注入 ${injects} 次`);
  check('并重新落盘', saves === 1, `落盘 ${saves} 次`);

  console.log('\n[5] 另一个标签页不受影响');
  reset();
  await marks.markTab(12, 'read');
  check('新标签页照常全量标记', injects === 2, `注入 ${injects} 次`);

  Date.now = realNow;
  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
