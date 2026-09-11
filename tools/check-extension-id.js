#!/usr/bin/env node
/**
 * 校验扩展 ID 三处一致：manifest.json 的 key、由该公钥推导出的 ID、server.js 里的允许列表常量。
 *
 * 换了 key、或者改了允许列表之后跑一次。三处对不上时不会立刻出事——
 * 真扩展的请求不带 Origin，压根不走这个校验——但"服务端以为自己在放行谁"和
 * "扩展实际是谁"会脱节，等到有人排查时才发现。纯离线，不需要浏览器。
 *
 *   node check-extension-id.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** Chrome 的扩展 ID 算法：sha256(DER/SPKI 公钥) 取前 16 字节，每个 nibble 映射到 a-p。 */
function extensionIdFromDer(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return hex.split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const root = path.join(__dirname, '..');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
} catch (e) {
  console.error('读不到 extension/manifest.json：' + e.message);
  process.exit(1);
}

if (!manifest.key) {
  console.error('manifest.json 里没有 key。没有 key 时扩展 ID 由安装路径决定，每台机器都不同，');
  console.error('换目录就会变，站点授权随之失效。要固定 ID 就得补上 key（见 README 的说明）。');
  process.exit(1);
}

const der = Buffer.from(manifest.key, 'base64');
const derivedId = extensionIdFromDer(der);

let serverSrc;
try {
  serverSrc = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
} catch (e) {
  console.error('读不到 server.js：' + e.message);
  process.exit(1);
}

const m = /const DEFAULT_EXTENSION_ID = '([^']+)'/.exec(serverSrc);
if (!m) {
  console.error('server.js 里没找到 DEFAULT_EXTENSION_ID');
  process.exit(1);
}
const serverId = m[1];

console.log(`manifest key 推导出的 ID : ${derivedId}`);
console.log(`server.js 允许的默认 ID : ${serverId}`);

if (derivedId !== serverId) {
  console.error('\n不一致。改 server.js 的 DEFAULT_EXTENSION_ID，或用 --allow-extension 追加。');
  process.exit(1);
}

console.log('\n一致。');
console.log('注意：这个校验只保证两边写的是同一个 ID。真扩展的请求不带 Origin（它对 127.0.0.1 有');
console.log('host_permissions，请求不算 CORS），所以本扩展从不经过这个允许列表；它拦的是那些');
console.log('没申请该主机权限的其他扩展。详见 SECURITY.md。');
