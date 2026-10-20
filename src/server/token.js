/**
 * Agent Browser Bridge —— 共享 token（桥接与扩展之间的信任边界）。
 *
 * 扩展声明了 127.0.0.1:18777 的 host_permissions，它的请求不带 Origin，
 * 服务端无法区分它和任何本机程序。共享 token 让服务端能验证请求方确实是
 * 持有 token 文件的那个扩展——其他扩展和网页都拿不到这个文件。
 *
 * 不关闭的风险：同机任意程序都能驱动你的浏览器登录态。
 * 不关闭的代价：首次使用需要把 token 粘贴到扩展弹窗里。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { argValue, NO_TOKEN, getConfigDir } = require('./config.js');

/** token 文件路径：--token-file 覆盖，否则用配置目录下的 token。 */
const TOKEN_FILE = argValue('--token-file', null) || path.join(getConfigDir(), 'token');

/**
 * 读取或生成 token。
 * 首次启动时生成 32 字节随机 hex，写入 0600 权限的文件。
 * --no-token 时返回 null，跳过所有校验（仅用于开发调试）。
 */
function loadToken() {
  if (NO_TOKEN) { return null; }
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    // 文件不存在，生成新 token
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    console.log(`[token] 已生成新 token: ${TOKEN_FILE}`);
    console.log('[token] 请把 token 粘贴到扩展弹窗的输入框里');
  } catch (e) {
    console.error(`[token] 无法写入 token 文件: ${e.message}`);
  }
  return token;
}

const TOKEN = loadToken();

/** 校验请求头 X-ABB-Token。TOKEN 为 null 时跳过（--no-token 模式）。 */
function hasValidToken(req) {
  if (!TOKEN) { return true; }
  return req.headers['x-abb-token'] === TOKEN;
}

module.exports = { TOKEN_FILE, TOKEN, hasValidToken };
