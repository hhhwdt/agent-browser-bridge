#!/usr/bin/env node
/**
 * 桌面视觉测试：模板匹配 + 前后对比。
 *
 * 防的失败：图标/图形按钮既没有文字也没有 UIA，只能靠"看一眼再点"。
 * 这里验证两件事：给定一块截图能否在屏幕截图里找回它的位置；两张截图能否
 * 指出变化的区域（用来回答"刚才那一下生效没有"）。
 * 图片是现画的，不截用户屏幕。非 Windows 直接跳过。
 *
 *   node test-desktop-vision.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 240)}`);
  }
}

if (process.platform !== 'win32') {
  console.log('跳过：桌面视觉只在 Windows 上可用');
  process.exit(0);
}

const repo = path.join(__dirname, '..');
const visionLib = path.join(repo, 'src', 'computer', 'host', 'lib', 'vision.ps1');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-vision-test-'));

const script = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  ". '" + visionLib.replace(/'/g, "''") + "'",
  "$dir = '" + dir.replace(/'/g, "''") + "'",
  "$screen = Join-Path $dir 'screen.png'",
  "$tpl = Join-Path $dir 'tpl.png'",
  "$after = Join-Path $dir 'after.png'",
  "$bad = Join-Path $dir 'bad.png'",
  "",
  "# Screen: light background, some blocks, and a distinctive icon at 260,180",
  "$bmp = New-Object System.Drawing.Bitmap 420, 320",
  "$g = [System.Drawing.Graphics]::FromImage($bmp)",
  "$g.Clear([System.Drawing.Color]::FromArgb(245,245,245))",
  "$g.FillRectangle([System.Drawing.Brushes]::SteelBlue, 20, 20, 120, 60)",
  "$g.FillRectangle([System.Drawing.Brushes]::DarkGreen, 200, 40, 100, 40)",
  "$g.FillRectangle([System.Drawing.Brushes]::Black, 260, 180, 40, 40)",
  "$g.FillEllipse([System.Drawing.Brushes]::White, 270, 190, 20, 20)",
  "$g.Dispose()",
  "$bmp.Save($screen, [System.Drawing.Imaging.ImageFormat]::Png)",
  "",
  "# Template: crop the icon (260,180,40,40)",
  "$src = [System.Drawing.Image]::FromFile($screen)",
  "$t = New-Object System.Drawing.Bitmap 40, 40",
  "$tg = [System.Drawing.Graphics]::FromImage($t)",
  "$tg.DrawImage($src, (New-Object System.Drawing.Rectangle 0,0,40,40), (New-Object System.Drawing.Rectangle 260,180,40,40), [System.Drawing.GraphicsUnit]::Pixel)",
  "$tg.Dispose(); $t.Save($tpl, [System.Drawing.Imaging.ImageFormat]::Png); $t.Dispose(); $src.Dispose()",
  "",
  "# After: same screen with a 30x20 change at (100,60)",
  "$src = [System.Drawing.Image]::FromFile($screen)",
  "$a = New-Object System.Drawing.Bitmap 420, 320",
  "$ag = [System.Drawing.Graphics]::FromImage($a)",
  "$ag.DrawImage($src, 0, 0, 420, 320)",
  "$ag.FillRectangle([System.Drawing.Brushes]::OrangeRed, 100, 60, 30, 20)",
  "$ag.Dispose(); $a.Save($after, [System.Drawing.Imaging.ImageFormat]::Png); $a.Dispose(); $src.Dispose()",
  "",
  "# Bad template: diagonal stripes, unlike anything on the screen",
  "$tb = New-Object System.Drawing.Bitmap 24, 24",
  "$tbg = [System.Drawing.Graphics]::FromImage($tb)",
  "$tbg.Clear([System.Drawing.Color]::White)",
  "for ($i = 0; $i -lt 24; $i += 6) { $tbg.FillRectangle([System.Drawing.Brushes]::Black, $i, 0, 3, 24) }",
  "$tbg.Dispose(); $tb.Save($bad, [System.Drawing.Imaging.ImageFormat]::Png); $tb.Dispose()",
  "",
  "$m = Invoke-AbbVision @{ op='match'; screen=$screen; template=$tpl; threshold=0.9 }",
  "Write-Output ('MATCH=' + $m.found + '|' + $m.x + '|' + $m.y + '|' + $m.w + '|' + $m.h + '|' + $m.score)",
  "$mb = Invoke-AbbVision @{ op='match'; screen=$screen; template=$bad; threshold=0.9 }",
  "Write-Output ('NOMATCH=' + $mb.found + '|' + $mb.score)",
  "$d = Invoke-AbbVision @{ op='diff'; before=$screen; after=$after; threshold=24 }",
  "if ($d.changed) { Write-Output ('DIFF=1|' + $d.box.x + '|' + $d.box.y + '|' + $d.box.w + '|' + $d.box.h) } else { Write-Output 'DIFF=0' }",
  "$d2 = Invoke-AbbVision @{ op='diff'; before=$screen; after=$screen; threshold=24 }",
  "Write-Output ('SAMEDIFF=' + $d2.changed)"
].join('\r\n');

const scriptPath = path.join(dir, 'run.ps1');
fs.writeFileSync(scriptPath, script, 'utf8');

let out;
try {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    encoding: 'utf8',
    timeout: 120000
  });
  out = String(r.stdout || '') + String(r.stderr || '');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 已尽力 */ }
}

const match = /MATCH=(True|False)\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)\|([0-9.]+)/.exec(out);
check('模板匹配成功', match && match[1] === 'True', out.slice(0, 300));
if (match) {
  check('位置就是图标所在处 (260,180)',
    Math.abs(Number(match[2]) - 260) <= 1 && Math.abs(Number(match[3]) - 180) <= 1,
    match[0]);
  check('模板尺寸正确', Number(match[4]) === 40 && Number(match[5]) === 40, match[0]);
  check('相似度很高', Number(match[6]) >= 0.95, match[0]);
}

const nomatch = /NOMATCH=(True|False)\|([0-9.]+)/.exec(out);
check('不在屏幕上的模板报 found=false', nomatch && nomatch[1] === 'False', out.slice(0, 300));

const diff = /DIFF=1\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)/.exec(out);
check('能指出变化区域', !!diff, out.slice(0, 300));
if (diff) {
  check('变化区域就是改动的 (100,60) 30x20',
    Math.abs(Number(diff[1]) - 100) <= 1 && Math.abs(Number(diff[2]) - 60) <= 1
    && Math.abs(Number(diff[3]) - 30) <= 1 && Math.abs(Number(diff[4]) - 20) <= 1,
    diff[0]);
}

check('同一张图对比报没有变化', /SAMEDIFF=False/.test(out), out.slice(0, 300));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
