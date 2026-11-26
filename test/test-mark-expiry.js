#!/usr/bin/env node
/**
 * 标记过期测试：页面上的标记 3 分钟后自己消失，扩展里的"已标记"名单必须同步过期。
 *
 * 防的失败（用户实际遇到的）：页面里的标题前缀和图标角点到点自己清了，可扩展的
 * 名单永不过期，弹窗一直显示"已标记标签页: N"，看起来像还有 agent 在操作。
 * 同时验证：显式 mark（ttl=0）不过期；关闭的标签页会被清掉；旧格式（只有 id）
 * 不会被当成有效标记；持续操作时页面角点会在过半时补一次，不会中途消失。
 *
 * 用真实的 marks.js + 替身 chrome，不碰浏览器。
 *
 *   node test-mark-expiry.js
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

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36' },
  configurable: true
});

const MARKS_URL = pathToFileURL(path.join(__dirname, '..', 'extension', 'sw', 'marks.js')).href;
const TTL = 3 * 60 * 1000;

/** 替身 chrome：记录注入、徽标调用、存储内容。 */
function stubChrome(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.store || {});
  const calls = { injects: [], badges: [], saves: 0 };
  let tabs = o.tabs || [];

  const chrome = {
    action: {
      setBadgeText: async (p) => { calls.badges.push({ kind: 'text', text: p.text, tabId: p.tabId }); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async (p) => { calls.badges.push({ kind: 'title', title: p.title, tabId: p.tabId }); },
      getBadgeText: async () => ''
    },
    tabs: {
      query: async () => tabs,
      get: async (id) => tabs.find((t) => t.id === id) || null
    },
    scripting: {
      executeScript: async (opts2) => {
        calls.injects.push({ args: opts2.args, tabId: opts2.target && opts2.target.tabId });
        return [{ result: { ok: true } }];
      }
    },
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          if (typeof key === 'string' && store[key] !== undefined) { out[key] = store[key]; }
          return out;
        },
        set: async (obj) => { calls.saves++; Object.assign(store, obj); },
        remove: async (key) => { delete store[key]; }
      }
    },
    permissions: { contains: async () => true }
  };

  return {
    chrome,
    calls,
    store,
    setTabs: (list) => { tabs = list; }
  };
}

/** 每个场景用新的模块实例（marks.js 里有内存状态）。 */
let seq = 0;
async function fresh(chrome) {
  globalThis.chrome = chrome;
  seq++;
  return import(MARKS_URL + '?v=' + seq);
}

function countFaviconInjects(calls) {
  return calls.injects.filter((c) => c.args && c.args[0] && typeof c.args[0].ttlMs === 'number' && c.args[0].accent).length;
}

(async () => {
  const realNow = Date.now;
  let now = 1700000000000;
  Date.now = () => now;

  try {
    console.log('\n[1] 操作后记录带过期时间');
    {
      const s = stubChrome({ tabs: [{ id: 1, title: 't' }] });
      const marks = await fresh(s.chrome);
      await marks.markTab(1, 'read');
      const saved = s.store['abb-marked-tabs'];
      check('记录里有 id 与过期时间',
        Array.isArray(saved) && saved[0].id === 1 && saved[0].at === now + TTL, JSON.stringify(saved));
      const fav = s.calls.injects.find((c) => c.args[0] && c.args[0].accent);
      check('页面角点拿到同样的有效期', fav && fav.args[0].ttlMs === TTL, fav && JSON.stringify(fav.args[0]));
    }

    console.log('\n[2] 到点后记录与徽标一起清掉，不再注入页面');
    {
      const s = stubChrome({ tabs: [{ id: 1, title: 't' }] });
      const marks = await fresh(s.chrome);
      await marks.markTab(1, 'read');
      const injectsBefore = s.calls.injects.length;

      now += TTL + 1;
      const gone = await marks.pruneMarks();
      check('清掉一个', gone.length === 1 && gone[0] === 1, JSON.stringify(gone));
      check('内存名单空了', marks.markedTabs.size === 0, String(marks.markedTabs.size));
      check('徽标被摘掉', s.calls.badges.some((b) => b.kind === 'text' && b.text === '' && b.tabId === 1));
      check('清理不再往页面注入（页面会自己清）',
        s.calls.injects.length === injectsBefore, `${injectsBefore} -> ${s.calls.injects.length}`);
      check('存储里也空了', (s.store['abb-marked-tabs'] || []).length === 0, JSON.stringify(s.store['abb-marked-tabs']));
    }

    console.log('\n[3] 持续操作会续期，且过半时补一次页面角点');
    {
      const s = stubChrome({ tabs: [{ id: 1, title: 't' }] });
      const marks = await fresh(s.chrome);
      await marks.markTab(1, 'read');
      const firstFav = countFaviconInjects(s.calls);

      now += TTL * 0.6;                    // 过了半程
      await marks.markTab(1, 'type');
      check('过半时补了一次角点', countFaviconInjects(s.calls) === firstFav + 1,
        `${firstFav} -> ${countFaviconInjects(s.calls)}`);
      check('记录续期到最后一刻 + TTL',
        (s.store['abb-marked-tabs'][0] || {}).at === now + TTL, JSON.stringify(s.store['abb-marked-tabs']));

      now += TTL + 1;
      const gone = await marks.pruneMarks();
      check('续期到期后仍然会清', gone.length === 1, JSON.stringify(gone));
    }

    console.log('\n[4] 显式标记（ttl=0）不过期');
    {
      const s = stubChrome({ tabs: [{ id: 5, title: 't', url: 'https://e.test' }] });
      const marks = await fresh(s.chrome);
      const r = await marks.markTask({ tabId: 5, text: '别动这个页面' });
      check('标记成功', r.ok === true, JSON.stringify(r));
      check('记录的过期时间是 0', (s.store['abb-marked-tabs'][0] || {}).at === 0,
        JSON.stringify(s.store['abb-marked-tabs']));

      now += TTL * 10;
      const gone = await marks.pruneMarks();
      check('很久之后仍然在', gone.length === 0 && marks.markedTabs.has(5), JSON.stringify(gone));
    }

    console.log('\n[5] 已关闭的标签页会被清掉');
    {
      const s = stubChrome({ tabs: [{ id: 7, title: 't' }] });
      const marks = await fresh(s.chrome);
      await marks.markTab(7, 'read');
      s.setTabs([]);                       // 标签页被关掉
      const gone = await marks.pruneMarks();
      check('关闭的也在清理范围内', gone.length === 1 && gone[0] === 7, JSON.stringify(gone));
    }

    console.log('\n[6] 旧格式（只有 id）不被当成有效标记');
    {
      const s = stubChrome({ tabs: [{ id: 9, title: 't' }], store: { 'abb-marked-tabs': [9, 10] } });
      const marks = await fresh(s.chrome);
      await marks.loadMarks();
      check('旧记录被丢弃', marks.markedTabs.size === 0, String(marks.markedTabs.size));
    }
  } finally {
    Date.now = realNow;
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
