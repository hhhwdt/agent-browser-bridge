/**
 * Agent Browser Bridge —— 无人值守桌面策略。
 *
 * 默认行为是"危险动作要 force"，适合有人看着的交互式调用。7x24 跑的任务没有人
 * 点确认，所以用一份策略文件预先说明：哪个 agent 可以不经 force 做哪些动作，
 * 哪些动作一律禁止，某个 agent 是否只能读。
 *
 * 文件位置：<configDir>/desktop-policy.json，可用 ABB_DESKTOP_POLICY 指定别的路径。
 * 文件不存在时策略不生效，行为与以前完全一致。
 *
 * 格式（version 1）：
 *   {
 *     "version": 1,
 *     "default": {
 *       "allowForce": ["computerWindow", "computerProcess"],
 *       "deny": ["computerShell"],
 *       "readOnly": false,
 *       "shellAllow": ["^Get-", "^Test-"]
 *     },
 *     "agents": {
 *       "ci-runner": { "allowForce": ["computerShell"], "shellAllow": ["^Get-Date"] }
 *     }
 *   }
 *
 * 语义：
 *   - deny 命中 → 403 policy_denied，带 force 也不放行
 *   - readOnly=true → 所有写动作 403 policy_read_only
 *   - allowForce 命中 → 该动作不需要 force；computerShell 还要求命令命中
 *     shellAllow 里至少一个正则（没写 shellAllow 则任意命令都放行，等同整机权限）
 *   - agents 里没有的 agent 用 default
 *
 * 文件改动按 mtime 自动重载，不用重启服务。解析失败时保留上一次成功的规则，
 * 并把错误暴露在 /health 的 desktopPolicy.error 里。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getConfigDir } = require('../server/config.js');

const ACTION_RE = /^computer[A-Z][A-Za-z]*$/;

/** 规整一个动作名数组，丢掉非法项。 */
function cleanActions(value, warnings, field) {
    if (value === undefined) { return null; }
    if (!Array.isArray(value)) {
        warnings.push(field + ' 必须是数组');
        return [];
    }
    const out = [];
    for (const item of value) {
        const name = String(item || '');
        if (!ACTION_RE.test(name)) {
            warnings.push(field + ' 里有非法动作名：' + name.slice(0, 40));
            continue;
        }
        if (!out.includes(name)) { out.push(name); }
    }
    return out;
}

/** 编译 shell 正则；写错的正则跳过并记警告，不影响其他规则。 */
function cleanShellAllow(value, warnings, field) {
    if (value === undefined) { return null; }
    if (!Array.isArray(value)) {
        warnings.push(field + ' 必须是数组');
        return [];
    }
    const out = [];
    for (const item of value) {
        try {
            out.push(new RegExp(String(item)));
        } catch (e) {
            warnings.push(field + ' 里有无效正则：' + String(item).slice(0, 40));
        }
    }
    return out;
}

/** 把一个 agent 段的原始 JSON 规整成规则对象。 */
function normalize(raw, warnings, field) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        allowForce: cleanActions(src.allowForce, warnings, field + '.allowForce'),
        deny: cleanActions(src.deny, warnings, field + '.deny'),
        readOnly: src.readOnly === true,
        shellAllow: cleanShellAllow(src.shellAllow, warnings, field + '.shellAllow')
    };
}

/**
 * 策略快照。文件不变时复用；mtime 或大小变化时重新解析。
 */
class DesktopPolicy {
    constructor() {
        this.cache = null;
        this.lastGood = null;
        this.error = null;
        this.warnings = [];
        this.signature = '';
        this.loadedAt = 0;
        this.loadCount = 0;
    }

    /** 当前策略文件路径（每次读取，测试可以改环境变量后 reset）。 */
    path() {
        return process.env.ABB_DESKTOP_POLICY
            ? String(process.env.ABB_DESKTOP_POLICY)
            : path.join(getConfigDir(), 'desktop-policy.json');
    }

    /** 丢掉缓存，下一次访问重新读盘（测试用）。 */
    reset() {
        this.cache = null;
        this.lastGood = null;
        this.error = null;
        this.warnings = [];
        this.signature = '';
        this.loadedAt = 0;
    }

