/**
 * Agent Browser Bridge —— 请求幂等。
 *
 * 无人值守调用方的网络会抖：请求已经执行完，响应没回来，调用方重试。对于
 * 点按、键入这种动作，重试就是"点两次"。调用方在请求体里带 requestId
 * （同一个逻辑请求重试时保持不变），服务端按 agent + requestId 去重：
 *
 *   - 已有结果 → 原样回放，不再执行
 *   - 正在执行 → 等原请求结束，回放它的结果
 *   - 没出现过 → 正常执行并记下结果
 *
 * 只放内存，TTL 默认 10 分钟，最多 200 条，进程重启后失效。别把 requestId
 * 当成持久化事务 ID：它解决的是重试窗口内的重复执行。
 */

'use strict';

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

class IdempotencyStore {
    /**
     * @param {{ ttlMs?: number, max?: number }} options 保留时长与条数上限
     */
    constructor({ ttlMs = 10 * 60 * 1000, max = 200 } = {}) {
        this.ttlMs = ttlMs;
        this.max = max;
        this.entries = new Map();
        this.hits = 0;
        this.misses = 0;
        this.waits = 0;
        this.evicted = 0;
    }

    /** requestId 只允许可打印的短标识，避免把任意文本塞进键里。 */
    validId(requestId) {
        return typeof requestId === 'string' && ID_RE.test(requestId);
    }

    /** agent 与 requestId 组成键；同一 id 在不同 agent 下互不影响。 */
    key(agent, requestId) {
        return String(agent || 'default').toLowerCase() + '|' + requestId;
    }

    _sweep() {
        const cutoff = Date.now() - this.ttlMs;
        for (const [key, entry] of this.entries) {
            if (entry.state === 'done' && entry.at < cutoff) {
                this.entries.delete(key);
                this.evicted++;
            }
        }
        // Map 按插入顺序迭代：超上限时先丢最老的已完成项
        while (this.entries.size > this.max) {
            let dropped = false;
            for (const [key, entry] of this.entries) {
                if (entry.state === 'done') {
                    this.entries.delete(key);
                    this.evicted++;
                    dropped = true;
                    break;
                }
            }
            if (!dropped) { break; }
        }
    }

    /**
     * 查重。
     *
     * @param {string} key 由 key() 生成
     * @returns {null|{status: number, body: object}|{pending: Promise}}
     *          null 表示没出现过；pending 表示原请求还在执行
     */
    lookup(key) {
        this._sweep();
        const entry = this.entries.get(key);
        if (!entry) {
            this.misses++;
            return null;
        }
        this.hits++;
        if (entry.state === 'done') {
            // 回放也算一次使用，移到队尾，避免频繁命中的条目先被清掉
            this.entries.delete(key);
            this.entries.set(key, entry);
            return { status: entry.status, body: entry.body };
        }
        this.waits++;
        return { pending: entry.promise };
    }

    /** 登记一个正在执行的请求，返回完成函数。 */
    begin(key) {
        const entry = { state: 'pending', at: Date.now(), promise: null, resolve: null };
        entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
        this.entries.set(key, entry);
        this._sweep();
        return entry;
    }

    /** 原请求结束：存结果并唤醒等待者。 */
    finish(key, status, body) {
        const entry = this.entries.get(key);
        if (!entry || entry.state !== 'pending') { return; }
        entry.state = 'done';
        entry.at = Date.now();
        entry.status = status;
        entry.body = body;
        entry.resolve({ status, body });
        entry.resolve = null;
    }

    /**
     * 原请求在写入结果前中断：清掉登记，让重试重新执行。
     */
    abort(key) {
        const entry = this.entries.get(key);
        if (!entry) { return; }
        this.entries.delete(key);
        if (entry.state === 'pending' && entry.resolve) { entry.resolve(null); }
    }

    /** /health 用的状态。 */
    status() {
        this._sweep();
        let pending = 0;
        for (const entry of this.entries.values()) {
            if (entry.state === 'pending') { pending++; }
        }
        return {
            entries: this.entries.size,
            pending,
            hits: this.hits,
            misses: this.misses,
            waits: this.waits,
            evicted: this.evicted,
            ttlMs: this.ttlMs,
            max: this.max
        };
    }
}

module.exports = { IdempotencyStore };
