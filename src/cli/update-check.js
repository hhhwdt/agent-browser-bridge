/**
 * CLI 的更新检查。与 server 端的 src/server/update.js 行为不同：
 * 这里没有缓存、没有 --no-update-check——cli 是短命进程，每次现查。
 */

'use strict';

const { isNewerVersion } = require('../version.js');

/** 检查 npm registry 上是否有新版本，有新版本时打印一行提示。 */
async function checkUpdate() {
  try {
    const res = await fetch('https://registry.npmjs.org/@hhhwdt%2fagent-browser-bridge/latest', {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) { return; }
    const data = await res.json();
    const latest = data.version;
    const current = require('../../package.json').version;
    if (isNewerVersion(latest, current)) {
      console.log(`[update] 新版本可用: ${latest}（当前 ${current}）`);
    }
  } catch (e) {
    // 离线或网络错误，静默失败
  }
}

module.exports = { checkUpdate };
