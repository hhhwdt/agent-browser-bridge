#!/usr/bin/env node
/**
 * computer 动作族的实机测试（Windows + 真实桌面）。
 *
 * 自己拉起一个隔离端口上的桥接实例（18997），不碰 18777 正在跑的服务。
 * 覆盖：截图（区域/窗口）、窗口清单、shell 白名单与 force 门禁、剪贴板往返回写、
 *       鼠标移动、音量读取、进程清单、通知、错误分支。
 *
 * 刻意不在自动化里按真实按键（computer_key）——任何按键都可能落进用户正在用的
 * 窗口；需要验证时设 ABB_COMPUTER_KEY_TEST=1 单独跑。
 *
 *   node test-computer.js
 *
 * 非 Windows 平台直接跳过（退出码 0），CI 里不会红。
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 19001;
const HOST = '127.0.0.1';
const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 300)}`); }
}

function skipped(name, why) {
  skip++;
  console.log(`  skip ${name}  （${why}）`);
}

/** 发一个请求，返回 {status, data}；连接失败重试几次（服务刚启动）。 */
function call(method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: HOST,
      port: PORT,
      method,
      path: urlPath,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(extraHeaders || {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { data = { raw }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) { req.write(payload); }
    req.end();
  });
}

async function waitHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await call('GET', '/health');
      if (r.status === 200) { return r.data; }
    } catch (e) { /* 还没起来 */ }
    if (Date.now() > deadline) { throw new Error('服务 10 秒内没起来'); }
    await sleep(200);
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('\n非 Windows 平台，computer 实机测试跳过。');
    process.exit(0);
  }

  const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-policy-live-'));
  const policyFile = path.join(policyDir, 'desktop-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({
    version: 1,
    agents: {
      'policy-shell': { allowForce: ['computerShell'], shellAllow: ['^echo '] },
      'policy-denied': { deny: ['computerNotify'] },
      'policy-readonly': { readOnly: true }
    }
  }), 'utf8');

  const child = spawn(process.execPath, [SERVER, '--port', String(PORT), '--no-token'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ABB_SKIP_UPDATE_CHECK: '1', ABB_DESKTOP_POLICY: policyFile }
  });
  let stderrTail = '';
  child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-1500); });

  try {
    const health = await waitHealth();
    console.log('\n[1] 能力清单与 apiVersion');
    check('apiVersion 至少 1.1', Number(health.apiVersion) >= 1.1, health.apiVersion);
    check('capabilities 含 computerScreen', (health.capabilities || []).includes('computerScreen'));
    check('capabilities 含 computerShell', (health.capabilities || []).includes('computerShell'));

    console.log('\n[2] 截图');
    {
      const r = await call('POST', '/computer/screen', { region: { x: 0, y: 0, w: 200, h: 150 } });
      const d = r.data && r.data.data;
      check('区域截图返回 200', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
      check('返回 PNG dataUrl', !!d && typeof d.dataUrl === 'string' && d.dataUrl.startsWith('data:image/png;base64,'),
        d && String(d.dataUrl).slice(0, 60));
      check('尺寸与请求区域一致', !!d && d.width === 200 && d.height === 150, d && `${d.width}x${d.height}`);
      check('图像体积大于 100 字节', !!d && d.bytes > 100, d && d.bytes);

      const listR = await call('POST', '/computer/windows', {});
      const windows = (listR.data && listR.data.data && listR.data.data.windows) || [];
      const target = windows.find((w) => w.visible && !w.minimized && w.bounds && w.bounds.w > 200 && w.bounds.h > 100);
      if (target) {
        const wr = await call('POST', '/computer/screen', { hwnd: target.hwnd });
        const wd = wr.data && wr.data.data;
        check('窗口截图返回 200', wr.status === 200, `${wr.status} ${JSON.stringify(wr.data).slice(0, 200)}`);
        check('窗口截图尺寸大于 0', !!wd && wd.width > 0 && wd.height > 0, wd && `${wd.width}x${wd.height}`);
      } else {
        skipped('窗口截图', '当前没有可见窗口');
      }

      const miss = await call('POST', '/computer/screen', { windowTitle: '__abb_no_such_window__' });
      check('不存在的窗口标题返回错误', miss.status !== 200 && miss.data && miss.data.error === 'no_window_matched',
        `${miss.status} ${JSON.stringify(miss.data).slice(0, 200)}`);
    }

    console.log('\n[3] 窗口清单');
    {
      const r = await call('POST', '/computer/windows', {});
      const windows = (r.data && r.data.data && r.data.data.windows) || [];
      check('返回 200 且有窗口', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
      check('窗口条目带 index/hwnd/title/pid/bounds', windows.length > 0 && windows.every((w) =>
        typeof w.index === 'number' && typeof w.hwnd === 'number'
        && typeof w.title === 'string' && typeof w.pid === 'number' && w.bounds), JSON.stringify(windows[0]));

      const missing = await call('POST', '/computer/window', { action: 'activate' });
      check('缺目标返回 missing_target', missing.status === 400 && missing.data.error === 'missing_target',
        `${missing.status} ${JSON.stringify(missing.data).slice(0, 200)}`);

      // DPI 一致性：窗口尺寸和全屏截图必须处在同一像素空间，否则按 bounds 点击会整体偏移
      const full = await call('POST', '/computer/screen', {});
      const fullW = full.data && full.data.data ? full.data.data.width : 0;
      const maxWin = windows.find((w) => w.maximized);
      if (fullW && maxWin) {
        check('窗口尺寸与截图同一坐标空间（DPI 一致）', maxWin.bounds.w >= fullW * 0.85,
          `窗口 ${maxWin.bounds.w} vs 全屏 ${fullW}`);
      } else {
        skipped('坐标空间一致性', '没有最大化窗口或没拿到全屏尺寸');
      }

      const notFound = await call('POST', '/computer/window', { action: 'activate', title: '__abb_no_such_window__' });
      check('找不到窗口返回 window_not_found', notFound.status !== 200 && notFound.data
        && /window_not_found/.test(JSON.stringify(notFound.data)), `${notFound.status} ${JSON.stringify(notFound.data).slice(0, 200)}`);

      const closeNoForce = await call('POST', '/computer/window', { action: 'close', title: windows[0] && windows[0].title });
      check('关闭窗口不传 force 被拦下', closeNoForce.status === 400 && closeNoForce.data.error === 'confirm_required',
        `${closeNoForce.status} ${JSON.stringify(closeNoForce.data).slice(0, 200)}`);
    }

    console.log('\n[4] shell 门禁与执行');
    {
      const allowed = await call('POST', '/computer/shell', { command: 'Get-Date' });
      const ad = allowed.data && allowed.data.data;
      check('只读命令免 force 返回 200', allowed.status === 200, `${allowed.status} ${JSON.stringify(allowed.data).slice(0, 300)}`);
      check('退出码 0 且有输出', !!ad && ad.exitCode === 0 && /20\d\d/.test(String(ad.stdout)), ad && String(ad.stdout).slice(0, 120));

      const denied = await call('POST', '/computer/shell', { command: 'echo no-force' });
      check('非白名单命令被拦下', denied.status === 400 && denied.data.error === 'confirm_required',
        `${denied.status} ${JSON.stringify(denied.data).slice(0, 200)}`);

      const piped = await call('POST', '/computer/shell', { command: 'Get-Date | Select-Object -First 1' });
      check('带管道的命令被拦下', piped.status === 400 && piped.data.error === 'confirm_required',
        `${piped.status} ${JSON.stringify(piped.data).slice(0, 200)}`);

      const forced = await call('POST', '/computer/shell', { command: 'echo abb-force-ok', force: true });
      check('带 force 的命令执行成功', forced.status === 200 && /abb-force-ok/.test(String(forced.data.data && forced.data.data.stdout)),
        `${forced.status} ${JSON.stringify(forced.data).slice(0, 300)}`);

      const timeoutRun = await call('POST', '/computer/shell', { command: 'Start-Sleep -Seconds 30', force: true, timeoutMs: 1500 });
      check('超时命令被终止并报 timeout', timeoutRun.status !== 200 && timeoutRun.data
        && timeoutRun.data.error === 'timeout', `${timeoutRun.status} ${JSON.stringify(timeoutRun.data).slice(0, 200)}`);
    }

    console.log('\n[5] 剪贴板往返（会短暂覆盖剪贴板，结束回写原内容）');
    {
      const before = await call('POST', '/computer/clipboard', { action: 'read' });
      const original = before.data && before.data.data ? String(before.data.data.text || '') : '';
      check('读取剪贴板返回 200', before.status === 200, `${before.status} ${JSON.stringify(before.data).slice(0, 200)}`);

      const denied = await call('POST', '/computer/clipboard', { action: 'write', text: 'x' });
      check('写剪贴板不传 force 被拦下', denied.status === 400 && denied.data.error === 'confirm_required',
        `${denied.status} ${JSON.stringify(denied.data).slice(0, 200)}`);

      const marker = 'abb-clip-test-' + Date.now();
      const w = await call('POST', '/computer/clipboard', { action: 'write', text: marker, force: true });
      check('带 force 写入剪贴板成功', w.status === 200, `${w.status} ${JSON.stringify(w.data).slice(0, 200)}`);

      const after = await call('POST', '/computer/clipboard', { action: 'read' });
      let readBack = after.data && after.data.data ? String(after.data.data.text || '') : '';
      // 机器上别的程序也可能在写剪贴板，给几次重试再判定
      for (let i = 0; i < 5 && readBack !== marker; i++) {
        await sleep(120);
        const again = await call('POST', '/computer/clipboard', { action: 'read' });
        readBack = again.data && again.data.data ? String(again.data.data.text || '') : '';
      }
      check('读回的就是刚写入的内容', readBack === marker, (readBack || '(空)').slice(0, 80));

      const restore = await call('POST', '/computer/clipboard', { action: 'write', text: original, force: true });
      check('回写原剪贴板内容成功', restore.status === 200, `${restore.status} ${JSON.stringify(restore.data).slice(0, 200)}`);
    }

    console.log('\n[6] 鼠标移动');
    {
      const before = await call('POST', '/computer/move', { x: 200, y: 200 });
      check('移动鼠标返回 200', before.status === 200, `${before.status} ${JSON.stringify(before.data).slice(0, 200)}`);
      const missing = await call('POST', '/computer/move', { x: 1 });
      check('缺 y 返回 missing_xy', missing.status === 400 && missing.data.error === 'missing_xy',
        `${missing.status} ${JSON.stringify(missing.data).slice(0, 200)}`);
    }

    console.log('\n[7] 音量与媒体控制');
    {
      const r = await call('POST', '/computer/media', { op: 'get' });
      const d = r.data && r.data.data;
      check('读取音量返回 200', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
      check('返回 volumePercent 0-100', !!d && typeof d.volumePercent === 'number'
        && d.volumePercent >= 0 && d.volumePercent <= 100, d && d.volumePercent);
      check('返回 muted 布尔值', !!d && typeof d.muted === 'boolean', d && d.muted);
    }

    console.log('\n[8] 进程清单与门禁');
    {
      const r = await call('POST', '/computer/process', { mode: 'list' });
      const rows = (r.data && r.data.data && r.data.data.processes) || [];
      check('进程清单返回 200 且非空', r.status === 200 && rows.length > 10,
        `${r.status} 共 ${rows.length} 个`);
      const first = rows[0] || {};
      check('进程条目带 Id/ProcessName', 'Id' in first && 'ProcessName' in first, JSON.stringify(first).slice(0, 200));

      const denied = await call('POST', '/computer/process', { mode: 'kill', pid: 999999 });
      check('kill 不传 force 被拦下', denied.status === 400 && denied.data.error === 'confirm_required',
        `${denied.status} ${JSON.stringify(denied.data).slice(0, 200)}`);
    }

    console.log('\n[9] Windows 通知');
    {
      const r = await call('POST', '/computer/notify', { title: 'browser-bridge 自测', message: '如果你看到这条通知，说明桌面控制的通知链路正常。' });
      check('通知返回 200', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    }

    console.log('\n[10] 按键注入');
    if (process.env.ABB_COMPUTER_KEY_TEST === '1') {
      const r = await call('POST', '/computer/key', { key: 'F15' });
      check('F15（无害保留键）派发成功', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);

      // 组合键路径：修饰键按下/抬起 + 保留键，F15 基本不被任何应用绑定。
      // 这条用例对应过 [ushort] 类型与 Combo 数组长度两个真实 bug。
      const c = await call('POST', '/computer/key', { key: 'ctrl+alt+shift+f15' });
      check('组合键 ctrl+alt+shift+F15 派发成功', c.status === 200, `${c.status} ${JSON.stringify(c.data).slice(0, 200)}`);
    } else {
      skipped('按键注入', '会落进用户当前焦点窗口，需 ABB_COMPUTER_KEY_TEST=1');
    }

    console.log('\n[11] 批量执行');
    {
      const r = await call('POST', '/computer/batch', {
        ops: [
          { action: 'computerWindows', params: {} },
          { action: 'computerMedia', params: { op: 'get' } }
        ]
      });
      const results = (r.data && r.data.results) || [];
      check('批量返回 200', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
      check('两步都成功', r.data && r.data.ok === true && results.length === 2 && results.every((x) => x.ok),
        JSON.stringify(results).slice(0, 300));
      check('结果带窗口清单', !!(results[0] && results[0].data && results[0].data.windows),
        JSON.stringify(results[0]).slice(0, 200));

      const bad = await call('POST', '/computer/batch', {
        ops: [
          { action: 'computerWindows', params: {} },
          { action: 'computerClick', params: {} }
        ]
      });
      const badResults = (bad.data && bad.data.results) || [];
      check('参数错的那步报 missing_xy', bad.status === 200 && badResults[1]
        && badResults[1].ok === false && badResults[1].error === 'missing_xy',
        `${bad.status} ${JSON.stringify(badResults).slice(0, 300)}`);
      check('整体 ok=false', bad.data && bad.data.ok === false);

      const gate = await call('POST', '/computer/batch', {
        ops: [
          { action: 'computerWindows', params: {} },
          { action: 'computerClipboard', params: { action: 'write', text: 'x' } }
        ]
      });
      check('批量里门禁不过整批拒绝', gate.status === 400 && gate.data.error === 'confirm_required',
        `${gate.status} ${JSON.stringify(gate.data).slice(0, 200)}`);

      const tooMany = await call('POST', '/computer/batch', {
        ops: new Array(51).fill({ action: 'computerWindows', params: {} })
      });
      check('超过 50 步被拒绝', tooMany.status === 400 && tooMany.data.error === 'too_many_ops',
        `${tooMany.status} ${JSON.stringify(tooMany.data).slice(0, 200)}`);
    }

    console.log('\n[12] 多 agent 写锁');
    {
      const before = await call('POST', '/computer/clipboard', { action: 'read' });
      const original = before.data && before.data.data ? String(before.data.data.text || '') : '';

      // agent-a 用 batch 占住写锁：先回写原内容（不改变剪贴板），再睡 3 秒
      const holder = call('POST', '/computer/batch', {
        ops: [
          { action: 'computerClipboard', params: { action: 'write', text: original, force: true } },
          { action: 'computerShell', params: { command: 'Start-Sleep -Seconds 3', force: true } }
        ]
      }, { 'X-ABB-Agent': 'agent-a' });

      await sleep(700);
      const busy = await call('POST', '/computer/clipboard',
        { action: 'write', text: original, force: true, waitMs: 0 }, { 'X-ABB-Agent': 'agent-b' });
      check('写锁被占时立即 409', busy.status === 409 && busy.data.error === 'desktop_busy',
        `${busy.status} ${JSON.stringify(busy.data).slice(0, 200)}`);
      check('409 里带持有者', busy.data && busy.data.holder === 'agent-a', busy.data && busy.data.holder);

      const queued = await call('POST', '/computer/clipboard',
        { action: 'write', text: original, force: true, waitMs: 10000 }, { 'X-ABB-Agent': 'agent-b' });
      check('排队等待后成功', queued.status === 200, `${queued.status} ${JSON.stringify(queued.data).slice(0, 200)}`);

      const held = await holder;
      check('批量持锁期间执行完成', held.data && held.data.ok === true, JSON.stringify(held.data).slice(0, 200));
    }

    console.log('\n[13] 无人值守策略与请求幂等');
    {
      const h = await call('GET', '/health');
      check('health 暴露策略状态', h.data.desktopPolicy
        && h.data.desktopPolicy.enabled === true
        && h.data.desktopPolicy.agents.includes('policy-shell'),
      JSON.stringify(h.data.desktopPolicy));

      const shellOk = await call('POST', '/computer/shell',
        { command: 'echo policy-ok' }, { 'X-ABB-Agent': 'policy-shell' });
      check('策略允许的 shell 免 force', shellOk.status === 200
        && /policy-ok/.test(String(shellOk.data.data && shellOk.data.data.stdout)),
      `${shellOk.status} ${JSON.stringify(shellOk.data).slice(0, 200)}`);

      const shellNo = await call('POST', '/computer/shell',
        { command: 'Start-Sleep -Milliseconds 10' }, { 'X-ABB-Agent': 'policy-shell' });
      check('策略外的 shell 仍需 force', shellNo.status === 400
        && shellNo.data.error === 'confirm_required',
      `${shellNo.status} ${JSON.stringify(shellNo.data).slice(0, 200)}`);

      const denied = await call('POST', '/computer/notify',
        { title: 'policy', message: 'denied', force: true }, { 'X-ABB-Agent': 'policy-denied' });
      check('deny 连 force 一起挡', denied.status === 403
        && denied.data.error === 'policy_denied',
      `${denied.status} ${JSON.stringify(denied.data).slice(0, 200)}`);

      const ro = await call('POST', '/computer/move',
        { x: 1, y: 1 }, { 'X-ABB-Agent': 'policy-readonly' });
      check('只读 agent 的写动作被拒', ro.status === 403
        && ro.data.error === 'policy_read_only',
      `${ro.status} ${JSON.stringify(ro.data).slice(0, 200)}`);

      const rid = 'replay-' + Date.now();
      const first = await call('POST', '/computer/windows', { op: 'list', requestId: rid });
      const second = await call('POST', '/computer/windows', { op: 'list', requestId: rid });
      check('同 requestId 第二次回放', second.status === 200
        && JSON.stringify(second.data) === JSON.stringify(first.data),
      '两次响应体不一致');

      const badId = await call('POST', '/computer/windows',
        { op: 'list', requestId: 'bad id with spaces' });
      check('非法 requestId 返回 400', badId.status === 400
        && badId.data.error === 'bad_request_id',
      `${badId.status} ${JSON.stringify(badId.data).slice(0, 200)}`);

      const m = await call('GET', '/health');
      check('幂等命中计数增加', m.data.desktopIdempotency.hits >= 1,
        JSON.stringify(m.data.desktopIdempotency));
      check('指标记录动作耗时', m.data.desktopMetrics.calls > 0
        && !!m.data.desktopMetrics.byAction.computerWindows,
      JSON.stringify(m.data.desktopMetrics).slice(0, 200));
    }
  } finally {
    child.kill();
    try { fs.rmSync(policyDir, { recursive: true, force: true }); } catch (e) { /* 已尽力 */ }
  }

  if (stderrTail) {
    console.log('\n服务端 stderr（末尾）:\n' + stderrTail.trim().split('\n').slice(-5).join('\n'));
  }
  console.log(`\n通过 ${pass}，失败 ${fail}，跳过 ${skip}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试意外中断:', e && e.message);
  process.exit(1);
});
