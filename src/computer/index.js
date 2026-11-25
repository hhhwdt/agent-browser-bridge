/**
 * Agent Browser Bridge —— computer 执行器（Windows 桌面控制）。
 *
 * 与浏览器动作族的本质差别：这里不经过扩展，全部在本机直接执行。
 * Windows 专用，非 Windows 平台在任何入口直接报 unsupported_platform。
 *
 * 结构：
 *   scripts/*.ps1  Windows PowerShell 5.1 宿主脚本（ASCII，参数经 JSON 文件传入，
 *                  结果统一写进 result 文件再回读，避开控制台编码坑）
 *   本文件         参数夹取、安全门禁（confirm_required）、进程生命周期、临时文件清理
 *
 * 门禁（默认拦截 + 白名单，见 FORCE 自述）：
 *   - 只读类（截图 / 列窗口 / 读剪贴板 / 读音量 / 列进程）直接放行
 *   - 鼠标移动、点击、拖拽、键入、组合键、滚轮放行——agent 先截图再动手是使用者的责任
 *   - 任意 shell 命令、关窗口、杀进程、写剪贴板 → 无 force 一律 400 confirm_required
 *   - shell 的只读白名单：无管道无重定向的单词命令，动词见 SHELL_ALLOW
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const IS_WINDOWS = process.platform === 'win32';
const SCRIPTS = path.join(__dirname, 'scripts');

/* ------------------------------------------------------------------ *
 * 门禁
 * ------------------------------------------------------------------ *
 * 白名单是什么能免确认，不是什么被允许——列表外的动作都能做，只是要带 force。
 * 收紧这条线之前先想清楚：这是从"本机进程可驱动浏览器"到"本机进程可驱动
 * 一切"的升级，等效于把 trust boundary 从浏览器移到整机。
 */

/** 单词、只读、无管道——满足这三条才能免确认执行 shell。 */
const SHELL_ALLOW_FIRST = new Set([
    'dir', 'ls', 'pwd', 'whoami', 'hostname', 'ver', 'vol', 'tree',
    'ipconfig', 'netstat', 'tasklist', 'systeminfo', 'where'
]);
/** Get-/Test-/Measure- 系 cmdlet 前缀按只读处理（读文件也属于"读"）。 */
const SHELL_ALLOW_PREFIX = /^(get-|test-|measure-)/i;

