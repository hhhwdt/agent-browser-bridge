#!/usr/bin/env node
/**
 * UIA 动作族（tree / find / act / wait_for）的实机测试。
 *
 * 自己拉起一个隔离端口上的桥接实例（18998）和一个 WPF 测试窗口，
 * 不碰 18777，也不碰用户的其他窗口。测试窗口由本进程创建，结束时关闭。
 *
 *   node test-computer-uia.js
 *
 * 非 Windows 平台直接跳过（退出码 0）。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 18998;
const HOST = '127.0.0.1';
const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const TITLE = 'ABB UIA Test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 300)}`); }
}

function call(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: HOST,
            port: PORT,
            method,
            path: urlPath,
            headers: payload
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                : {}
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

async function waitHealth(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const r = await call('GET', '/health');
            if (r.status === 200) { return r.data; }
        } catch (e) { /* 还没起来 */ }
        if (Date.now() > deadline) { throw new Error('服务 15 秒内没起来'); }
        await sleep(200);
    }
}

/** 测试窗口脚本：WPF 有原生 UIA provider，控件角色和模式都完整。 */
const APP = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName PresentationFramework',
    'Add-Type -AssemblyName PresentationCore',
    '$window = New-Object System.Windows.Window',
    `$window.Title = '${TITLE}'`,
    '$window.Width = 420',
    '$window.Height = 260',
    '$window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::CenterScreen',
    '$stack = New-Object System.Windows.Controls.StackPanel',
    '$stack.Margin = New-Object System.Windows.Thickness(20)',
    '$box = New-Object System.Windows.Controls.TextBox',
    "$box.Name = 'txtName'",
    '$box.Height = 30',
    '$stack.Children.Add($box) | Out-Null',
    '$btn = New-Object System.Windows.Controls.Button',
    "$btn.Name = 'btnOk'",
    "$btn.Content = 'OK'",
    '$btn.Height = 32',
    '$btn.Margin = New-Object System.Windows.Thickness(0, 12, 0, 0)',
    '$btn.Add_Click({ $window.Close() })',
    '$stack.Children.Add($btn) | Out-Null',
    '$lbl = New-Object System.Windows.Controls.Label',
    "$lbl.Name = 'lblHint'",
    "$lbl.Content = 'hello label'",
    '$stack.Children.Add($lbl) | Out-Null',
    '$window.Content = $stack',
    '$null = $window.ShowDialog()',
    ''
].join('\r\n');

