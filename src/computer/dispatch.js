/**
 * Agent Browser Bridge —— computer 动作的参数校验与执行分发。
 *
 * 路由与 batch 共用这一层：路由负责 HTTP/审计/门禁，这里只做
 * 「body -> 宿主参数」的夹取与「宿主结果 -> 对外 payload」的整形。
 * batch 因此不需要重复实现 14 份参数校验。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runShell, listProcesses } = require('./index.js');
const { exec } = require('./exec.js');
const { parseKeyCombo } = require('./keys.js');

/** 参数错误：路由应回 400，batch 应回该 op 的 error。 */
class VerbError extends Error {
    /**
     * @param {string} code 错误码
     * @param {string} hint 给调用方的修复提示
     */
    constructor(code, hint) {
        super(code);
        this.name = 'VerbError';
        this.code = code;
        this.hint = hint;
    }
}

/** 数值参数夹取：只接受有限数字（字符串数字也收），否则回默认值。 */
function num(v, def) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) { return n; }
    return def;
}

/** 区间夹取。 */
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * 这个动作是否改变桌面状态（需要写锁）。
 *
 * @param {string} verb 动作键
 * @param {object} body 请求体
 * @returns {boolean} true 表示要串行执行
 */
function isWriteVerb(verb, body = {}) {
    switch (verb) {
        case 'computerClipboard':
            return body.action === 'write';
        case 'computerWindow':
            return body.action !== 'info';
        case 'computerClick':
        case 'computerMove':
        case 'computerDrag':
        case 'computerScroll':
        case 'computerType':
        case 'computerKey':
            return true;
        case 'computerAct':
            // Reading a control value does not change the desktop; every other
            // UIA action (invoke, toggle, setValue, focus, click) does.
            return body.action !== 'getValue';
        default:
            return false;
    }
}

/** 动作键到宿主能力名。 */
const FN_OF = {
    computerWindows: 'windows',
    computerWindow: 'windows',
    computerClick: 'input',
    computerMove: 'input',
    computerDrag: 'input',
    computerScroll: 'input',
    computerType: 'input',
    computerKey: 'input',
    computerClipboard: 'clip',
    computerNotify: 'notify',
    computerMedia: 'audio',
    computerTree: 'uia',
    computerFind: 'uia',
    computerAct: 'uia',
    computerWaitFor: 'uia'
};

/** 动作键到默认超时。 */
const TIMEOUT_OF = {
    computerScreen: 25000,
    computerOcr: 30000,
    computerFindImage: 30000,
    computerDiff: 30000,
    computerClipboard: 15000,
    computerNotify: 15000,
    computerMedia: 20000,
    computerTree: 25000,
    computerFind: 30000,
    computerAct: 25000
};

/** 窗口目标：hwnd / pid / title 三选一。 */
function windowTargetOf(body, hint) {
    if (num(body.hwnd, 0) > 0) {
        return { hwnd: Math.trunc(num(body.hwnd, 0)) };
    }
    if (body.pid !== undefined && body.pid !== null && String(body.pid).trim() !== '') {
        const pid = num(body.pid, 0);
        if (pid > 0) { return { pid: Math.trunc(pid) }; }
    }
    if (typeof body.title === 'string' && body.title.trim()) {
        return { title: body.title.trim().slice(0, 300) };
    }
    if (typeof body.windowTitle === 'string' && body.windowTitle.trim()) {
        return { title: body.windowTitle.trim().slice(0, 300) };
    }
    throw new VerbError('missing_target', hint || '需要 hwnd、pid 或 title/windowTitle 之一。');
}

/** UIA 选择器：name / automationId / controlType / className。 */
function uiaSelectorOf(body) {
    const s = {};
    if (typeof body.name === 'string' && body.name) {
        s.name = body.name.slice(0, 200);
        if (body.nameExact) { s.nameExact = true; }
    }
    if (typeof body.automationId === 'string' && body.automationId) {
        s.automationId = body.automationId.slice(0, 200);
    }
    if (typeof body.controlType === 'string' && body.controlType) {
        s.controlType = body.controlType.replace(/^ControlType\./i, '').slice(0, 60);
    }
    if (typeof body.className === 'string' && body.className) {
        s.className = body.className.slice(0, 120);
    }
    return s;
}

