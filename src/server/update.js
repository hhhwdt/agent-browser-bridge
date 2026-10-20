/**
 * Agent Browser Bridge —— 更新检查。
 *
 * 启动时检查 npm registry 上是否有新版本。
 * Fire-and-forget：不延迟启动，缓存一天，离线时不失败。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { argv, getConfigDir } = require('./config.js');
const { isNewerVersion } = require('../version.js');

const NO_UPDATE_CHECK = argv.includes('--no-update-check');
const UPDATE_CHECK_URL = 'https://registry.npmjs.org/agent-browser-bridge/latest';
const UPDATE_CHECK_CACHE_MS = 24 * 60 * 60 * 1000; // 一天

/** 检查更新，有新版本时打印一行提示。 */
async function checkUpdate() {
  if (NO_UPDATE_CHECK) { return; }
  try {
    const cacheFile = path.join(getConfigDir(), 'update-check.json');
    // 读缓存
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.ts && Date.now() - cached.ts < UPDATE_CHECK_CACHE_MS) {
        if (cached.newer && isNewerVersion(cached.newer, cached.current)) {
          console.log(`[update] 新版本可用: ${cached.newer}（当前 ${cached.current}）`);
        }
        return;
      }
    } catch (e) { /* 缓存不存在或损坏 */ }

    // 发起请求
    const res = await fetch(UPDATE_CHECK_URL, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) { return; }
    const data = await res.json();
    const latest = data.version;
    const current = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;

    // 写缓存
    try {
      fs.mkdirSync(getConfigDir(), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), newer: latest, current }), 'utf8');
    } catch (e) { /* 忽略 */ }

    if (isNewerVersion(latest, current)) {
      console.log(`[update] 新版本可用: ${latest}（当前 ${current}）`);
      console.log('[update] 运行 npm update -g agent-browser-bridge 更新');
    }
  } catch (e) {
    // 离线或网络错误，静默失败
  }
}

module.exports = { checkUpdate };
