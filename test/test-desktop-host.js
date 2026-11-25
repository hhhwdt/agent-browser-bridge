#!/usr/bin/env node
/**
 * 常驻桌面宿主的实机测试（Windows）。非 Windows 直接跳过。
 *
 * 验证：握手、热路径延迟、6 个能力域、结构化错误、进程被杀后自动重启。
 * 自己起一个宿主进程，不碰 18777 上的服务。
 *
 *   node test-desktop-host.js
 *
 * 环境变量：
 *   ABB_DESKTOP_HOST_TEST=1  额外跑剪贴板写入（会短暂覆盖剪贴板，结束后回写）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { DesktopHost } = require('../src/computer/host.js');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    if (process.platform !== 'win32') {
        console.log('\n非 Windows 平台，宿主实机测试跳过。');
        process.exit(0);
    }

    const host = new DesktopHost({ name: 'test', autoRestart: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-host-test-'));
    const shot = path.join(dir, 'shot.png');

    try {
        const started = Date.now();
        await host.start();
        check('宿主启动并完成握手', host.running && host.status().pid > 0, JSON.stringify(host.status()));
        console.log(`      启动耗时 ${Date.now() - started}ms`);

        console.log('\n[1] 热路径');
        {
            const t0 = Date.now();
            for (let i = 0; i < 100; i++) { await host.call('ping', {}); }
            const total = Date.now() - t0;
            check('100 次连续调用 < 3 秒', total < 3000, total + 'ms');
            // 逐次记录，取 p95
            const samples = [];
            for (let i = 0; i < 50; i++) {
                const s = Date.now();
                await host.call('ping', {});
                samples.push(Date.now() - s);
            }
            samples.sort((a, b) => a - b);
            const p95 = samples[Math.floor(samples.length * 0.95) - 1];
            check('p95 单次调用 < 50ms', p95 < 50, p95 + 'ms');
            console.log(`      100 次 ${total}ms，p95 ${p95}ms`);
        }

        console.log('\n[2] 窗口清单');
        {
            const w = await host.call('windows', { op: 'list' });
            const rows = w.windows || [];
            check('返回窗口数组', Array.isArray(rows), typeof rows);
            check('至少一个可见窗口', rows.length > 0, rows.length);
            if (rows.length) {
                const row = rows[0];
                check('条目字段完整', typeof row.hwnd === 'number' && typeof row.title === 'string'
                    && typeof row.pid === 'number' && row.bounds, JSON.stringify(row).slice(0, 200));
            }

            // 进程名按 pid 缓存 60 秒，第二次起应回到枚举本身的量级
            const samples = [];
            for (let i = 0; i < 5; i++) {
                const s = Date.now();
                await host.call('windows', { op: 'list' });
                samples.push(Date.now() - s);
            }
            check('窗口清单热路径 < 100ms', samples[samples.length - 1] < 100, samples.join(','));
            console.log(`      连续 5 次 ${samples.join('/')}ms`);
        }

        console.log('\n[3] 截图');
        {
            const r = await host.call('screen', { mode: 'screen', region: { x: 0, y: 0, w: 160, h: 120 }, out: shot });
            check('区域截图成功', r.ok === true && r.width === 160 && r.height === 120, JSON.stringify(r));
            check('PNG 文件落盘', fs.existsSync(shot) && fs.statSync(shot).size > 100,
                fs.existsSync(shot) ? fs.statSync(shot).size : 'missing');
        }

        console.log('\n[4] 剪贴板');
        {
            const before = await host.call('clip', { op: 'get' });
            check('读取剪贴板成功', before.ok === true && typeof before.length === 'number', JSON.stringify(before).slice(0, 200));
            if (process.env.ABB_DESKTOP_HOST_TEST === '1') {
                const original = String(before.text || '');
                const marker = 'abb-host-clip-' + Date.now();
                await host.call('clip', { op: 'set', text: marker });
                const after = await host.call('clip', { op: 'get' });
                check('写入后读回一致', String(after.text || '') === marker, String(after.text || '').slice(0, 60));
                await host.call('clip', { op: 'set', text: original });
                const restored = await host.call('clip', { op: 'get' });
                check('原内容已回写', String(restored.text || '') === original, String(restored.text || '').slice(0, 60));
            } else {
                skipped('剪贴板写入', '会覆盖剪贴板，需 ABB_DESKTOP_HOST_TEST=1');
            }
        }

        console.log('\n[5] 音量');
        {
            const a = await host.call('audio', { op: 'get' });
            check('读取音量成功', a.ok === true && typeof a.volumePercent === 'number', JSON.stringify(a));
            check('音量在 0-100', a.volumePercent >= 0 && a.volumePercent <= 100, a.volumePercent);
            check('muted 是布尔值', typeof a.muted === 'boolean', typeof a.muted);
        }

        console.log('\n[6] 结构化错误');
        {
            let err = null;
            try { await host.call('windows', { op: 'activate', title: '__abb_no_such_window__' }); }
            catch (e) { err = e; }
            check('找不到窗口回 window_not_found', err && err.code === 'window_not_found', err && err.code);
            check('错误不是超时/崩溃', !host.status().lastError || !/host_timeout|host_exit/.test(host.status().lastError),
                host.status().lastError);

            let err2 = null;
            try { await host.call('nope', {}); } catch (e) { err2 = e; }
            check('未知 fn 回 unknown_fn', err2 && /unknown_fn/.test(String(err2.code)), err2 && err2.code);
        }

        console.log('\n[7] 崩溃自动重启');
        {
            const pidBefore = host.status().pid;
            host._kill();
            await sleep(900);
            const p = await host.call('ping', {}, { timeoutMs: 15000 });
            const st = host.status();
            check('宿主重启后有响应', p.ok === true && st.pid > 0 && st.pid !== pidBefore,
                JSON.stringify({ pidBefore, pid: st.pid }));
            check('重启计数增加', st.restarts >= 1, st.restarts);
            check('未留失败请求', st.pending === 0, st.pending);
        }

        console.log('\n[8] 宿主池分配');
        {
            const { DesktopPool } = require('../src/computer/host.js');
            const pool = new DesktopPool({ size: 2 });
            try {
                await pool.startAll();
                await Promise.all([pool.call('ping', {}), pool.call('ping', {})]);
                const st = pool.status();
                check('两个宿主都启动了', st.workers.every((w) => w.running),
                    JSON.stringify(st.workers.map((w) => w.running)));
                check('两个宿主都分担了请求', st.workers.every((w) => w.calls >= 1),
                    JSON.stringify(st.workers.map((w) => w.calls)));
            } finally {
                await pool.stop();
            }
        }
    } finally {
        await host.stop();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 已尽力 */ }
    }

    console.log(`\n通过 ${pass}，失败 ${fail}，跳过 ${skip}`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试意外中断:', e && e.stack || e); process.exit(1); });
