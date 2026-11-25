#!/usr/bin/env node
/**
 * 无人值守运行时：策略文件、幂等表、指标。
 *
 * 三块都不碰桌面，也不起服务，纯离线。
 *
 *   node test-desktop-runtime.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopPolicy } = require('../src/computer/policy.js');
const { IdempotencyStore } = require('../src/computer/idempotency.js');
const { DesktopMetrics } = require('../src/computer/metrics.js');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else {
        fail++;
        console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 240)}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-runtime-'));
const policyFile = path.join(dir, 'desktop-policy.json');

/** 写一份策略并返回新实例（实例按 mtime 重载）。 */
function loadPolicy(json) {
    fs.writeFileSync(policyFile, typeof json === 'string' ? json : JSON.stringify(json), 'utf8');
    return new DesktopPolicy();
}

(async () => {
    process.env.ABB_DESKTOP_POLICY = policyFile;
    fs.rmSync(policyFile, { force: true });

    console.log('\n[1] 没有策略文件时行为不变');
    {
        const p = new DesktopPolicy();
        check('enabled=false', p.status().enabled === false, JSON.stringify(p.status()));
        check('不拒绝任何动作', p.denyFor('a', 'computerShell', { write: true }) === null);
        check('不预先授权 force', p.allowsForce('a', 'computerWindow', { action: 'close' }) === false);
    }

    console.log('\n[2] 默认段 allowForce');
    {
        const p = loadPolicy({
            version: 1,
            default: { allowForce: ['computerWindow', 'computerProcess'] }
        });
        check('策略已加载', p.status().enabled === true, JSON.stringify(p.status()));
        check('allowForce 命中窗口动作',
            p.allowsForce('x', 'computerWindow', { action: 'close' }) === true);
        check('未列出的动作仍要 force',
            p.allowsForce('x', 'computerShell', { command: 'Get-Date' }) === false);
        check('deny 为空时不拒绝', p.denyFor('x', 'computerNotify', { write: false }) === null);
    }

    console.log('\n[3] deny 与 shellAllow');
    {
        const p = loadPolicy({
            version: 1,
            default: {
                allowForce: ['computerShell'],
                shellAllow: ['^Get-', '^Test-'],
                deny: ['computerNotify']
            }
        });
        check('命中 shellAllow 的命令免 force',
            p.allowsForce('x', 'computerShell', { command: 'Get-Date' }) === true);
        check('不在 shellAllow 的命令仍需 force',
            p.allowsForce('x', 'computerShell', { command: 'Remove-Item C:\\x' }) === false);
        check('deny 优先于 allowForce', p.denyFor('x', 'computerNotify', { write: false }).code
            === 'policy_denied', JSON.stringify(p.denyFor('x', 'computerNotify', { write: false })));
        check('拒绝提示给出策略文件',
            String(p.denyFor('x', 'computerNotify', { write: false }).hint).includes('desktop-policy.json'));
    }

    console.log('\n[4] readOnly 与按 agent 合并');
    {
        const p = loadPolicy({
            version: 1,
            default: { allowForce: ['computerWindow'] },
            agents: {
                'ci-runner': { allowForce: ['computerProcess'], readOnly: true },
                watcher: { readOnly: true }
            }
        });
        check('只读 agent 的写动作被拒', p.denyFor('ci-runner', 'computerClick', { write: true }).code
            === 'policy_read_only');
        check('只读 agent 的读动作放行', p.denyFor('ci-runner', 'computerWindows', { write: false }) === null);
        check('agent 继承 default 的 allowForce',
            p.allowsForce('ci-runner', 'computerWindow', { action: 'close' }) === true);
        check('agent 自己的 allowForce 生效',
            p.allowsForce('ci-runner', 'computerProcess', { mode: 'kill' }) === true);
        check('未登记的 agent 用 default',
            p.allowsForce('someone', 'computerProcess', { mode: 'kill' }) === false);
        check('readOnly 可以只给某个 agent',
            p.denyFor('someone', 'computerClick', { write: true }) === null);
        check('agent 名大小写不敏感',
            p.denyFor('CI-Runner', 'computerClick', { write: true }).code === 'policy_read_only');
    }

    console.log('\n[5] 坏文件与无效项');
    {
        const p = loadPolicy({ version: 1, default: { allowForce: ['computerWindow'] } });
        check('好文件先加载成功', p.status().enabled === true);
        fs.writeFileSync(policyFile, '{ not json', 'utf8');
        const after = p.status();
        check('解析失败时保留上一次的规则', after.enabled === true
            && p.allowsForce('x', 'computerWindow', { action: 'close' }) === true, JSON.stringify(after));
        check('错误暴露在状态里', typeof after.error === 'string' && after.error.length > 0, after.error);
    }
    {
        const p = loadPolicy({
            version: 1,
            default: {
                allowForce: ['computerWindow', 'computerShell', 'notAnAction', 'computerWindow'],
                deny: 'wrong',
                shellAllow: ['[', '^Get-']
            }
        });
        const st = p.status();
        check('非法动作名被忽略并记警告', st.defaultAllowForce.length === 2
            && st.warnings.some((w) => w.includes('notAnAction')), JSON.stringify(st));
        check('deny 不是数组时按空处理', Array.isArray(st.defaultDeny) && st.defaultDeny.length === 0);
        check('无效正则被跳过，其余仍生效',
            p.allowsForce('x', 'computerShell', { command: 'Get-Date' }) === true);
    }

    console.log('\n[6] 幂等表');
    {
        const store = new IdempotencyStore({ ttlMs: 60000, max: 3 });
        check('接受普通 id', store.validId('run-42.retry_1:a') === true);
        check('拒绝空 id', store.validId('') === false);
        check('拒绝带空格的 id', store.validId('a b') === false);
        check('拒绝超长 id', store.validId('x'.repeat(65)) === false);
        check('拒绝非字符串', store.validId(42) === false);

        const key = store.key('A', 'req1');
        check('key 含 agent 且统一小写', key === 'a|req1', key);
        check('首次查询没有结果', store.lookup(key) === null);

        store.begin(key);
        check('执行中查询返回 pending', typeof store.lookup(key).pending === 'object');
        store.finish(key, 200, { ok: true, n: 1 });
        const hit = store.lookup(key);
        check('完成后回放状态与响应体', hit.status === 200 && hit.body.n === 1, JSON.stringify(hit));

        check('不同 agent 的同名 id 互不影响',
            store.lookup(store.key('B', 'req1')) === null);

        store.begin(store.key('A', 'req2'));
        const waiter = store.lookup(store.key('A', 'req2')).pending;
        store.abort(store.key('A', 'req2'));
        check('abort 后重试重新执行', store.lookup(store.key('A', 'req2')) === null);
        check('等待者被唤醒并收到 null', (await waiter) === null);

        const ttl = new IdempotencyStore({ ttlMs: 30 });
        const tk = ttl.key('a', 'old');
        ttl.begin(tk);
        ttl.finish(tk, 200, { ok: true });
        await sleep(60);
        check('超过 TTL 后不再回放', ttl.lookup(tk) === null);

        const lru = new IdempotencyStore({ ttlMs: 60000, max: 2 });
        for (const id of ['k1', 'k2', 'k3']) {
            lru.begin(lru.key('a', id));
            lru.finish(lru.key('a', id), 200, { ok: true });
        }
        check('超过条数上限时丢最老的已完成项', lru.lookup(lru.key('a', 'k1')) === null
            && lru.lookup(lru.key('a', 'k3')).status === 200);

        const st = lru.status();
        check('状态里有命中与丢弃计数', st.entries === 2 && st.evicted >= 1 && st.hits >= 1,
            JSON.stringify(st));
    }

    console.log('\n[7] 指标');
    {
        const m = new DesktopMetrics({ window: 8 });
        m.record('computerClick', 'ok', 10);
        m.record('computerClick', 'failed', 30);
        m.record('computerWindows', 'busy', 0);
        m.record('computerTree', 'replay', 500);
        m.record('computerTree', 'invalid', 4);
        const s = m.snapshot();
        check('分类计数正确', s.calls === 5 && s.ok === 1 && s.failed === 1
            && s.busy === 1 && s.replay === 1 && s.invalid === 1, JSON.stringify(s));
        check('回放不计入耗时样本', s.samples === 4, s.samples);
        check('p95 落在真实耗时上', s.p95Ms === 30, s.p95Ms);
        check('按动作统计', s.byAction.computerClick.calls === 2
            && s.byAction.computerClick.ok === 1 && s.byAction.computerClick.failed === 1,
            JSON.stringify(s.byAction.computerClick));
        check('空指标也给出稳定结构', new DesktopMetrics().snapshot().calls === 0);
    }

    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ABB_DESKTOP_POLICY;
    console.log(`\n通过 ${pass}，失败 ${fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('测试意外中断:', e && e.stack || e);
    process.exit(1);
});
