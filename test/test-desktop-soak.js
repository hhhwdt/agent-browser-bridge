#!/usr/bin/env node
/**
 * 桌面宿主稳定性压测（soak）。
 *
 * 连续调用常驻宿主，观察失败率、延迟和进程内存增长。默认跑 60 秒，适合改完
 * 宿主代码后随手跑一遍；无人值守部署前建议跑够 24 小时：
 *
 *   node test-desktop-soak.js
 *   ABB_SOAK_SECONDS=86400 node test-desktop-soak.js
 *
 * 只调用 ping / windows / 区域截图 / UIA 树这些读操作，不动鼠标键盘，也不碰
 * 18777。非 Windows 平台直接跳过。
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopHost } = require('../src/computer/host.js');

const DURATION_S = Math.max(5, Number(process.env.ABB_SOAK_SECONDS || 60));
const INTERVAL_MS = Math.max(50, Number(process.env.ABB_SOAK_INTERVAL_MS || 200));
const TREE_EVERY = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else {
        fail++;
        console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 300)}`);
    }
}

/** 任务管理器口径的内存（KB → MB）；解析失败返回 null。 */
function memoryMb(pid) {
    try {
        const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'],
            { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        const m = out.match(/"([\d.,\s]+) K"/);
        if (!m) { return null; }
        return Math.round(Number(m[1].replace(/[.,\s]/g, '')) / 1024);
    } catch (e) {
        return null;
    }
}

function stats(samples) {
    if (samples.length === 0) { return { n: 0, avg: 0, p95: 0, max: 0 }; }
    const sorted = samples.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    return {
        n: samples.length,
        avg: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
        p95,
        max: sorted[sorted.length - 1]
    };
}

(async () => {
    if (process.platform !== 'win32') {
        console.log('\n非 Windows 平台，桌面宿主压测跳过。');
        process.exit(0);
    }

    const host = new DesktopHost({ name: 'soak' });
    await host.start();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-soak-'));
    const shotFile = path.join(tmpDir, 'shot.png');
    const pid = host.child && host.child.pid;
    const rssStart = pid ? memoryMb(pid) : null;

    const durations = { ping: [], windows: [], screen: [], uia: [] };
    const errors = new Map();
    let cycles = 0;
    let calls = 0;
    let target = null;
    const started = Date.now();
    const deadline = started + DURATION_S * 1000;

    console.log(`\n压测 ${DURATION_S}s，间隔 ${INTERVAL_MS}ms，宿主 pid=${pid}`
        + (rssStart === null ? '' : `，起始内存 ${rssStart}MB`));

    try {
        while (Date.now() < deadline) {
            cycles++;

            await timed('ping', () => host.call('ping', {}));
            await timed('windows', async () => {
                const r = await host.call('windows', { op: 'list' });
                if (!target) {
                    target = (r.windows || []).find((w) => !w.minimized) || null;
                }
                return r;
            });
            await timed('screen', () => host.call('screen', {
                region: { x: 0, y: 0, w: 160, h: 120 }, out: shotFile
            }));

            if (target && cycles % TREE_EVERY === 0) {
                await timed('uia', () => host.call('uia', {
                    op: 'tree', hwnd: target.hwnd, depth: 1, maxNodes: 8
                }));
            }

            await sleep(INTERVAL_MS);
        }
    } finally {
        const rssEnd = pid ? memoryMb(pid) : null;
        const status = host.status();
        await host.stop();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 已尽力 */ }

        console.log(`\n调用 ${calls} 次 / ${cycles} 轮，失败 ${host.errorCount} 次`);
        for (const key of Object.keys(durations)) {
            const s = stats(durations[key]);
            if (s.n === 0) { continue; }
            console.log(`  ${key.padEnd(8)} n=${s.n}  avg=${s.avg}ms  p95=${s.p95}ms  max=${s.max}ms`);
        }
        if (errors.size > 0) {
            console.log('  错误分布: ' + [...errors.entries()]
                .map(([code, n]) => `${code}x${n}`).join(', '));
        }

        check('没有调用失败', host.errorCount === 0,
            [...errors.keys()].join(','));
        check('没有宿主重启', status.restarts === 0, 'restarts=' + status.restarts);
        check('ping p95 < 50ms', stats(durations.ping).p95 < 50, stats(durations.ping).p95);
        check('区域截图 p95 < 500ms', stats(durations.screen).p95 < 500,
            stats(durations.screen).p95);
        if (durations.uia.length > 0) {
            check('UIA 树 p95 < 1000ms', stats(durations.uia).p95 < 1000,
                stats(durations.uia).p95);
        }
        if (rssStart !== null && rssEnd !== null) {
            const delta = rssEnd - rssStart;
            console.log(`  内存 ${rssStart}MB -> ${rssEnd}MB (${delta >= 0 ? '+' : ''}${delta}MB)`);
            check('内存增长 < 80MB', delta < 80, delta + 'MB');
        }

        console.log(`\n通过 ${pass}，失败 ${fail}`);
        process.exit(fail ? 1 : 0);
    }

    /** 执行一次并把耗时/错误记下来。 */
    async function timed(name, fn) {
        const t0 = Date.now();
        calls++;
        try {
            return await fn();
        } catch (e) {
            const code = (e && e.code) || 'error';
            errors.set(code, (errors.get(code) || 0) + 1);
            return null;
        } finally {
            durations[name].push(Date.now() - t0);
        }
    }
})().catch((e) => { console.error('压测意外中断:', e && e.stack || e); process.exit(1); });
