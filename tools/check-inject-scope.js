#!/usr/bin/env node
/**
 * 注入函数的静态检查。三条断言，每条都对应本项目真实踩过的坑：
 *
 *   1. 自包含。executeScript({func}) 只把该函数自身的源码送进页面，模块作用域里的东西
 *      在页面里并不存在。引用模块级辅助函数能编译通过、能过评审，运行到那一行才抛
 *      ReferenceError。
 *
 *   2. 源码能当表达式求值。函数序列化后是作为表达式注入的，源码里若带上 `export`
 *      之类的修饰就会直接语法错误。这条是服务脚本改用 ES 模块之后加的——当时靠一个
 *      单独的小实验才确认 V8 的 toString 不会带 export，与其依赖实验，不如每次都验。
 *
 *   3. inject-*.js 不能有任何 import。前两条是逐个函数的检查，这条是结构性的：
 *      放注入函数的模块整体不允许依赖别的模块，从源头上堵住第 1 条。
 *
 *   node tools/check-inject-scope.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SW_DIR = path.join(__dirname, '..', 'extension', 'sw');

/** 所有会通过 executeScript({func}) 注入页面的函数名。 */
const INJECTED = [
  'extractInPage', 'clickInPage', 'linksInPage', 'typeInPage', 'keyInPage',
  'indicatorInPage', 'diagInPage', 'waitInPage', 'tabMarkInPage', 'mediaInPage',
  'readStorageInPage', 'evalInPage', 'rectInPage', 'fetchInPage', 'markdownInPage'
];

const files = fs.readdirSync(SW_DIR).filter((f) => f.endsWith('.js')).sort();
const sources = files.map((f) => ({ file: f, src: fs.readFileSync(path.join(SW_DIR, f), 'utf8') }));

/** 所有模块的顶层声明名（这些名字在页面里都不存在）。 */
function topLevelNames(src) {
  const names = new Set();
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src)) !== null) { names.add(m[1] || m[2]); }
  return names;
}
const MODULE_NAMES = new Set();
for (const { src } of sources) {
  for (const n of topLevelNames(src)) { MODULE_NAMES.add(n); }
}

/** 从 `function name(` 起按大括号配平截取源码，export 前缀剥掉。 */
function extractFunction(src, name) {
  const m = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function ${name}\\(`, 'm').exec(src);
  if (!m) { return null; }
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') { depth++; }
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) { return src.slice(m.index, j + 1).replace(/^export\s+/, ''); }
    }
  }
  return null;
}

let problems = 0;
let checked = 0;

for (const fn of INJECTED) {
  let body = null;
  let where = '';
  for (const s of sources) {
    body = extractFunction(s.src, fn);
    if (body) { where = s.file; break; }
  }
  if (!body) {
    console.log(`  FAIL ${fn} 在所有模块里都找不到`);
    problems++;
    continue;
  }
  checked++;
  const bad = [];

  // 断言 1：不引用任何模块级名字
  const declared = new Set();
  const declRe = /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
  let dm;
  while ((dm = declRe.exec(body)) !== null) { declared.add(dm[1]); }
  const paramRe = new RegExp(`function ${fn}\\(([^)]*)\\)`);
  const pm = paramRe.exec(body);
  if (pm && pm[1].trim()) {
    pm[1].split(',').forEach((p) => {
      const n = p.trim().split(/[=\s]/)[0];
      if (n) { declared.add(n); }
    });
  }
  for (const name of MODULE_NAMES) {
    if (name === fn || declared.has(name)) { continue; }
    if (new RegExp(`(?<![.\\w$'"\`])${name}(?![\\w$])`).test(body)) { bad.push('引用模块级 ' + name); }
  }

  // 断言 2：源码本身能作为表达式求值（序列化注入的前提）
  try {
    new Function('return (' + body + ')');
  } catch (e) {
    bad.push('源码不能作为表达式求值: ' + e.message);
  }

  if (bad.length) {
    problems++;
    console.log(`  FAIL ${fn}（${where}）: ${bad.join('; ')}`);
  } else {
    console.log(`  ok   ${fn}（${where}）`);
  }
}

// 断言 3：所有注入函数模块（inject-*.js）整体不允许有 import
const injectedMods = sources.filter((s) => /^inject-.*\.js$/.test(s.file));
if (injectedMods.length === 0) {
  problems++;
  console.log('  FAIL 找不到任何 inject-*.js（页面注入函数应放在这些模块里）');
} else {
  for (const mod of injectedMods) {
    const importLines = mod.src.split('\n').filter((l) => /^\s*import\s/.test(l));
    if (importLines.length) {
      problems++;
      console.log(`  FAIL ${mod.file} 出现了 ${importLines.length} 条 import：注入函数必须自包含`);
    } else {
      console.log(`  ok   ${mod.file} 没有任何 import`);
    }
  }
}

console.log(problems === 0
  ? `\n全部通过：检查了 ${checked} 个注入函数，均自包含且可安全序列化`
  : `\n发现 ${problems} 个问题`);
process.exit(problems === 0 ? 0 : 1);
