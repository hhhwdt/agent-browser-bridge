#!/usr/bin/env node
/**
 * computer 动作族的安全门禁与键名解析——纯离线，不碰真实桌面。
 *
 * 守三件事：
 *   1. 默认拦截 + 白名单的边界不会被悄悄放宽（shell 只读动词、关窗口、杀进程、写剪贴板）。
 *   2. 键名白名单拒绝垃圾输入，不把 vk=0 喂给 SendInput。
 *   3. 审计摘要只记形状，不把剪贴板正文、命令、键入文本写进日志。
 *
 *   node test-computer-policy.js
 */

'use strict';

const { gateDeny, shellGateDeny, auditTarget } = require('../src/computer/index.js');
const { parseKeyCombo } = require('../src/computer/keys.js');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : detail}`); }
}

/* ------------------------------------------------------------------ *
 * [1] shell 白名单
 * ------------------------------------------------------------------ */

console.log('\n[1] shell 免确认白名单');
{
  for (const cmd of [
    'Get-Date',
    'Get-ChildItem -Path C:\\Windows',
    'Get-ChildItem "C:\\Program Files"',
    'Test-Path C:\\Windows',
    'Measure-Object -InputObject 1',
    'dir C:\\',
    'whoami /user',
    'hostname',
    'ipconfig /all',
    'tasklist /v',
    'systeminfo',
    'where node'
  ]) {
    check(`放行只读命令: ${cmd}`, shellGateDeny(cmd) === null, shellGateDeny(cmd));
  }

  for (const [cmd, why] of [
    ['', '空命令'],
    ['echo hi', '不在白名单'],
    ['Remove-Item C:\\tmp\\x -Force', '写操作不在白名单'],
    ['Set-Content out.txt x', '写操作不在白名单'],
    ['Get-Date; whoami', '分号串联'],
    ['Get-Date | Select-Object -First 1', '管道'],
    ['Get-Date > f.txt', '重定向'],
    ['Get-Date < f.txt', '输入重定向'],
    ['$(whoami)', '子表达式'],
    ['Get-Date\r\nwhoami', '换行'],
    ['Get-Date `whoami`', '反引号'],
    ['$env:PATH', '变量不是动词'],
    ['Get-Date ' + 'x'.repeat(600), '超长命令']
  ]) {
    const got = shellGateDeny(cmd);
    check(`拦下${why}: ${JSON.stringify(cmd.slice(0, 40))}`, got !== null, got);
  }
}

/* ------------------------------------------------------------------ *
 * [2] 各动作的 force 门禁
 * ------------------------------------------------------------------ */

console.log('\n[2] gateDeny 各动作');
{
  check('computerShell 只读命令免 force',
    gateDeny('computerShell', { command: 'Get-Date' }) === null);
  const shellDenied = gateDeny('computerShell', { command: 'Remove-Item x' });
  check('computerShell 非白名单要 force', shellDenied && shellDenied.code === 'confirm_required', shellDenied);
  check('computerShell 带 force 放行',
    gateDeny('computerShell', { command: 'Remove-Item x', force: true }) === null);

  const closeDenied = gateDeny('computerWindow', { action: 'close' });
  check('window close 要 force', closeDenied && closeDenied.code === 'confirm_required', closeDenied);
  check('window activate 免 force', gateDeny('computerWindow', { action: 'activate' }) === null);
  check('window close 带 force 放行', gateDeny('computerWindow', { action: 'close', force: true }) === null);

  const killDenied = gateDeny('computerProcess', { mode: 'kill', pid: 123 });
  check('process kill 要 force', killDenied && killDenied.code === 'confirm_required', killDenied);
  check('process list 免 force', gateDeny('computerProcess', { mode: 'list' }) === null);
  check('process kill 带 force 放行', gateDeny('computerProcess', { mode: 'kill', force: true }) === null);

  const clipDenied = gateDeny('computerClipboard', { action: 'write', text: 'x' });
  check('clipboard write 要 force', clipDenied && clipDenied.code === 'confirm_required', clipDenied);
  check('clipboard read 免 force', gateDeny('computerClipboard', { action: 'read' }) === null);
  check('clipboard write 带 force 放行',
    gateDeny('computerClipboard', { action: 'write', text: 'x', force: true }) === null);

  for (const verb of ['computerClick', 'computerMove', 'computerDrag', 'computerScroll',
    'computerType', 'computerKey', 'computerScreen', 'computerWindows', 'computerNotify', 'computerMedia']) {
    check(`${verb} 不需要 force`, gateDeny(verb, {}) === null);
  }
}

/* ------------------------------------------------------------------ *
 * [3] 键名解析
 * ------------------------------------------------------------------ */

console.log('\n[3] 键名与组合键解析');
{
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  let r = parseKeyCombo('Enter');
  check('Enter 单独按', !r.error && eq(r.vks, [0x0D]) && r.mods.length === 0, r);

  r = parseKeyCombo('enter');
  check('键名大小写不敏感', !r.error && eq(r.vks, [0x0D]), r);

  r = parseKeyCombo('ctrl+shift+t');
  check('ctrl+shift+t 组合', !r.error && eq(r.mods, [0xA2, 0xA1]) && eq(r.vks, [0x54]), r);

  r = parseKeyCombo('Ctrl+C');
  check('Ctrl+C 组合', !r.error && eq(r.mods, [0xA2]) && eq(r.vks, [0x43]), r);

  r = parseKeyCombo('win+d');
  check('win+d 组合', !r.error && eq(r.mods, [0x5B]) && eq(r.vks, [0x44]), r);

  r = parseKeyCombo('alt+f4');
  check('alt+f4 组合', !r.error && eq(r.mods, [0xA4]) && eq(r.vks, [0x73]), r);

  r = parseKeyCombo('F12');
  check('F12', !r.error && eq(r.vks, [0x7B]), r);

  r = parseKeyCombo('tab,escape');
  check('逗号分多个普通键', !r.error && eq(r.vks, [0x09, 0x1B]), r);

  r = parseKeyCombo('pgdn');
  check('pgdn 别名', !r.error && eq(r.vks, [0x22]), r);

  r = parseKeyCombo('arrowleft');
  check('arrowleft 别名', !r.error && eq(r.vks, [0x25]), r);

  r = parseKeyCombo('ctrl+nonexistent');
  check('未知键名报错', !!r.error, r);

  r = parseKeyCombo('ctrl');
  check('只有修饰键报错', !!r.error, r);

  r = parseKeyCombo('c+ctrl');
  check('修饰键在普通键之后报错', !!r.error, r);

  r = parseKeyCombo('a+b+c+d+e+f+g');
  check('超过 6 个成员报错', !!r.error, r);

  r = parseKeyCombo('');
  check('空串报错', !!r.error, r);

  r = parseKeyCombo(undefined);
  check('undefined 报错', !!r.error, r);
}

/* ------------------------------------------------------------------ *
 * [4] 审计摘要不外泄内容
 * ------------------------------------------------------------------ */

console.log('\n[4] 审计摘要只记形状');
{
  const secret = 'P@ssw0rd-must-not-appear';
  const longSecret = 'x'.repeat(500) + secret;

  const clip = auditTarget('computerClipboard', { action: 'write', text: secret });
  check('剪贴板正文不进审计', !clip.includes(secret), clip);
  check('剪贴板记 action 与长度',
    clip.includes('action=write') && clip.includes(`textChars=${secret.length}`), clip);

  const shell = auditTarget('computerShell', { command: 'net use \\\\h\\s ' + secret, force: true });
  check('shell 命令内容不进审计', !shell.includes(secret), shell);
  check('shell 记 commandChars 与 force', shell.includes('commandChars=') && shell.includes('force=true'), shell);

  const typing = auditTarget('computerType', { text: secret });
  check('键入文本不进审计', !typing.includes(secret), typing);
  check('键入记 textChars', typing.includes(`textChars=${secret.length}`), typing);

  const notify = auditTarget('computerNotify', { message: secret });
  check('通知正文不进审计', !notify.includes(secret), notify);

  const title = auditTarget('computerScreen', { windowTitle: secret });
  check('窗口标题不进审计', !title.includes(secret), title);
  check('窗口标题只记长度', title.includes(`titleChars=${secret.length}`), title);

  const shellNoise = auditTarget('computerShell', { command: longSecret });
  check('审计摘要不超过 160 字符', shellNoise.length <= 160, String(shellNoise.length));

  const click = auditTarget('computerClick', { x: 640.4, y: 480.6, button: 'right' });
  check('坐标与按钮照常记录', click.includes('x=640') && click.includes('y=481')
    && click.includes('button=right'), click);

  const kill = auditTarget('computerProcess', { mode: 'kill', pid: 4242 });
  check('pid 与模式照常记录', kill.includes('mode=kill') && kill.includes('pid=4242'), kill);
}

/* ------------------------------------------------------------------ *
 * [5] PowerShell 脚本必须是纯 ASCII
 *
 * Windows PowerShell 5.1 reads a BOM-less file as ANSI (GBK here). A UTF-8
 * Chinese comment can decode to a trailing byte that swallows the next line,
 * which silently disables code. This already broke the window cache once.
 * ------------------------------------------------------------------ */

console.log('\n[5] PowerShell 脚本纯 ASCII');
{
  const root = path.join(__dirname, '..', 'src', 'computer');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else if (entry.name.endsWith('.ps1')) { files.push(full); }
    }
  };
  walk(root);
  check('找到 ps1 脚本', files.length >= 6, files.length);

  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const bad = [];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] > 0x7f) { bad.push(i); }
    }
    check(`${path.relative(root, file)} 是纯 ASCII`, bad.length === 0,
      bad.length ? `${bad.length} 个非 ASCII 字节，首个在偏移 ${bad[0]}` : '');
  }
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
