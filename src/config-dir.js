/**
 * 每用户配置目录。cli 与 server 共用这个定义。
 */

'use strict';

const path = require('node:path');

/** Windows 用 %APPDATA%，其他用 XDG_CONFIG_HOME 或 ~/.config。 */
function getConfigDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(base, 'agent-browser-bridge');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'agent-browser-bridge');
}

module.exports = { getConfigDir };
