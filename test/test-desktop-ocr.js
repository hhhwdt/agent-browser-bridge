#!/usr/bin/env node
/**
 * 桌面 OCR 测试：用真实的 screen.ps1 里的 OCR 函数识别一张自己画的图。
 *
 * 防的失败：WinRT 的异步调用在 PowerShell 5.1 里没有 await，写错就整个 OCR 不可用；
 * 或者识别结果拿不到坐标（有坐标才能直接喂给 click）。不截用户屏幕：图片是现画的。
 *
 * 非 Windows、或系统没装 OCR 语言包时跳过（退出码 0）。
 *
 *   node test-desktop-ocr.js
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
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

if (process.platform !== 'win32') {
  console.log('跳过：桌面 OCR 只在 Windows 上可用');
  process.exit(0);
}

const repo = path.join(__dirname, '..');
const screenLib = path.join(repo, 'src', 'computer', 'host', 'lib', 'screen.ps1');

const script = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null",
  "$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages",
  "if (-not $langs -or $langs.Count -eq 0) { Write-Output 'SKIP_NO_OCR'; exit 0 }",
  ". '" + screenLib.replace(/'/g, "''") + "'",
  "Add-Type -AssemblyName System.Drawing",
  "$bmp = New-Object System.Drawing.Bitmap 640, 160",
  "$g = [System.Drawing.Graphics]::FromImage($bmp)",
  "$g.Clear([System.Drawing.Color]::White)",
  "$font = New-Object System.Drawing.Font 'Segoe UI', 36, ([System.Drawing.FontStyle]::Bold)",
  "$g.DrawString('HELLO WORLD 12345', $font, [System.Drawing.Brushes]::Black, 20, 50)",
  "$g.Dispose()",
  "$tmp = Join-Path $env:TEMP ('abb-ocr-test-' + [guid]::NewGuid().ToString('N') + '.png')",
  "$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)",
  "$bmp.Dispose()",
  "try {",
  "  $r = Invoke-AbbOcrFile -Path $tmp",
  "  Write-Output ('LANG=' + $r.language)",
  "  foreach ($l in $r.lines) { Write-Output ('LINE=' + $l.text + '|' + $l.x + ',' + $l.y + '|' + $l.w + 'x' + $l.h) }",
  "} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }"
].join('\r\n');

const scriptPath = path.join(os.tmpdir(), 'abb-ocr-test-' + Date.now() + '.ps1');
fs.writeFileSync(scriptPath, script, 'utf8');

let out;
try {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    encoding: 'utf8',
    timeout: 90000
  });
  out = String(r.stdout || '') + String(r.stderr || '');
} finally {
  try { fs.unlinkSync(scriptPath); } catch (e) { /* 已删除 */ }
}

if (out.includes('SKIP_NO_OCR')) {
  console.log('跳过：这台机器没有安装 OCR 语言包');
  process.exit(0);
}

const langMatch = /LANG=([^\r\n]+)/.exec(out);
const lineMatch = /LINE=(.*)\|(-?\d+),(-?\d+)\|(\d+)x(\d+)/.exec(out);

check('识别出了语言', !!langMatch, out.slice(0, 300));
check('识别出了文字', !!lineMatch && /HELLO/i.test(lineMatch[1]), lineMatch ? lineMatch[1] : out.slice(0, 300));
if (lineMatch) {
  check('坐标是数字', Number.isFinite(Number(lineMatch[2])) && Number.isFinite(Number(lineMatch[3])),
    lineMatch[0]);
  check('返回了外接矩形尺寸', Number(lineMatch[4]) > 0 && Number(lineMatch[5]) > 0, lineMatch[0]);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