/** UIA 失败的统一提示：宿主只回错误码，面向调用方的话放在这里。 */
const UIA_HINTS = {
    element_stale: '控件引用已失效；重新 computer_tree / computer_find 拿新 ref，'
        + '或同时传窗口与选择器让它自动重定位。',
    element_not_found: '没有找到匹配的控件；放宽过滤条件，或先看控件树。',
    missing_filter: '至少给一个过滤条件：name / automationId / controlType / className。',
    missing_target: '需要 hwnd、pid 或 title/windowTitle 指出窗口。',
    pattern_unavailable: '该控件不支持这个 UIA 模式；可先传 patterns=true 看支持哪些，或改用 click。',
    no_click_point: '控件没有可点击区域，可能被隐藏或尺寸为 0。',
    wait_timeout: '等待超时；确认控件名称与窗口是否正确，或加大 timeoutMs。'
};

/** 宿主 input/windows 层新错误码的提示。 */
const INPUT_HINTS = {
    not_foreground: '点击坐标下的窗口没能抬到前台（可能被系统焦点保护拦下），点击已取消：先 computer_window activate 目标窗口，再点。',
    click_no_target: '点击坐标下没有可见窗口，坐标可能有误；先 computer_windows 核对窗口位置再点。'
};

/**
 * body -> 宿主参数。
 *
 * @param {string} verb 动作键
 * @param {object} body 请求体
 * @returns {Promise<{ params: object, timeoutMs?: number }>} 可直接执行的参数
 */
