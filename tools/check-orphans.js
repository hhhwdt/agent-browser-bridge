#!/usr/bin/env node
/**
 * 校验没有"没人引用的死文件"。
 *
 * 为什么需要：重构（拆模块、换实现路径）之后旧文件常常留在原地。它们不报错、
 * 不拖慢启动，只是让下一个人以为那还是当前实现——这个仓库里就有一整套
 * src/computer/scripts/*.ps1 被 host/lib/ 取代后还留着，而且内容已经分叉。
 *
 * 判定规则（宁可放过，不可误报）：
 *   - 入口不算孤儿：package.json 的 main/bin、manifest 的 service worker、
 *     popup.html 引用的脚本、test/ 与 tools/ 下的每个文件（它们是直接运行的入口）、
 *     scripts/ 下的辅助脚本（文档里直接让人跑）。
 *   - JS 用 require / import / import() 的相对路径建立引用图，从入口出发可达即活。
 *   - 非 JS（.ps1/.html/.json）按引用文本判定：仓库相对路径、或"最后两段"、
 *     或文件名在全仓唯一时的文件名，出现在任何源码里即算被引用。
 *
 *   node tools/check-orphans.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'extension', 'test', 'tools', 'scripts'];
const CODE_EXT = new Set(['.js', '.ps1', '.html', '.json']);
const CANDIDATE_EXT = new Set(['.js', '.ps1', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs']);

/** 递归收集候选文件（仓库相对路径，正斜杠）。 */
function walk(relDir, out) {
  const abs = path.join(root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) { continue; }
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(rel, out); continue; }
    if (CANDIDATE_EXT.has(path.extname(e.name)) && !e.name.endsWith('.example.js')) { out.push(rel); }
  }
}

/** 读文本，统一成 LF 与正斜杠，便于做路径匹配。 */
function readText(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\\/g, '/');
  } catch (e) {
    return '';
  }
}

/**
 * 去掉注释后再做引用匹配。
 * 注释里提到一个文件名不等于引用它——这个仓库里就有一条注释写着
 * "same math as scripts/screen.ps1"，那正是说旧的那份被取代了。
 * 只去整行的注释和块注释，不碰字符串里的内容。
 */
function stripComments(text, ext) {
  if (ext === '.js') {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
  }
  if (ext === '.ps1') {
    return text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  }
  if (ext === '.html') {
    return text.replace(/<!--[\s\S]*?-->/g, '');
  }
  return text;
}

const files = [];
for (const d of SCAN_DIRS) { walk(d, files); }

/**
 * 全量源码文本（去注释），供非 JS 的引用判定。
 * 排除本文件自己：它列出了待删清单，算进去会让那些文件"被自己引用"。
 */
const SELF = 'tools/check-orphans.js';
const allText = files
  .filter((f) => f !== SELF && CODE_EXT.has(path.extname(f)))
  .map((f) => stripComments(readText(f), path.extname(f)))
  .join('\n');

/** 入口：这些文件永远不算孤儿。 */
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const ENTRIES = new Set([
  packageJson.main,
  ...Object.values(packageJson.bin || {}),
  // 文档与 package.json 的 scripts 都让人直接跑它，但它不是 bin
  'src/server.js',
  `extension/${manifest.background.service_worker}`,
  'extension/popup.js',
  ...(packageJson.files || []).filter((f) => f.endsWith('.js'))
].filter(Boolean));

/**
 * 已经确认被取代、但还没删的旧实现。列在这里不会被当成新的孤儿，
 * 但会单独打出来提醒——真正的目的是让"新增"的孤儿一眼可见。
 */
const PENDING_DELETION = new Set([
  'src/computer/scripts/audio.ps1',
  'src/computer/scripts/clip.ps1',
  'src/computer/scripts/input.ps1',
  'src/computer/scripts/notify.ps1',
  'src/computer/scripts/screen.ps1',
  'src/computer/scripts/windows.ps1'
]);

const isEntry = (rel) => ENTRIES.has(rel)
  || rel.startsWith('test/')
  || rel.startsWith('tools/')
  || rel.startsWith('scripts/');

/** 把 require/import 的相对路径解析成仓库相对路径（试原样、+.js、/index.js）。 */
function resolveSpec(fromRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const candidate of [base, `${base}.js`, `${base}/index.js`]) {
    if (files.includes(candidate)) { return candidate; }
  }
  return null;
}

/** 从一个 JS 文件里抽出它引用的仓库内文件。 */
function jsRefs(rel) {
  const text = stripComments(readText(rel), path.extname(rel));
  const out = new Set();
  const patterns = [
    /require\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /from\s+['"](\.[^'"]+)['"]/g,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const target = resolveSpec(rel, m[1]);
      if (target) { out.add(target); }
    }
  }
  return out;
}

/** 非 JS 文件的引用判定：路径、最后两段、或唯一文件名。 */
function referencedByText(rel) {
  const segments = rel.split('/');
  const suffix = segments.slice(-2).join('/');
  const base = segments[segments.length - 1];
  const baseCount = files.filter((f) => f.split('/').pop() === base).length;
  if (allText.includes(rel)) { return true; }
  if (segments.length >= 2 && allText.includes(suffix)) { return true; }
  if (baseCount === 1 && allText.includes(base)) { return true; }
  return false;
}

/* ---------------- 从入口出发求可达集合 ---------------- */

const reachable = new Set();
const queue = [];

for (const rel of files) {
  if (isEntry(rel)) { reachable.add(rel); queue.push(rel); }
}

while (queue.length) {
  const rel = queue.shift();
  if (path.extname(rel) !== '.js') { continue; }
  for (const next of jsRefs(rel)) {
    if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
  }
}

/* 非 JS 文件：被可达代码或任意源码文本引用即算活 */
const orphans = [];
const pending = [];
for (const rel of files) {
  if (reachable.has(rel)) { continue; }
  if (path.extname(rel) !== '.js' && referencedByText(rel)) { continue; }
  if (PENDING_DELETION.has(rel)) { pending.push(rel); continue; }
  orphans.push(rel);
}

console.log(`扫描 ${files.length} 个文件，入口 ${reachable.size} 个可达。`);

if (pending.length) {
  console.log(`\n已确认被取代、待删除的旧实现（${pending.length} 个，需人工确认后删掉）：`);
  for (const p of pending) { console.log('  ' + p); }
}

if (orphans.length) {
  console.error(`\n发现 ${orphans.length} 个没人引用的文件：`);
  for (const o of orphans) { console.error('  ' + o); }
  console.error('\n要么接进调用链，要么删掉——留着的旧实现会让人以为它还是当前实现。');
  process.exit(1);
}

console.log('\n没有新的孤儿文件。');
