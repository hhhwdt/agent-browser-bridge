#!/usr/bin/env node
/**
 * 校验版本号两处一致：package.json 与 extension/manifest.json。
 *
 * 这两处必须同时改，而它们分处两个语言的文件里，改一处忘了另一处不会有任何报错——
 * 装的人是 1.7.0，`diag` 报的是 1.7.0 还是 1.6.0 全靠运气，排查时先被误导一轮。
 * npm 发布用的也是 package.json 那份，对不上就等于发出去的版本号和扩展自报的版本号不同。
 *
 *   node check-version.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

/** 读出指定 JSON 文件的 version 字段，读不到就报错退出。 */
function readVersion(relPath) {
  const full = path.join(root, relPath);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    console.error(`读不到或解析不了 ${relPath}：${e.message}`);
    process.exit(1);
  }
  if (!json.version) {
    console.error(`${relPath} 里没有 version 字段。`);
    process.exit(1);
  }
  return json.version;
}

const pkgVersion = readVersion('package.json');
const manifestVersion = readVersion(path.join('extension', 'manifest.json'));

console.log(`package.json            : ${pkgVersion}`);
console.log(`extension/manifest.json : ${manifestVersion}`);

if (pkgVersion !== manifestVersion) {
  console.error('\n不一致。两处都要改：package.json 决定 npm 上的版本与 MCP 自报的版本，');
  console.error('manifest.json 决定浏览器里扩展的版本。');
  process.exit(1);
}

console.log('\n一致。');