async function buildParams(verb, body) {
    switch (verb) {
        case 'computerScreen':
        case 'computerOcr':
        case 'computerFindImage': {
            let region = null;
            if (body.region) {
                region = {
                    x: clamp(num(body.region.x, 0), -100000, 100000),
                    y: clamp(num(body.region.y, 0), -100000, 100000),
                    w: clamp(num(body.region.w, 640), 1, 10000),
                    h: clamp(num(body.region.h, 480), 1, 10000)
                };
            }
            if (num(body.hwnd, 0) > 0) {
                return { params: { mode: 'window', hwnd: Math.trunc(num(body.hwnd, 0)) } };
            }
            if (body.windowTitle) {
                const list = await exec('windows', { op: 'list' }, 30000);
                if (list.ok === false) {
                    throw new VerbError('window_list_failed', '列窗口失败：' + String(list.error || ''));
                }
                const want = String(body.windowTitle).toLowerCase();
                const hits = (list.windows || []).filter((w) => (w.title || '').toLowerCase().includes(want));
                if (hits.length === 0) {
                    throw new VerbError('no_window_matched', '窗口标题没匹配上。先调 computer_windows 看清单。');
                }
                if (hits.length > 1) {
                    const shown = hits
                        .slice(0, 6)
                        .map((w) => `hwnd=${w.hwnd} pid=${w.pid} ${w.process} ${w.bounds ? w.bounds.w + 'x' + w.bounds.h : ''}`)
                        .join(' | ');
                    throw new VerbError('ambiguous_window',
                        `标题子串匹配到 ${hits.length} 个窗口，容易截错；用 hwnd 精确指定。候选：${shown}`);
                }
                return { params: { mode: 'window', hwnd: hits[0].hwnd } };
            }
            return { params: region ? { mode: 'screen', region } : { mode: 'screen' } };
        }

        case 'computerWindows':
            return { params: { op: 'list' } };

        case 'computerWindow': {
            if (!body.action) {
                throw new VerbError('missing_action',
                    '需要 action：activate / minimize / maximize / close。目标用 title 或 pid。');
            }
            if (typeof body.title !== 'string' && typeof num(body.pid) !== 'number') {
                throw new VerbError('missing_target', '需要 title（子串匹配）或 pid 之一');
            }
            const params = { op: body.action };
            if (typeof body.title === 'string') { params.title = body.title.slice(0, 300); }
            if (typeof num(body.pid) === 'number') { params.pid = num(body.pid); }
            return { params };
        }

        case 'computerClick': {
            if (num(body.x) === undefined || num(body.y) === undefined) {
                throw new VerbError('missing_xy', '需要屏幕坐标 x、y（整数或小数均可，虚拟桌面像素坐标）。');
            }
                    const button = ['left', 'right', 'middle'].includes(body.button) ? body.button : 'left';
                    const clickParams = {
                        op: 'click',
                        x: clamp(num(body.x, 0), -100000, 100000),
                        y: clamp(num(body.y, 0), -100000, 100000),
                        button,
                        double: Boolean(body.double)
                    };
                    // 可选保险：点之前把坐标下的顶层窗口抬到前台并核实，
                    // 失败则取消点击（被盖住的窗口点击本来就是无效动作）。
                    if (body.ensureForeground !== undefined) {
                        clickParams.ensureForeground = Boolean(body.ensureForeground);
                    }
                    return { params: clickParams };
                }

        case 'computerScroll': {
            const params = { op: 'scroll', amount: clamp(num(body.amount, -3), -200, 200) };
            if (num(body.x) !== undefined && num(body.y) !== undefined) {
                params.x = num(body.x);
                params.y = num(body.y);
            }
            return { params };
        }

        case 'computerDrag': {
            if (num(body.x1) === undefined || num(body.y1) === undefined
                || num(body.x2) === undefined || num(body.y2) === undefined) {
                throw new VerbError('missing_xy', '需要起点 x1,y1 与终点 x2,y2。');
            }
            return {
                params: {
                    op: 'drag',
                    x1: num(body.x1, 0), y1: num(body.y1, 0),
                    x2: num(body.x2, 0), y2: num(body.y2, 0),
                    steps: clamp(num(body.steps, 24), 2, 300),
                    stepMs: clamp(num(body.stepMs, 12), 1, 200)
                }
            };
        }

        case 'computerMove': {
            if (num(body.x) === undefined || num(body.y) === undefined) {
                throw new VerbError('missing_xy', '需要屏幕坐标 x、y。');
            }
            return {
                params: {
                    op: 'move',
                    x: clamp(num(body.x, 0), -100000, 100000),
                    y: clamp(num(body.y, 0), -100000, 100000)
                }
            };
        }

        case 'computerType': {
            if (typeof body.text !== 'string' || !body.text.length) {
                throw new VerbError('missing_text', '需要 text（Unicode 逐键注入，6 万字符以内）。');
            }
            return { params: { op: 'text', text: String(body.text).slice(0, 60000) } };
        }

        case 'computerKey': {
            if (typeof body.key !== 'string' || !body.key.trim()) {
                throw new VerbError('missing_key',
                    '需要 key，如 Enter / Tab / Escape / ArrowUp / F5，或加号组合 ctrl+c。');
            }
            const combo = parseKeyCombo(String(body.key));
            if (combo.error) { throw new VerbError('bad_key', combo.error); }
            return { params: { op: 'key', mods: combo.mods, vks: combo.vks } };
        }

        case 'computerClipboard': {
            const action = body.action === 'write' ? 'write' : 'read';
            if (action === 'write' && typeof body.text !== 'string') {
                throw new VerbError('missing_text', '写剪贴板需要 text。');
            }
            return {
                params: {
                    op: action === 'write' ? 'set' : 'get',
                    text: String(body.text || '').slice(0, 1000000)
                }
            };
        }

        case 'computerNotify':
            return {
                params: {
                    title: String(body.title || 'Agent Browser Bridge').slice(0, 120),
                    message: String(body.message || '').slice(0, 500)
                }
            };

        case 'computerMedia': {
            const OPS = ['get', 'volume', 'play', 'pause', 'toggle', 'next', 'prev', 'stop',
                'volup', 'voldown', 'mute', 'unmute'];
            const op = OPS.includes(body.op) ? body.op : 'get';
            const params = { op };
            if (op === 'volume') { params.volume = clamp(num(body.volume, 50), 0, 100); }
            return { params };
        }

        case 'computerShell': {
            if (typeof body.command !== 'string' || !body.command.trim()) {
                throw new VerbError('missing_command', '需要 command（单条 PowerShell 命令）。');
            }
            return {
                params: {
                    command: body.command,
                    timeoutMs: clamp(num(body.timeoutMs, 120000), 1000, 300000)
                },
                timeoutMs: 300000
            };
        }

        case 'computerProcess': {
            const mode = body.mode === 'kill' ? 'kill' : 'list';
            if (mode === 'kill' && num(body.pid) === undefined) {
                throw new VerbError('missing_pid', 'kill 需要 pid。');
            }
            return { params: { mode, pid: num(body.pid) } };
        }

        case 'computerTree': {
            const params = { op: 'tree', ...windowTargetOf(body) };
            params.depth = clamp(Math.trunc(num(body.depth, 6)), 0, 12);
            params.maxNodes = clamp(Math.trunc(num(body.maxNodes, 400)), 1, 2000);
            params.includeOffscreen = body.includeOffscreen !== false;
            params.patterns = Boolean(body.patterns);
            return { params };
        }

        case 'computerFind': {
            const selector = uiaSelectorOf(body);
            if (Object.keys(selector).length === 0) {
                throw new VerbError('missing_filter',
                    '至少给一个过滤条件：name / automationId / controlType / className。');
            }
            const params = { op: 'find', ...windowTargetOf(body), ...selector };
            params.depth = clamp(Math.trunc(num(body.depth, 12)), 0, 12);
            params.maxResults = clamp(Math.trunc(num(body.maxResults, 20)), 1, 200);
            params.includeOffscreen = body.includeOffscreen !== false;
            params.patterns = Boolean(body.patterns);
            return { params };
        }

        case 'computerAct': {
            const ACTIONS = ['invoke', 'toggle', 'setValue', 'getValue', 'select',
                'expand', 'collapse', 'focus', 'scrollIntoView', 'click'];
            if (!ACTIONS.includes(body.action)) {
                throw new VerbError('missing_action',
                    'action 取 invoke / toggle / setValue / getValue / select / expand / collapse / '
                    + 'focus / scrollIntoView / click。');
            }
            const params = { op: 'act', action: body.action };
            if (typeof body.ref === 'string' && body.ref.trim()) {
                params.ref = body.ref.trim().slice(0, 40);
            }
            Object.assign(params, uiaSelectorOf(body));
            if (!params.ref && !params.name && !params.automationId
                && !params.controlType && !params.className) {
                throw new VerbError('missing_target',
                    '需要 ref，或 hwnd/windowTitle 加一个过滤条件（name / automationId / controlType / className）。');
            }
            if (!params.ref || body.hwnd || body.pid || body.title || body.windowTitle) {
                Object.assign(params, windowTargetOf(body,
                    '用选择器定位控件时还需要 hwnd、pid 或 title/windowTitle。'));
            }
            if (body.action === 'setValue') {
                if (typeof body.text !== 'string') {
                    throw new VerbError('missing_text', 'setValue 需要 text。');
                }
                params.text = body.text.slice(0, 60000);
            }
            return { params };
        }

        case 'computerWaitFor': {
            const CONDITIONS = ['exists', 'gone', 'enabled', 'value'];
            const condition = CONDITIONS.includes(body.condition) ? body.condition : 'exists';
            const params = { op: 'wait', condition };
            if (typeof body.ref === 'string' && body.ref.trim()) {
                params.ref = body.ref.trim().slice(0, 40);
            }
            Object.assign(params, uiaSelectorOf(body));
            if (!params.ref && !params.name && !params.automationId
                && !params.controlType && !params.className) {
                throw new VerbError('missing_filter',
                    '需要 ref，或一个过滤条件（name / automationId / controlType / className）。');
            }
            if (params.name || params.automationId || params.controlType || params.className) {
                Object.assign(params, windowTargetOf(body,
                    '按选择器等控件时还需要 hwnd、pid 或 title/windowTitle。'));
            }
            if (condition === 'value' && typeof body.value !== 'string') {
                throw new VerbError('missing_value', 'condition=value 需要 value（期望的文本）。');
            }
            if (condition === 'value') { params.value = body.value.slice(0, 10000); }
            params.timeoutMs = clamp(Math.trunc(num(body.timeoutMs, 10000)), 100, 60000);
            params.intervalMs = clamp(Math.trunc(num(body.intervalMs, 200)), 50, 5000);
            return { params, timeoutMs: params.timeoutMs + 8000 };
        }

        case 'computerDiff':
            return { params: {} };

        default:
            throw new VerbError('unknown_action', '未知动作：' + verb);
    }
}

