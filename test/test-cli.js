#!/usr/bin/env node
/**
 * 命令行逐个命令的冒烟测试。需要一个已连接扩展的浏览器，但不需要任何配置或站点授权：
 * 它用桥接自己的地址（`127.0.0.1:18777`，在清单的必需 host_permissions 里）开一个
 * 后台标签页当靶子，跑完关掉。
 *
 * 它防的是"改了某个命令的实现，那个命令悄悄坏掉"——尤其那些平时不常用的命令。
 * 写它的直接原因：`click --dryRun` 的人类可读输出崩了很久（读了试运行里不存在的
 * `clicked` 字段），而 --json 路径是好的，所以一直没人发现。
 *
 *   node test/test-cli.js
 */

'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const CLI = path.join('src', 'cli.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${String(detail === undefined ? '' : detail).slice(0, 200)}`); }
}

/** 跑一条 CLI 命令，返回 { code, out }。 */
function cli(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const shot = path.join(os.tmpdir(), 'abb-cli-smoke.png');

(async () => {
  const nav = cli(['navigate', '--url', 'http://127.0.0.1:18777/health', '--newTab', '--json']);
  let tabId = null;
  try { tabId = JSON.parse(nav.out).tabId; } catch (e) { /* 下面报 */ }
  check('navigate --newTab 开测试页并返回 tabId', typeof tabId === 'number', nav.out.slice(0, 200));

  if (typeof tabId !== 'number') {
    console.log('\n扩展未连接或桥接不可用，跳过命令级检查。');
    console.log(`\n通过 ${pass}，失败 ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  }

  const t = ['--tabId', String(tabId)];
  const cases = [
    ['read', ['read', ...t], /标题  :/],
    ['read --html', ['read', ...t, '--html'], /可编辑区域|未发现可编辑区域/],
    ['links', ['links', ...t], /链接数:/],
    ['frames', ['frames', ...t], /框架数:/],
    ['media', ['media', ...t], /统计  :/],
    ['wait', ['wait', ...t, '--selector', 'body', '--timeout', '5000'], /条件已成立/],
    ['eval', ['eval', ...t, '--code', 'return 1 + 1'], /^2$/m],
    // 试运行是 README 里宣传的用法，必须能打印
    ['click --dryRun', ['click', ...t, '--text', 'agent', '--dryRun'], /试运行/],
    ['type', ['type', ...t, '--selector', 'body', '--value', 'x', '--force'], /标签页  :|内容预览/],
    ['key', ['key', ...t, '--key', 'Escape'], /已按键|目标/],
    ['screenshot', ['screenshot', ...t, '--out', shot], /已保存截图/],
    ['mark', ['mark', ...t, '--text', 'smoke'], /已标记/],
    ['unmark', ['unmark', ...t], /已清除标记/],
    ['session', ['session', ...t, '--name', 'x'], /cookies|Cookie/],
    ['diag', ['diag'], /扩展版本/],
    ['tabs', ['tabs'], /个标签页/],
    ['browsers', ['browsers'], /浏览器/],
    ['close', ['close', ...t], /已关闭/]
  ];
  for (const [name, args, re] of cases) {
    const r = cli(args);
    check(name, r.code === 0 && re.test(r.out), `exit=${r.code} ${r.out.slice(0, 160)}`);
  }

  // 关掉之后再用同一个 id 关一次：要报错得干净，而不是抛栈
  const again = cli(['close', ...t]);
  check('重复关闭已关的标签页给出明确报错', again.code !== 0 && /no_tab_matched/.test(again.out),
    `exit=${again.code} ${again.out.slice(0, 120)}`);

  // 不依赖浏览器的两条
  check('未知命令退出码 1', cli(['nosuchcmd']).code === 1);
  check('缺少参数时给出提示', /需要 --match|需要 --url/.test(cli(['read']).out));

  try { fs.unlinkSync(shot); } catch (e) { /* 没生成就算了 */ }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
