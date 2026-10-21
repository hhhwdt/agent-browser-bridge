#!/usr/bin/env node
/**
 * 校验 npm 包里装的东西：该在的都在，不该在的一个都不能有。
 *
 * 为什么需要：npm 打包时有几个文件是**强制包含**的（README*、LICENSE、package.json、
 * main 指向的文件），`.gitignore` 和 package.json 的 files 白名单都拦不住。这个仓库里就
 * 踩过：本机运维文档原名 README.txt，里面全是 D:\ 绝对路径，一次 `npm publish` 就会把它
 * 传上 registry，而本地任何检查都不会响。
 *
 * 所以这里不只查文件名清单，还查一条通用规则：**包里出现的每个文件都必须是 git 跟踪的**
 * 文件。发布包里混进未跟踪文件，几乎总是这一类事故。
 *
 *   node check-package.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

/** 发布包里必须在的文件（少一个就说明 files 白名单改坏了）。 */
const REQUIRED = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'src/server.js',
  'src/cli.js',
  'src/mcp.js',
  'src/client.js',
  'src/setup.js',
  'src/server/ws.js',
  'extension/manifest.json',
  'extension/sw/background.js',
  'extension/sw/actions.js',
  'extension/sw/actions-tabs.js',
  'extension/sw/actions-read.js',
  'extension/sw/actions-screenshot.js',
  'extension/sw/actions-session.js',
  'extension/sw/actions-files.js',
  'extension/sw/actions-interact.js',
  'extension/sw/inject-read.js',
  'extension/sw/inject-click.js',
  'extension/sw/inject-edit.js',
  'extension/sw/inject-run.js',
  'extension/sw/inject-mark.js',
  'extension/sw/inject-media.js',
  'extension/sw/guards.js',
  'extension/sw/marks.js',
  'extension/sw/config.js',
  'extension/sw/ws.js',
  'docs/SECURITY.md',
  'scripts/start-server.ps1'
];

/** 明确不能出现的名字模式，兜住上面那条通用规则万一失效的情况。 */
const FORBIDDEN = [
  /^LOCAL-NOTES/i,
  /^README\.txt$/i,
  /test-config/i,
  /^logs\//,
  /\.log$/,
  /^\.git\//,
  /^node_modules\//
];

/** 从 stdout 里提取第一个完整的 JSON 文档，容忍前导噪声与 JSON 之后的额外输出行。 */
function extractJson(out) {
  // 两个候选不能只按先解析成功的顺序取：npm 12 的外层是对象，但第一个 '['
  // 属于内层的 files 数组，先按 '[' 解析会把"文件条目数组"当成包清单带回去，
  // 后面取 entry.files 就成了空列表。这里要求解析结果长得像包清单才接受。
  let fallback;
  for (const open of ['[', '{']) {
    const start = out.indexOf(open);
    if (start < 0) { continue; }
    // 括号配平找到结束位置（字符串内的引号与括号按字面处理）
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < out.length; i++) {
      const c = out[i];
      if (inStr) {
        if (esc) { esc = false; }
        else if (c === '\\') { esc = true; }
        else if (c === '"') { inStr = false; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '[' || c === '{') { depth++; }
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) { continue; }
    let parsed;
    try { parsed = JSON.parse(out.slice(start, end)); } catch (e) { continue; }
    const looksLike = Array.isArray(parsed)
      ? Boolean(parsed[0] && Array.isArray(parsed[0].files))
      : Boolean(Array.isArray(parsed.files)
        || Object.values(parsed).some((v) => v && Array.isArray(v.files)));
    if (looksLike) { return parsed; }
    fallback = fallback || parsed;
  }
  return fallback;
}

/** 跑一次 npm pack 的干运行，拿回文件清单（不落盘）。 */
function packedFiles() {
  // Windows 上 .cmd 只能经 shell 执行；命令里没有外部输入，不存在拼接注入
  const r = isWindows
    ? spawnSync('npm.cmd pack --dry-run --json', { cwd: root, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  if (r.error) {
    console.error(`跑不起来 npm pack：${r.error.message}`);
    process.exit(1);
  }
  const out = String(r.stdout || '');
  if (r.status !== 0 || (!out.includes('[') && !out.includes('{'))) {
    console.error('npm pack --dry-run --json 没有返回可解析的结果：');
    console.error(out.slice(0, 500) || String(r.stderr || '').slice(0, 500));
    process.exit(1);
  }
  let parsed = extractJson(out);
  if (r.status !== 0 || !parsed) {
    console.error('npm pack --dry-run --json 没有返回可解析的结果：');
    console.error(out.slice(0, 500) || String(r.stderr || '').slice(0, 500));
    process.exit(1);
  }
  // npm 11：结果数组 [ { files... } ]；npm 12 起（Trusted Publishing 升级后的
  // npm@latest）：改成按包名键控的对象 { "<pkg>": { files... } }。两种形状都要
  // 能取到 entry，否则 CI 上发布前置检查必然失败。
  let entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    const values = Object.values(entry || {});
    entry = values.find((v) => v && Array.isArray(v.files)) || entry;
  }
  return (entry && entry.files ? entry.files : []).map((f) => f.path);
}

/**
 * git 认为"属于这个仓库"的文件：已跟踪的 + 未跟踪但没被 .gitignore 排除的。
 *
 * 用这个集合而不是只比已跟踪文件，是为了让检查对准真正的事故形态——**被 .gitignore
 * 排除的文件进了发布包**。刚落盘、还没 git add 的新文件不该让检查失败，那是正常工作流。
 * 不在仓库里就返回 null，跳过这条检查而不是误报失败。
 */
function trackedFiles() {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (r.error || r.status !== 0 || !r.stdout) { return null; }
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

const files = packedFiles();
console.log(`包里共 ${files.length} 个文件：`);
for (const f of files) { console.log('  ' + f); }

let failed = false;

const missing = REQUIRED.filter((f) => !files.includes(f));
if (missing.length) {
  failed = true;
  console.error(`\n缺少必须发布的文件：${missing.join(', ')}`);
  console.error('检查 package.json 的 files 白名单。');
}

const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (bad.length) {
  failed = true;
  console.error(`\n包里出现了不该发布的文件：${bad.join(', ')}`);
}

const tracked = trackedFiles();
if (tracked === null) {
  console.log('\n（不在 git 仓库里或没有 git，跳过"被忽略文件"这条检查）');
} else {
  const ignored = files.filter((f) => !tracked.includes(f));
  if (ignored.length) {
    failed = true;
    console.error(`\n包里出现了被 .gitignore 排除的文件：${ignored.join(', ')}`);
    console.error('这类文件是本机专用的，不该出现在 registry 上。');
  }
}

if (failed) {
  console.error('\n打包内容不合格，先处理上面的问题再发布。');
  process.exit(1);
}

console.log('\n打包内容合格：该在的都在，没有混进本机专用文件。');
