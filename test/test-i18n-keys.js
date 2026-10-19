#!/usr/bin/env node
/**
 * 弹窗 i18n 的 key 一致性测试。
 *
 * 防的失败：locale 文件里缺 key 时 chrome.i18n.getMessage 返回空字符串，
 * 弹窗上表现为一片空白——不报错、不占位，正是这个项目最在意的那类静默失败。
 *
 * 扫描三处引用：
 *   popup.html 的 data-i18n / data-i18n-html 属性
 *   popup.js 的 chrome.i18n.getMessage('...') 与 ADV_LABELS 里的 key
 *   manifest.json 的 __MSG_…__
 *
 * 然后断言：每个用过的 key 在两个 locale 文件里都存在、两边 key 集合一致、
 * 每条 message 都是非空字符串。
 *
 *   node test-i18n-keys.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..', 'extension');
const LOCALES = ['en', 'zh_CN'];

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

function loadLocale(lang) {
  return JSON.parse(fs.readFileSync(path.join(EXT, '_locales', lang, 'messages.json'), 'utf8'));
}

function collectKeys() {
  const used = new Set();

  // popup.html：data-i18n="key"、data-i18n-html="key"、data-i18n-placeholder="key"
  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  const attrRe = /data-i18n(?:-html|-placeholder)?="([^"]+)"/g;
  let m;
  while ((m = attrRe.exec(html)) !== null) { used.add(m[1]); }

  // popup.js：getMessage('key') 调用
  const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  const callRe = /getMessage\(\s*'([^']+)'/g;
  while ((m = callRe.exec(js)) !== null) { used.add(m[1]); }

  // popup.js：ADV_LABELS 块的值也是 key（形如 { cookies: 'permCookies' }）
  const advBlock = /ADV_LABELS\s*=\s*\{([\s\S]*?)\};/.exec(js);
  if (advBlock) {
    const valRe = /:\s*'([^']+)'/g;
    while ((m = valRe.exec(advBlock[1])) !== null) { used.add(m[1]); }
  }

  // manifest.json：__MSG_xxx__ → key xxx
  const manifest = fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8');
  const msgRe = /__MSG_(\w+)__/g;
  while ((m = msgRe.exec(manifest)) !== null) { used.add(m[1]); }

  return used;
}

(async () => {
  const used = collectKeys();
  const en = loadLocale('en');
  const zh = loadLocale('zh_CN');

  check('至少收集到一些 key', used.size > 0, `只找到 ${used.size} 个`);

  // 1. 每个用过的 key 在两个 locale 文件里都存在
  const missingEn = [...used].filter((k) => !(k in en));
  const missingZh = [...used].filter((k) => !(k in zh));
  check('所有用过的 key 在 en 里存在', missingEn.length === 0, `缺：${missingEn.join(', ')}`);
  check('所有用过的 key 在 zh_CN 里存在', missingZh.length === 0, `缺：${missingZh.join(', ')}`);

  // 2. 两个 locale 文件的 key 集合完全一致（无漂移）
  const enKeys = Object.keys(en);
  const zhKeys = Object.keys(zh);
  const onlyEn = enKeys.filter((k) => !(k in zh));
  const onlyZh = zhKeys.filter((k) => !(k in en));
  check('en 的 key 在 zh_CN 里都有', onlyEn.length === 0, `en 多出：${onlyEn.join(', ')}`);
  check('zh_CN 的 key 在 en 里都有', onlyZh.length === 0, `zh_CN 多出：${onlyZh.join(', ')}`);

  // 3. locale 文件里没有"没人用"的 key（防死条目堆积）
  const unusedEn = enKeys.filter((k) => !used.has(k));
  const unusedZh = zhKeys.filter((k) => !used.has(k));
  check('en 里没有无人使用的 key', unusedEn.length === 0, `多余：${unusedEn.join(', ')}`);
  check('zh_CN 里没有无人使用的 key', unusedZh.length === 0, `多余：${unusedZh.join(', ')}`);

  // 4. 每条 message 都是非空字符串
  const emptyMessages = [];
  for (const [name, locale] of [['en', en], ['zh_CN', zh]]) {
    for (const [key, entry] of Object.entries(locale)) {
      if (typeof entry.message !== 'string' || entry.message.trim() === '') {
        emptyMessages.push(`${name}.${key}`);
      }
    }
  }
 check('所有 message 都是非空字符串', emptyMessages.length === 0, `空：${emptyMessages.join(', ')}`);

  // 5. message 里的占位符 $1 在两边一致（只检查用了 $ 的）
  const placeholderMismatch = [];
  for (const key of Object.keys(en)) {
    const enPh = (en[key].message.match(/\$\d+/g) || []).join(',');
    const zhPh = (zh[key].message.match(/\$\d+/g) || []).join(',');
    if (enPh !== zhPh) { placeholderMismatch.push(`${key}: en=${enPh} zh=${zhPh}`); }
  }
  check('占位符 $1…在两个 locale 里一致', placeholderMismatch.length === 0, placeholderMismatch.join('; '));

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
