#!/usr/bin/env node
/**
 * 自动配对测试：向本机宿主要 token，用户零输入。
 *
 * 防的失败：
 *   - 装完看起来全绿，所有动作报 extension_not_connected（token 没人填）
 *   - 宿主没装（开发者手动加载扩展）时配对把启动流程拖死或抛错
 *   - token 被服务端拒绝后无限重配，把日志刷满
 *
 * 用真实的 pair.js + 替身 chrome，不碰浏览器、不需要浏览器宿主。
 *
 *   node test-pair.js
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

// config.js 在导入时读 navigator
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36' },
  configurable: true
});

const PAIR_URL = pathToFileURL(path.join(__dirname, '..', 'extension', 'sw', 'pair.js')).href;

/**
 * 造一个替身 chrome。hostToken 为 null 表示宿主没装（没有 sendNativeMessage）。
 * 返回一个记录调用次数的对象。
 */
function stubChrome(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.store || {});
  const calls = { host: 0, set: 0, removed: 0 };
  const chrome = {
    runtime: {},
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          if (typeof key === 'string') { out[key] = store[key]; }
          return out;
        },
        set: async (obj) => { calls.set++; Object.assign(store, obj); },
        remove: async (key) => { calls.removed++; delete store[key]; }
      }
    }
  };
  if (o.hostInstalled !== false) {
    chrome.runtime.sendNativeMessage = (name, msg, cb) => {
      calls.host++;
      if (o.hostDelayMs) {
        setTimeout(() => cb(o.hostReply === undefined ? { token: o.token } : o.hostReply), o.hostDelayMs);
        return;
      }
      cb(o.hostReply === undefined ? { token: o.token } : o.hostReply);
    };
    // lastError 在正常路径下是 undefined
    chrome.runtime.lastError = undefined;
  }
  return { chrome, store, calls };
}

/** 每个场景用新的模块实例（pair.js 里有"每个 SW 只强制配一次"的状态）。 */
let moduleSeq = 0;
async function freshPair(chrome) {
  globalThis.chrome = chrome;
  moduleSeq++;
  return import(PAIR_URL + '?v=' + moduleSeq);
}

(async () => {
  console.log('\n[1] 没有 token：向宿主要一份并存起来');
  {
    const s = stubChrome({ token: 'tok-from-host' });
    const pair = await freshPair(s.chrome);
    const ok = await pair.pairIfNeeded();
    check('配对成功', ok === true, String(ok));
    check('token 落进 storage', s.store['abb-token'] === 'tok-from-host', JSON.stringify(s.store));
    check('问了宿主一次', s.calls.host === 1, `问了 ${s.calls.host} 次`);
  }

  console.log('\n[2] 已有 token：不再打扰宿主');
  {
    const s = stubChrome({ store: { 'abb-token': 'already' }, token: 'new' });
    const pair = await freshPair(s.chrome);
    const ok = await pair.pairIfNeeded();
    check('返回已有', ok === true);
    check('没有问宿主', s.calls.host === 0, `问了 ${s.calls.host} 次`);
    check('旧值没被覆盖', s.store['abb-token'] === 'already', JSON.stringify(s.store));
  }

  console.log('\n[3] 宿主没装：静默失败，不抛错');
  {
    const s = stubChrome({ hostInstalled: false });
    const pair = await freshPair(s.chrome);
    let threw = null;
    let ok = null;
    try { ok = await pair.pairIfNeeded(); } catch (e) { threw = e; }
    check('不抛错', threw === null, threw && threw.message);
    check('返回 false', ok === false, String(ok));
    check('没有写入 token', s.store['abb-token'] === undefined, JSON.stringify(s.store));
  }

  console.log('\n[4] 宿主返回空：不写脏值');
  {
    const s = stubChrome({ hostReply: {} });
    const pair = await freshPair(s.chrome);
    const ok = await pair.pairIfNeeded();
    check('返回 false', ok === false, String(ok));
    check('没有写入 token', s.store['abb-token'] === undefined, JSON.stringify(s.store));
  }

  console.log('\n[5] 401 后重配：清旧值、拿新值');
  {
    const s = stubChrome({ store: { 'abb-token': 'stale' }, token: 'fresh' });
    const pair = await freshPair(s.chrome);
    const ok = await pair.repairAfterRejected();
    check('重配成功', ok === true, String(ok));
    check('token 已更新', s.store['abb-token'] === 'fresh', JSON.stringify(s.store));
    check('清过一次旧值', s.calls.removed === 1, `清了 ${s.calls.removed} 次`);
  }

  console.log('\n[6] 同一个 SW 生命周期里只强制重配一次');
  {
    const s = stubChrome({ store: { 'abb-token': 'stale' }, token: 'fresh' });
    const pair = await freshPair(s.chrome);
    await pair.repairAfterRejected();
    const second = await pair.repairAfterRejected();
    check('第二次不再问宿主', second === false, String(second));
    check('宿主只被问了一次', s.calls.host === 1, `问了 ${s.calls.host} 次`);
  }

  console.log('\n[7] 读已有 token');
  {
    const s = stubChrome({ store: { 'abb-token': 'abc' } });
    const pair = await freshPair(s.chrome);
    check('读得出来', (await pair.readStoredToken()) === 'abc');
    const s2 = stubChrome({});
    const pair2 = await freshPair(s2.chrome);
    check('没有时返回空字符串', (await pair2.readStoredToken()) === '');
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