async function main() {
    if (process.platform !== 'win32') {
        console.log('\n非 Windows 平台，UIA 实机测试跳过。');
        process.exit(0);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-uia-test-'));
    const appPath = path.join(dir, 'app.ps1');
    const auditPath = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(appPath, APP, 'utf8');

    const server = spawn(process.execPath,
        [SERVER, '--port', String(PORT), '--no-token', '--log-file', auditPath], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, ABB_SKIP_UPDATE_CHECK: '1' }
        });
    let stderrTail = '';
    server.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-2000); });

    const app = spawn('powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', appPath], { stdio: 'ignore' });

    try {
        await waitHealth();

        // 窗口创建和 UIA 树就绪都有一点延迟，轮询到能读到控件为止
        let tree = null;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            const r = await call('POST', '/computer/tree', { title: TITLE, depth: 6, patterns: true });
            if (r.status === 200 && r.data && r.data.data && r.data.data.count > 4) {
                tree = r.data.data;
                break;
            }
            await sleep(300);
        }
        check('20 秒内读到测试窗口的控件树', !!tree,
            stderrTail + ' ' + JSON.stringify(tree).slice(0, 200));
        if (!tree) { throw new Error('测试窗口没准备好'); }

        console.log('\n[1] 控件树');
        {
            const nodes = tree.nodes || [];
            const byId = (id) => nodes.find((n) => n.automationId === id);
            check('根节点是 Window', nodes[0] && nodes[0].controlType === 'Window'
                && nodes[0].depth === 0, JSON.stringify(nodes[0]));
            check('识别到 WPF 框架', nodes[0] && nodes[0].frameworkId === 'WPF', nodes[0] && nodes[0].frameworkId);
            check('找到文本框', byId('txtName') && byId('txtName').controlType === 'Edit',
                JSON.stringify(byId('txtName')));
            check('找到按钮', byId('btnOk') && byId('btnOk').controlType === 'Button',
                JSON.stringify(byId('btnOk')));
            const box = byId('txtName');
            check('文本框声明 Value 模式', box && (box.patterns || []).includes('Value'),
                box && (box.patterns || []).join('|'));
            const btn = byId('btnOk');
            check('按钮声明 Invoke 模式', btn && (btn.patterns || []).includes('Invoke'),
                btn && (btn.patterns || []).join('|'));
            check('节点带坐标', box && box.bounds && box.bounds.w > 0 && box.bounds.h > 0,
                box && JSON.stringify(box.bounds));
            check('ref 形如 eN', /^e\d+$/.test(String(box && box.ref)), box && box.ref);
            check('hint 里带窗口标题', tree.title === TITLE, tree.title);
        }

        console.log('\n[2] 深度与节点上限');
        {
            const r0 = await call('POST', '/computer/tree', { title: TITLE, depth: 0 });
            check('depth=0 只返回根节点', r0.status === 200 && r0.data.data.count === 1,
                JSON.stringify(r0.data).slice(0, 200));

            const r2 = await call('POST', '/computer/tree', { title: TITLE, depth: 6, maxNodes: 2 });
            check('maxNodes 生效且标记截断', r2.status === 200 && r2.data.data.count === 2
                && r2.data.data.truncated === true, JSON.stringify(r2.data).slice(0, 200));
        }

        console.log('\n[3] 查找');
        {
            const byId = await call('POST', '/computer/find',
                { title: TITLE, automationId: 'txtName' });
            check('按 automationId 找到 1 个', byId.status === 200 && byId.data.data.count === 1,
                JSON.stringify(byId.data).slice(0, 200));

            const byName = await call('POST', '/computer/find',
                { title: TITLE, name: 'OK', controlType: 'Button' });
            check('按名称 + 类型找到按钮', byName.status === 200 && byName.data.data.count === 1
                && byName.data.data.matches[0].automationId === 'btnOk',
                JSON.stringify(byName.data).slice(0, 200));

            const byClass = await call('POST', '/computer/find', { title: TITLE, className: 'TextBox' });
            check('按类名找到文本框', byClass.status === 200 && byClass.data.data.count >= 1,
                JSON.stringify(byClass.data).slice(0, 200));

            const noFilter = await call('POST', '/computer/find', { title: TITLE });
            check('没有过滤条件返回 400', noFilter.status === 400
                && noFilter.data.error === 'missing_filter', JSON.stringify(noFilter.data));

            const noWindow = await call('POST', '/computer/find', { name: 'OK' });
            check('没有窗口目标返回 400', noWindow.status === 400
                && noWindow.data.error === 'missing_target', JSON.stringify(noWindow.data));

            const none = await call('POST', '/computer/find',
                { title: TITLE, controlType: 'NoSuchControlType' });
            check('无匹配返回空数组', none.status === 200 && none.data.data.count === 0,
                JSON.stringify(none.data).slice(0, 200));
        }

        console.log('\n[4] 操作与读值');
        const boxRef = (tree.nodes || []).find((n) => n.automationId === 'txtName').ref;
        const labelRef = (tree.nodes || []).find((n) => n.automationId === 'lblHint').ref;
        const btnRef = (tree.nodes || []).find((n) => n.automationId === 'btnOk').ref;
        {
            const set = await call('POST', '/computer/act',
                { ref: boxRef, action: 'setValue', text: 'hello-uia' });
            check('setValue 返回 200', set.status === 200 && set.data.data.ok === true
                && set.data.data.textChars === 9, JSON.stringify(set.data).slice(0, 200));

            const get = await call('POST', '/computer/act', { ref: boxRef, action: 'getValue' });
            check('getValue 读回写入的文本', get.status === 200 && get.data.data.value === 'hello-uia',
                JSON.stringify(get.data).slice(0, 200));

            const waitOk = await call('POST', '/computer/wait', {
                title: TITLE, automationId: 'txtName', condition: 'value',
                value: 'hello-uia', timeoutMs: 3000
            });
            check('wait value 立即满足', waitOk.status === 200 && waitOk.data.data.ok === true,
                JSON.stringify(waitOk.data).slice(0, 200));

            const waitBad = await call('POST', '/computer/wait', {
                title: TITLE, automationId: 'txtName', condition: 'value',
                value: 'not-this', timeoutMs: 400
            });
            check('wait 超时返回 wait_timeout', waitBad.status === 500
                && waitBad.data.error === 'wait_timeout', JSON.stringify(waitBad.data).slice(0, 200));
            check('超时提示是中文说明', typeof waitBad.data.hint === 'string'
                && waitBad.data.hint.length > 5, waitBad.data.hint);

            const noPattern = await call('POST', '/computer/act', { ref: labelRef, action: 'invoke' });
            check('不支持的模式的报 pattern_unavailable', noPattern.status === 500
                && noPattern.data.error === 'pattern_unavailable',
                JSON.stringify(noPattern.data).slice(0, 200));
        }

        console.log('\n[5] 按钮与窗口消失');
        {
            const inv = await call('POST', '/computer/act', { ref: btnRef, action: 'invoke' });
            check('invoke 按钮返回 200', inv.status === 200 && inv.data.data.ok === true,
                JSON.stringify(inv.data).slice(0, 200));

            const gone = await call('POST', '/computer/wait', {
                title: TITLE, automationId: 'btnOk', condition: 'gone', timeoutMs: 5000
            });
            check('按钮随窗口关闭而消失', gone.status === 200
                && gone.data.data && gone.data.data.ok === true, JSON.stringify(gone.data).slice(0, 200));

            const after = await call('POST', '/computer/tree', { title: TITLE, depth: 2 });
            check('窗口关闭后再读树返回 window_not_found', after.status === 500
                && after.data.error === 'window_not_found', JSON.stringify(after.data).slice(0, 200));
        }

        console.log('\n[6] 失效引用与参数校验');
        {
            const stale = await call('POST', '/computer/act', { ref: 'e999999', action: 'invoke' });
            check('未知 ref 返回 element_stale', stale.status === 500
                && stale.data.error === 'element_stale', JSON.stringify(stale.data).slice(0, 200));
            check('element_stale 带重试提示', typeof stale.data.hint === 'string'
                && /tree|find/.test(stale.data.hint), stale.data.hint);

            const noAction = await call('POST', '/computer/act', { ref: 'e1' });
            check('缺 action 返回 400', noAction.status === 400
                && noAction.data.error === 'missing_action', JSON.stringify(noAction.data));

            const noTarget = await call('POST', '/computer/act', { action: 'getValue' });
            check('缺 ref 和选择器返回 400', noTarget.status === 400
                && noTarget.data.error === 'missing_target', JSON.stringify(noTarget.data));

            const noText = await call('POST', '/computer/act',
                { ref: 'e1', action: 'setValue' });
            check('setValue 缺 text 返回 400', noText.status === 400
                && noText.data.error === 'missing_text', JSON.stringify(noText.data));

            const badWindow = await call('POST', '/computer/tree',
                { title: '__abb_no_such_window__' });
            check('不存在的窗口返回 window_not_found', badWindow.status === 500
                && badWindow.data.error === 'window_not_found', JSON.stringify(badWindow.data).slice(0, 200));
        }

        console.log('\n[7] 审计只记形状');
        {
            await sleep(200);
            const lines = fs.existsSync(auditPath)
                ? fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)
                : [];
            const entries = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
                .filter(Boolean);
            check('审计里有 computerAct 记录', entries.some((e) => e.action === 'computerAct'),
                entries.map((e) => e.action).join(','));
            check('写入的文本没有进审计', !lines.join('\n').includes('hello-uia'),
                'hello-uia 出现在审计里');
            const setEntry = entries.find((e) => e.action === 'computerAct' && /textChars=9/.test(e.target || ''));
            check('审计记录 textChars 与 action', !!setEntry && /action=setValue/.test(setEntry.target),
                setEntry && setEntry.target);
            const nameEntry = entries.find((e) => e.action === 'computerFind'
                && /nameChars=2/.test(e.target || ''));
            check('审计里 name 只记长度', !!nameEntry
                && !/name=OK\b/i.test(nameEntry.target || ''), nameEntry && nameEntry.target);
            check('审计里没有控件显示文本', !lines.join('\n').includes('hello label'), 'hello label 出现在审计里');
        }
    } finally {
        try { app.kill(); } catch (e) { /* 已退出 */ }
        try { server.kill(); } catch (e) { /* 已退出 */ }
        await sleep(400);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 已尽力 */ }
    }

    console.log(`\n通过 ${pass}，失败 ${fail}`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试意外中断:', e && e.stack || e); process.exit(1); });