/** 判断一条 shell 是否免确认。返回 null（放行）或拒绝原因字符串。 */
function shellGateDeny(command) {
    const cmd = String(command || '');
    if (!cmd.trim()) { return 'empty_command'; }
    if (cmd.length > 500) { return 'command_too_long'; }
    // ReSharper 一致性：正则里逐字符类，刻意允许空格与 . : - / \ 等路径字符
    if (/[|;&`<>{}!]/.test(cmd)) { return 'shell_operator_requires_force'; }
    if (/[(\[\)\r\n]/.test(cmd)) { return 'shell_expression_requires_force'; }
    const first = cmd.trim().split(/\s+/)[0].toLowerCase();
    if (SHELL_ALLOW_FIRST.has(first)) { return null; }
    if (SHELL_ALLOW_PREFIX.test(first)) { return null; }
    return 'command_not_allowlisted';
}

/** 各动作的免确认规则。返回 null 放行 / 对象 { code, hint } 拒绝。 */
function gateDeny(verb, body, preAuthorized) {
    const force = !!body.force;
    // preAuthorized 来自无人值守策略：只对策略里列出的动作成立
    if (force || preAuthorized) { return null; }
    switch (verb) {
        case 'computerShell': {
            const reason = shellGateDeny(body.command);
            if (reason) {
                return {
                    code: 'confirm_required',
                    hint: 'shell 只放行无管道的只读单词命令（Get-/Test-/Measure- 系、dir、tasklist、'
                        + 'ipconfig 等）。列表外或含管道/重定向/子表达式的命令需要 force=true，'
                        + '仅在该动作已获得用户确认时传。'
                };
            }
            return null;
        }
        case 'computerWindow':
            if (body.action === 'close') {
                return {
                    code: 'confirm_required',
                    hint: '关闭窗口会丢失未保存的工作，需要 force=true，仅在该动作已获得用户确认时传。'
                };
            }
            return null;
        case 'computerProcess':
            if (body.mode === 'kill') {
                return {
                    code: 'confirm_required',
                    hint: '杀进程可能丢失数据，需要 force=true，仅在该动作已获得用户确认时传。'
                };
            }
            return null;
        case 'computerClipboard':
            if (body.action === 'write') {
                return {
                    code: 'confirm_required',
                    hint: '写剪贴板会覆盖用户复制的内容，需要 force=true，仅在该动作已获得用户确认时传。'
                };
            }
            return null;
        default:
            return null;
    }
}

/* ------------------------------------------------------------------ *
 * 宿主脚本执行
 * ------------------------------------------------------------------ */

/** 结果文件约定：脚本把 JSON 写进 result 路径，这里是唯一回读口。 */
function readResultFile(resultFile) {
    let raw = '';
    try {
        // PS 5.1 的 Out-File -Encoding utf8 会带 BOM 与行尾，JSON.parse 不吃
        raw = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw.trim() || '{}');
    } catch (e) {
        return {
            ok: false,
            error: 'host_result_unreadable',
            detail: String(e && e.message),
            raw: raw.slice(0, 300)
        };
    }
}

/** 清掉一次调用的临时目录。失败不影响主流程。 */
function cleanupTemp(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* 只读盘符权限等，忽略 */ }
}

/**
 * 跑一个宿主脚本。params 序列化成 JSON 参数文件传给 -File <script> <param>。
 * 返回脚本写回的结果对象；脚本崩溃/超时映射成结构化错误而不是抛异常。
 */
function runHost(script, params, timeoutMs) {
    if (!IS_WINDOWS) {
        return Promise.resolve({ ok: false, error: 'unsupported_platform', hint: '桌面控制只支持 Windows。' });
    }
    return new Promise((resolve) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-computer-'));
        const paramFile = path.join(dir, 'params.json');
        const resultFile = path.join(dir, 'result.json');
        fs.writeFileSync(paramFile, '\ufeff' + JSON.stringify({ ...params, result: resultFile }), 'utf8');

        const child = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(SCRIPTS, script), paramFile
        ], { windowsHide: true, cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });

        let stderrTail = '';
        child.stderr.on('data', (c) => {
            stderrTail = (stderrTail + c.toString()).slice(-1000);
        });

        let settled = false;
        const done = (payload) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            cleanupTemp(dir);
            resolve(payload);
        };

        const timer = setTimeout(() => {
            try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch (e) { /* 尽力而为 */ }
            done({ ok: false, error: 'host_timeout', detail: script + ' 超过 ' + (timeoutMs || 20000) + 'ms' });
        }, timeoutMs || 20000);

        child.on('error', (e) => {
            done({ ok: false, error: 'host_spawn_failed', detail: String(e && e.message) });
        });
        child.on('exit', (code) => {
            if (settled) { return; }
            if (!fs.existsSync(resultFile)) {
                // 脚本没写结果文件：多半是 switch 没匹配到 op 或脚本早早退出
                done({
                    ok: false,
                    error: 'host_no_result',
                    detail: script + ' 退出码 ' + code + '，未写结果文件'
                        + (stderrTail ? '；stderr: ' + stderrTail.slice(-500) : '')
                });
                return;
            }
            const result = readResultFile(resultFile);
            if (!result.ok) {
                // 脚本自己失败：把宿主 stderr 尾巴带上，方便定位（不让它盖过协议错误码）
                if (!result.detail && stderrTail) { result.detail = stderrTail; }
            }
            done(result);
        });
    });
}

/* ------------------------------------------------------------------ *
 * shell 直接执行（payload 全由本模块生成；computerShell 与内部调用共用）
 * ------------------------------------------------------------------ */

/**
 * 跑一条 PowerShell 命令并取回合并输出。不走 scripts 目录：命令文本
 * 个性化太强，payload 每次写入临时文件。UTF-8 BOM 保证 5.1 不误判编码。
 *
 * @param {object} o { parseJson } 输出若以 {" 开头，按 JSON 归一层（内部调用用）
 * @returns {Promise<{ok,stdout,exitCode,durationMs,timeout?,detail?}>}
 */
function runShell(command, { timeoutMs = 120000, parseJson = false } = {}) {
    if (!IS_WINDOWS) {
        return Promise.resolve({ ok: false, error: 'unsupported_platform', hint: '桌面控制只支持 Windows。' });
    }
    return new Promise((resolve) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-shell-'));
        const scriptFile = path.join(dir, 'payload.ps1');
        const outFile = path.join(dir, 'out.txt');
        // 命令文本由调用方提供（已过门禁才有机会到这里），payload 外层只负责
        // 合并输出与退出码自证。换行原样保留：.ps1 文件按行解析，不依赖命令行传参。
        const payload = '\ufeff' + [
            '$ErrorActionPreference = \'Continue\'',
            '& {',
            command,
            '} 2>&1 | Out-File -FilePath \'' + outFile.replace(/'/g, "''") + '\' -Encoding utf8',
            'if ($LASTEXITCODE -eq $null) { exit 0 } else { exit [int]$LASTEXITCODE }'
        ].join('\r\n');
        fs.writeFileSync(scriptFile, payload, 'utf8');

        const started = Date.now();
        const child = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', scriptFile
        ], { windowsHide: true, cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });

        let stderrTail = '';
        child.stderr.on('data', (c) => {
            stderrTail = (stderrTail + c.toString()).slice(-1000);
        });

        let settled = false;
        let stdout = '';
        const done = (payload) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            // 结果文件在 cwd 里，进程退出后必然已完整
            stdout = stdout + readOutFile(outFile);
            cleanupTemp(dir);
            payload.stdout = capText(stdout);
            payload.durationMs = Date.now() - started;
            resolve(payload);
        };

        const readOutFile = (file) => {
            try {
                let raw = fs.readFileSync(file, 'utf8');
                // utf8 BOM（5.1 的 -Encoding utf8 会带 BOM）
                raw = raw.replace(/^\ufeff/, '');
                return raw;
            } catch (e) { return ''; }
        };

        const capText = (text) => {
            const cap = 200000;
            if (text.length > cap) { return text.slice(-cap); }
            return text;
        };

        const timer = setTimeout(() => {
            try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch (e) { /* 尽力而为 */ }
            done({ ok: false, error: 'timeout', detail: '命令超过 ' + timeoutMs + 'ms 未结束', timeout: true,
                stdoutBeforeCutoff: '', exitCode: null, stderrTail });
        }, timeoutMs);

        child.on('error', (e) => {
            done({ ok: false, error: 'host_spawn_failed', detail: String(e && e.message) });
        });
        child.on('exit', (code) => {
            if (settled) { return; }
            const text = readOutFile(outFile);
            const out = {
                ok: true,
                stdout: capText(text),
                exitCode: code === null ? null : code,
                durationMs: Date.now() - started
            };
            if (parseJson) {
                const trimmed = String(out.stdout).replace(/^\ufeff/, '').trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    try { out.parsed = JSON.parse(trimmed); } catch (e) { /* 保持 stdout 原样 */ }
                }
            }
            if (stdout || stderrTail) { out.detail = stderrTail.slice(-1000); }
            done(out);
        });
    });
}

/** 进程清单（不动用户态，机器自己的只读 payload，不经门禁）。 */
async function listProcesses() {
    const r = await runShell(
        'Get-Process | Sort-Object Id | '
        + 'Select-Object Id,ProcessName,@{n=\'memMb\';e={[math]::Round($_.WorkingSet64/1MB,1)}} | '
        + 'ConvertTo-Json -Compress',
        { parseJson: true, timeoutMs: 30000 }
    );
    if (!r.ok) { return r; }
    return { ok: true, processes: Array.isArray(r.parsed) ? r.parsed : [r.parsed].filter(Boolean) };
}

/* ------------------------------------------------------------------ *
 * 审计摘要
 * ------------------------------------------------------------------ */

/**
 * 生成审计日志用的参数摘要：只保留形状（动作、坐标、长度），不保留内容。
 *
 * 剪贴板正文、键入文本、shell 命令都可能包含密码或私密内容，一个字符都不进日志。
 * 标题与通知正文同理，只记长度。
 *
 * @param {string} verb 动作键（computer 前缀）
 * @param {object} body 请求体
 * @returns {string} 不超过 160 字符的摘要
 */
function auditTarget(verb, body) {
    const b = body || {};
    const fields = [];
    const add = (k, v) => {
        if (v !== undefined && v !== null && v !== '') { fields.push(k + '=' + v); }
    };
    add('action', b.action);
    add('mode', b.mode);
    add('op', b.op);
    if (numLike(b.hwnd)) { add('hwnd', b.hwnd); }
    if (numLike(b.pid)) { add('pid', b.pid); }
    if (numLike(b.x)) { add('x', Math.round(b.x)); }
    if (numLike(b.y)) { add('y', Math.round(b.y)); }
    if (numLike(b.amount)) { add('amount', Math.round(b.amount)); }
    if (numLike(b.volume)) { add('volume', Math.round(b.volume)); }
    add('button', b.button);
    add('key', b.key);
    add('ref', typeof b.ref === 'string' ? b.ref.slice(0, 40) : undefined);
    add('condition', b.condition);
    add('controlType', b.controlType);
    if (numLike(b.depth)) { add('depth', b.depth); }
    if (numLike(b.timeoutMs)) { add('timeoutMs', Math.round(b.timeoutMs)); }
    if (b.region && numLike(b.region.w) && numLike(b.region.h)) {
        add('region', Math.round(b.region.w) + 'x' + Math.round(b.region.h));
    }
    // 内容一律只记长度
    if (typeof b.windowTitle === 'string') { add('titleChars', b.windowTitle.length); }
    if (typeof b.title === 'string') { add('titleChars', b.title.length); }
    if (typeof b.name === 'string') { add('nameChars', b.name.length); }
    if (typeof b.automationId === 'string') { add('automationIdChars', b.automationId.length); }
    if (typeof b.className === 'string') { add('classNameChars', b.className.length); }
    if (typeof b.command === 'string') { add('commandChars', b.command.length); }
    if (typeof b.text === 'string') { add('textChars', b.text.length); }
    if (typeof b.message === 'string') { add('messageChars', b.message.length); }
    if (b.force) { add('force', 'true'); }
    return fields.join(' ').slice(0, 160);
}

/** 有限数字判断（内部用）。 */
function numLike(v) {
    return typeof v === 'number' && isFinite(v);
}

module.exports = {
    IS_WINDOWS,
    gateDeny,
    shellGateDeny,
    auditTarget,
    runHost,
    runShell,
    listProcesses
};