/**
 * 执行一个动作，返回对外 payload。
 *
 * @param {string} verb 动作键
 * @param {object} body 请求体
 * @returns {Promise<object>} payload（含 ok 字段）
 */
async function dispatch(verb, body) {
    // 窗口已经给过 index（computer_windows 的返回）：先换成 hwnd，再走各动作原有逻辑
    if (body && typeof body.index === 'number' && body.index >= 0 && !(body.hwnd > 0)) {
        const list = await exec('windows', { op: 'list' }, 30000);
        if (list.ok === false) { return list; }
        const picked = (list.windows || [])[body.index];
        if (!picked) {
            return { ok: false, error: 'index_out_of_range',
                hint: 'index 从 0 开始；先调 computerWindows 拿最新清单，窗口可能已经关闭或重排。' };
        }
        body = { ...body, hwnd: picked.hwnd };
    }
    const prepared = await buildParams(verb, body);
    const params = prepared.params;
    const timeoutMs = prepared.timeoutMs || TIMEOUT_OF[verb];

    if (verb === 'computerScreen') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-shot-'));
        const out = path.join(dir, 'shot.png');
        try {
            const r = await exec('screen', { ...params, out, savePath: body.savePath }, timeoutMs);
            if (r.ok === false) { return r; }
            let dataUrl;
            try {
                dataUrl = 'data:image/png;base64,' + fs.readFileSync(out, 'base64');
            } catch (e) {
                return { ok: false, error: 'screenshot_read_failed', detail: String(e && e.message) };
            }
            return {
                ok: true,
                mode: r.mode || params.mode,
                width: r.width,
                height: r.height,
                bytes: r.bytes,
                ...(r.blank ? {
                    blank: true,
                    warning: '窗口截图是纯色图：窗口可能还没渲染完、无响应，或 PrintWindow 取不到加速绘制的内容。建议先 computer_window activate 再截一次。'
                } : {}),
                ...(body.savePath ? { savedPath: body.savePath } : {}),
                dataUrl
            };
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 已尽力 */ }
        }
    }

    if (verb === 'computerOcr') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-ocr-'));
        const out = path.join(dir, 'shot.png');
        try {
            const r = await exec('screen', { ...params, out, ocr: true, language: body.language }, timeoutMs);
            if (r.ok === false) { return r; }
            return {
                ok: true,
                mode: r.mode || params.mode,
                width: r.width,
                height: r.height,
                origin: r.origin || null,
                language: r.ocrLanguage || null,
                lines: Array.isArray(r.lines) ? r.lines : [],
                text: r.text || ''
            };
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 已尽力 */ }
        }
    }

    if (verb === 'computerFindImage') {
        if (typeof body.template !== 'string' || !body.template.trim()) {
            return { ok: false, error: 'missing_template', hint: '需要 template（模板 PNG 的绝对路径）。先用 computer_screen + region + savePath 截一块。' };
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-find-'));
        const out = path.join(dir, 'screen.png');
        try {
            const shot = await exec('screen', { ...params, out }, timeoutMs);
            if (shot.ok === false) { return shot; }
            const r = await exec('vision', {
                op: 'match',
                screen: out,
                template: body.template,
                threshold: typeof body.threshold === 'number' ? body.threshold : undefined
            }, timeoutMs);
            if (r.ok === false) { return r; }
            if (!r.found) {
                return { ok: true, found: false, score: r.score, threshold: r.threshold, template: r.template };
            }
            const ox = shot.origin ? shot.origin.x : 0;
            const oy = shot.origin ? shot.origin.y : 0;
            const x = ox + r.x;
            const y = oy + r.y;
            return {
                ok: true,
                found: true,
                x,
                y,
                w: r.w,
                h: r.h,
                center: { x: x + Math.floor(r.w / 2), y: y + Math.floor(r.h / 2) },
                score: r.score,
                origin: { x: ox, y: oy }
            };
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 已尽力 */ }
        }
    }

    if (verb === 'computerDiff') {
        if (typeof body.before !== 'string' || typeof body.after !== 'string') {
            return { ok: false, error: 'missing_images', hint: '需要 before 与 after（两张截图的绝对路径）。' };
        }
        return await exec('vision', {
            op: 'diff',
            before: body.before,
            after: body.after,
            threshold: typeof body.threshold === 'number' ? body.threshold : undefined
        }, timeoutMs);
    }

    if (verb === 'computerWindows') {
        const r = await exec('windows', params, timeoutMs);
        if (r.ok === false) { return r; }
        r.windows = (r.windows || []).map((w, index) => ({ ...w, index }));
        return r;
    }

    if (verb === 'computerShell') {
        const r = await runShell(params.command, { timeoutMs: params.timeoutMs });
        if (!r.ok && r.error === 'timeout') {
            return { ok: false, error: 'timeout', hint: '命令超时，进程已被终止', detail: r.detail };
        }
        return r;
    }

    if (verb === 'computerProcess') {
        if (params.mode === 'list') { return listProcesses(); }
        const r = await runShell('Stop-Process -Id ' + params.pid + ' -Force');
        const killed = r.ok && r.exitCode === 0 && !/没有|not|cannot|No process/i.test(r.stdout || '');
        return {
            ok: killed,
            pid: params.pid,
            detail: killed ? undefined : ('stdout: ' + String(r.stdout || '').slice(0, 300))
        };
    }

    const fn = FN_OF[verb];
    if (!fn) { throw new VerbError('unknown_action', '未知动作：' + verb); }

    try {
        const r = await exec(fn, params, timeoutMs);
        if (r.ok === false) {
            const hint = (fn === 'uia' && UIA_HINTS[r.error]) || (fn === 'input' && INPUT_HINTS[r.error]);
            if (hint) { return { ...r, hint: r.hint || hint }; }
            return r;
        }
        // UIA tree 返回空树的自动诊断：说明至少生效到了「窗口可读」这一层，
        // agent 不用再空试三轮。
        if (fn === 'uia' && r.count === 0 && r.diagnostics) {
            r.hint = r.diagnostics.rootFound
                ? '窗口能读到但可访问性树是空的：多半是自绘界面（CEF/DirectX），UIA 拿不到控件，请改用截图+坐标操作。'
                : '根控件属性读不到（进程权限不匹配或 provider 未响应），请改用截图+坐标操作。';
        }
        return r;
    } catch (e) {
        // 宿主抛出的结构化错误（element_stale / pattern_unavailable 等）
        if (fn === 'uia' && e && UIA_HINTS[e.code]) {
            return { ok: false, error: e.code, hint: UIA_HINTS[e.code], detail: e.message };
        }
        throw e;
    }
}

module.exports = {
    VerbError,
    buildParams,
    dispatch,
    isWriteVerb,
    num,
    clamp
};
