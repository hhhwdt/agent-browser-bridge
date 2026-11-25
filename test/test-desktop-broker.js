#!/usr/bin/env node
/**
 * 桌面写锁与多 agent 身份（离线，不碰桌面）。
 *
 *   node test-desktop-broker.js
 */

'use strict';

const { DesktopBroker, agentOf } = require('../src/computer/broker.js');
const { isWriteVerb } = require('../src/computer/dispatch.js');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 300)}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('\n[1] agent 身份解析');
    check('缺头时用 default', agentOf({ headers: {} }) === 'default');
    check('正常头原样返回', agentOf({ headers: { 'x-abb-agent': 'agent-a' } }) === 'agent-a');
    check('大写会转小写', agentOf({ headers: { 'x-abb-agent': 'Agent-B' } }) === 'agent-b');
    check('非法字符被丢弃', agentOf({ headers: { 'x-abb-agent': 'a b/c?#d' } }) === 'abcd');
    check('全非法字符回 default', agentOf({ headers: { 'x-abb-agent': '///' } }) === 'default');
    check('超长截到 40', agentOf({ headers: { 'x-abb-agent': 'x'.repeat(80) } }).length === 40);

    console.log('\n[2] 读写分类');
    check('点按是写', isWriteVerb('computerClick', {}) === true);
    check('键入是写', isWriteVerb('computerType', { text: 'x' }) === true);
    check('按键是写', isWriteVerb('computerKey', { key: 'Enter' }) === true);
    check('截屏不是写', isWriteVerb('computerScreen', {}) === false);
    check('窗口清单不是写', isWriteVerb('computerWindows', {}) === false);
    check('窗口 info 不是写', isWriteVerb('computerWindow', { action: 'info' }) === false);
    check('窗口 activate 是写', isWriteVerb('computerWindow', { action: 'activate' }) === true);
    check('剪贴板读不是写', isWriteVerb('computerClipboard', { action: 'read' }) === false);
    check('剪贴板写是写', isWriteVerb('computerClipboard', { action: 'write' }) === true);
    check('shell 不进桌面锁', isWriteVerb('computerShell', { command: 'Get-Date' }) === false);
    check('批量本身不分类', isWriteVerb('computerBatch', {}) === false);

    console.log('\n[3] 同 agent 重入');
    {
        const b = new DesktopBroker();
        const r1 = await b.acquire('a');
        const r2 = await b.acquire('a');
        check('重入后仍由 a 持有', b.status().holder === 'a' && b.status().depth === 2, JSON.stringify(b.status()));
        r1();
        check('释放一层仍被持有', b.status().holder === 'a' && b.status().depth === 1, JSON.stringify(b.status()));
        r2();
        check('释放两层后空闲', b.status().holder === null, JSON.stringify(b.status()));
    }

    console.log('\n[4] 不同 agent 冲突');
    {
        const b = new DesktopBroker();
        const release = await b.acquire('a');
        let err = null;
        try { await b.acquire('b', { waitMs: 0 }); } catch (e) { err = e; }
        check('立即返回 desktop_busy', err && err.code === 'desktop_busy', err && err.message);
        check('错误里带持有者', err && err.holder === 'a', err && err.holder);
        release();
        const again = await b.acquire('b');
        check('释放后 b 能拿到', b.status().holder === 'b');
        again();
    }

    console.log('\n[5] 排队与 FIFO');
    {
        const b = new DesktopBroker();
        const releaseA = await b.acquire('a');
        const order = [];
        const pB = b.acquire('b', { waitMs: 2000 }).then((rel) => { order.push('b'); return rel; });
        await sleep(30);
        const pC = b.acquire('c', { waitMs: 2000 }).then((rel) => { order.push('c'); return rel; });
        await sleep(30);
        check('两个等待者在排队', b.status().queue === 2, JSON.stringify(b.status()));
        check('排队时 holder 仍是 a', b.status().holder === 'a');
        releaseA();
        const relB = await pB;
        check('先到的 b 先拿到', order.join(',') === 'b' && b.status().holder === 'b', order.join(','));
        relB();
        const relC = await pC;
        check('c 随后拿到', order.join(',') === 'b,c' && b.status().holder === 'c', order.join(','));
        relC();
        check('全部释放后空闲', b.status().holder === null && b.status().queue === 0);
    }

    console.log('\n[6] 排队超时');
    {
        const b = new DesktopBroker();
        const release = await b.acquire('a');
        const started = Date.now();
        let err = null;
        try { await b.acquire('b', { waitMs: 120 }); } catch (e) { err = e; }
        const elapsed = Date.now() - started;
        check('超时返回 desktop_busy', err && err.code === 'desktop_busy', err && err.message);
        check('等待接近 120ms', elapsed >= 100 && elapsed < 1000, elapsed + 'ms');
        check('超时后队列清空', b.status().queue === 0, JSON.stringify(b.status()));
        release();
    }

    console.log('\n[7] 重复释放是幂等的');
    {
        const b = new DesktopBroker();
        const release = await b.acquire('a');
        release();
        release();
        release();
        check('多次释放不会把 depth 减成负数', b.status().depth === 0 && b.status().holder === null,
            JSON.stringify(b.status()));
        const next = await b.acquire('b');
        check('之后仍能正常加锁', b.status().holder === 'b');
        next();
    }

    console.log(`\n通过 ${pass}，失败 ${fail}`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试意外中断:', e); process.exit(1); });