    /** 按 mtime + size 判断是否需要重读。 */
    _reload() {
        const file = this.path();
        let stat;
        try {
            stat = fs.statSync(file);
        } catch (e) {
            this.cache = null;
            this.lastGood = null;
            this.signature = '';
            this.error = null;
            this.warnings = [];
            return;
        }
        const signature = stat.mtimeMs + ':' + stat.size;
        if (signature === this.signature) { return; }

        this.signature = signature;
        this.loadCount++;
        const warnings = [];
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
            if (parsed && parsed.version !== undefined && Number(parsed.version) !== 1) {
                warnings.push('version 不是 1，按 1 解析');
            }
            const def = normalize(parsed && parsed.default, warnings, 'default');
            const agents = {};
            const rawAgents = parsed && parsed.agents && typeof parsed.agents === 'object'
                ? parsed.agents : {};
            for (const key of Object.keys(rawAgents)) {
                const name = String(key).toLowerCase();
                agents[name] = normalize(rawAgents[key], warnings, 'agents.' + name);
            }
            this.cache = { file, default: def, agents };
            this.lastGood = this.cache;
            this.error = null;
            this.warnings = warnings;
            this.loadedAt = Date.now();
        } catch (e) {
            // 保留上一次成功的规则，避免一个手滑的编辑把无人值守任务全锁死
            this.cache = this.lastGood;
            this.error = String(e && e.message || e).slice(0, 300);
            this.warnings = warnings;
        }
    }

    /** 取某个 agent 的合并规则；没有策略文件时返回 null。 */
    rulesFor(agent) {
        this._reload();
        if (!this.cache) { return null; }
        const name = String(agent || 'default').toLowerCase();
        const own = this.cache.agents[name];
        if (!own) { return this.cache.default; }
        const def = this.cache.default;
        return {
            allowForce: own.allowForce === null
                ? def.allowForce
                : [...new Set([...(def.allowForce || []), ...own.allowForce])],
            deny: [...new Set([...(def.deny || []), ...(own.deny || [])])],
            readOnly: def.readOnly || own.readOnly,
            shellAllow: own.shellAllow === null ? def.shellAllow : own.shellAllow
        };
    }

    /**
     * 策略层面的拒绝，先于 force 判断。
     *
     * @param {string} agent 调用方身份
     * @param {string} verb 动作键
     * @param {{ write: boolean }} ctx 是否是写动作
     * @returns {null|{code: string, hint: string}}
     */
    denyFor(agent, verb, ctx) {
        const rules = this.rulesFor(agent);
        if (!rules) { return null; }
        if ((rules.deny || []).includes(verb)) {
            return {
                code: 'policy_denied',
                hint: '动作 ' + verb + ' 被 ' + this.path() + ' 禁止（agent=' + (agent || 'default') + '）。'
                    + '需要执行时改策略文件，force 不会绕过它。'
            };
        }
        if (rules.readOnly && ctx && ctx.write) {
            return {
                code: 'policy_read_only',
                hint: 'agent=' + (agent || 'default') + ' 在策略里是只读的，'
                    + '写动作（输入、点按、窗口动作、写剪贴板）一律拒绝。'
            };
        }
        return null;
    }

    /**
     * 策略是否替调用方预先授权了本可要求 force 的动作。
     *
     * @param {string} agent 调用方身份
     * @param {string} verb 动作键
     * @param {object} body 请求体
     * @returns {boolean} true 表示可以跳过 force 检查
     */
    allowsForce(agent, verb, body) {
        const rules = this.rulesFor(agent);
        if (!rules || !(rules.allowForce || []).includes(verb)) { return false; }
        if (verb !== 'computerShell') { return true; }
        // shell 单独收紧：策略写了 shellAllow 就必须命中一条
        const patterns = rules.shellAllow || [];
        if (patterns.length === 0) { return true; }
        const cmd = String((body && body.command) || '');
        return patterns.some((re) => re.test(cmd));
    }

    /** /health 用的状态：不含规则内容以外的敏感信息。 */
    status() {
        this._reload();
        const rules = this.cache;
        return {
            enabled: !!rules,
            path: this.path(),
            loaded: !!rules,
            error: this.error,
            warnings: this.warnings.slice(0, 10),
            agents: rules ? Object.keys(rules.agents) : [],
            defaultAllowForce: rules ? (rules.default.allowForce || []) : [],
            defaultDeny: rules ? (rules.default.deny || []) : [],
            defaultReadOnly: rules ? rules.default.readOnly : false,
            loadCount: this.loadCount,
            loadedAt: this.loadedAt || null
        };
    }
}

/** 进程内单例：策略文件很小，按 mtime 重载即可。 */
const policy = new DesktopPolicy();

module.exports = {
    DesktopPolicy,
    policy
};
