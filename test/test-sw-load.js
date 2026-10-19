#!/usr/bin/env node
/**
 * 服务脚本模块图的加载测试：用替身 chrome 把 extension/sw/ 整张图跑一遍。
 *
 * 为什么需要它：MV3 的服务脚本被回收后会重新加载，而**加载失败在浏览器里只表现为
 * "扩展不再轮询"**——没有报错弹窗、没有日志，工具侧看到的只是 extension_not_connected。
 * 这类问题（语法错、缺失的导出、循环依赖、顶层就抛错）在 CI 里应该当场暴露，
 * 而不是等到用户发现浏览器里的扩展"没反应"。
 *
 * 顺带逐个模块断言关键导出还在——拆分时把函数落下的情况，这里会报出来。
 *
 *   node test-sw-load.js
 */

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SW_DIR = path.join(__dirname, '..', 'extension', 'sw');
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : detail}`); }
}

/**
 * 启动侧副作用的计数。加载一次模块图，下面每个计数都应当恰好是 1：
 * 多出来的那一次就是重复注册——曾经 background.js 把整段启动块写了两遍，
 * 结果 diag 报的"SW 启动次数"翻倍，而那个数字正是判断服务脚本是否被频繁回收的依据。
 */
const boot = { alarms: [], startup: 0, installed: 0, bootWrites: 0 };

/** 替身 chrome：只要求"被调用时不炸"，不模拟行为。 */
function stubGlobals() {
  const noop = () => {};
  const never = () => new Promise(() => {});
  const listeners = { addListener: noop, removeListener: noop, hasListener: () => false };
  const countListener = (key) => ({
    addListener: () => { boot[key] += 1; },
    removeListener: noop,
    hasListener: () => false
  });

  globalThis.chrome = {
    runtime: {
      id: 'stub-extension-id',
      getManifest: () => ({ version: '0.0.0-test' }),
      reload: noop,
      onMessage: listeners,
      onStartup: countListener('startup'),
      onInstalled: countListener('installed')
    },
    storage: {
      local: {
        get: async () => ({}),
        // 启动计数写在 abb-boot 这个键上，按写入次数就能看出 bootstrap 跑了几遍
        set: async (obj) => { if (obj && obj['abb-boot']) { boot.bootWrites += 1; } }
      },
      session: { get: async () => ({}), set: async () => {} }
    },
    alarms: {
      get: async () => null,
      create: (name) => { boot.alarms.push(name); },
      onAlarm: listeners
    },
    tabs: {
      query: async () => [],
      get: async () => null,
      update: async () => {},
      create: async () => ({ id: 1 }),
      remove: async () => {},
      onRemoved: listeners
    },
    scripting: { executeScript: async () => [] },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
      getBadgeText: async () => ''
    },
    permissions: {
      contains: async () => true,
      getAll: async () => ({ permissions: [], origins: [] }),
      request: async () => true,
      remove: async () => true
    },
    cookies: { getAll: async () => [] },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => {}, onEvent: listeners },
    downloads: { download: async () => 1, search: async () => [], onCreated: listeners }
  };
  // Node 自带的 navigator 是只读 getter，只能 defineProperty 覆盖
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36' },
    configurable: true
  });
  Object.defineProperty(globalThis, 'self', {
    value: { addEventListener: noop },
    configurable: true
  });
  // bootstrap 会在加载时启动轮询；让 fetch 永远挂着，测试才能干净退出
  globalThis.fetch = never;
}

/** 各模块必须提供的导出（少一个都说明拆错了）。 */
const EXPECTED = {
  'config.js': ['BRIDGE_URL', 'BROWSER_NAME', 'POLL_TIMEOUT_MS', 'RETRY_DELAY_MS', 'KEEPALIVE_ALARM'],
  'injected.js': [
    'extractInPage', 'clickInPage', 'linksInPage', 'typeInPage', 'keyInPage', 'indicatorInPage',
    'diagInPage', 'waitInPage', 'tabMarkInPage', 'mediaInPage', 'readStorageInPage', 'evalInPage',
    'rectInPage', 'fetchInPage', 'markdownInPage'
  ],
  'guards.js': ['withTimeout', 'tabUnresponsive', 'injectAndPick', 'injectInBestFrame', 'resolveTab', 'ensureInjectable'],
  // applyBadge 只在本模块内部用，刻意不导出
  'marks.js': ['loadMarks', 'saveMarks', 'removeBadge', 'markTab', 'markTask', 'unmarkTask', 'collectMarkedTabs'],
  'actions.js': [
    'listTabs', 'readTab', 'linksTab', 'clickTab', 'typeTab', 'keyTab', 'navigateTab', 'waitTab',
    'screenshotTab', 'evalTab', 'sessionTab', 'uploadTab', 'downloadTab', 'saveTab', 'grabTab',
    'mediaTab', 'framesDiag', 'activateTab'
  ]
};

(async () => {
  stubGlobals();

  console.log('\n[1] 入口模块图能否加载');
  const entry = pathToFileURL(path.join(SW_DIR, 'background.js')).href;
  try {
    await import(entry);
    check('background.js 及其依赖全部加载成功', true);
  } catch (e) {
    check('background.js 及其依赖全部加载成功', false, (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
    console.log(`\n通过 ${pass}，失败 ${fail}`);
    process.exit(1);
  }

  console.log('\n[2] 各模块的关键导出');
  for (const [file, names] of Object.entries(EXPECTED)) {
    let mod = null;
    try {
      mod = await import(pathToFileURL(path.join(SW_DIR, file)).href);
    } catch (e) {
      check(`${file} 可加载`, false, e.message);
      continue;
    }
    const missing = names.filter((n) => mod[n] === undefined);
    check(`${file} 导出完整（${names.length} 项）`, missing.length === 0, '缺少: ' + missing.join(', '));
  }

  console.log('\n[3] 启动只发生一次');
  // bumpBootCount / loadMarks 都是异步写入，等一轮微任务再断言
  await new Promise((r) => setTimeout(r, 0));
  check('启动计数只写一次 abb-boot', boot.bootWrites === 1, `实际 ${boot.bootWrites} 次`);
  check('保活闹钟只创建一次',
    boot.alarms.filter((n) => n === 'abb-keepalive').length === 1,
    JSON.stringify(boot.alarms));
  check('onStartup / onInstalled 各只注册一次',
    boot.startup === 1 && boot.installed === 1,
    `startup=${boot.startup} installed=${boot.installed}`);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
