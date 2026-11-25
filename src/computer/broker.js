/**
 * Agent Browser Bridge —— 桌面写锁（多 agent 并发控制）。
 *
 * 读操作（截图、列窗口、读剪贴板、音量）可以并行；会改变桌面状态的操作
 * （输入、点按、窗口动作、写剪贴板）必须串行，否则两个 agent 的鼠标会互相
 * 抢焦点、互相打断输入。
 *
 * 规则：
 *   - 同一 agent 可重入（batch 里连续多个写动作不会自己把自己挡住）
 *   - 不同 agent 默认立刻返回 desktop_busy，调用方可以传 waitMs 排队
 *   - 排队是 FIFO，超时按 desktop_busy 返回，并带上当前持有者
 */

'use strict';

/** 从请求头取 agent 身份，非法字符全部丢弃，缺省为 default。 */
function agentOf(req) {
    const raw = String((req && req.headers && req.headers['x-abb-agent']) || '').trim().toLowerCase();
    const clean = raw.replace(/[^a-z0-9._-]/g, '').slice(0, 40);
    return clean || 'default';
}

class DesktopBroker {
    /**
     * @param {{ defaultWaitMs?: number, maxWaitMs?: number }} options 默认与最大排队时长
     */
    constructor({ defaultWaitMs = 0, maxWaitMs = 120000 } = {}) {
        this.holder = null;
        this.depth = 0;
        this.queue = [];
        this.seq = 0;
        this.defaultWaitMs = defaultWaitMs;
        this.maxWaitMs = maxWaitMs;
        this.totalAcquired = 0;
        this.totalRejected = 0;
    }

    get busy() {
        return Boolean(this.holder);
    }

    /**
     * 取得写权限。返回一个幂等的释放函数。
     *
     * @param {string} agent agent 身份
     * @param {{ waitMs?: number }} options 排队等待毫秒数，0 表示不排队
     * @returns {Promise<Function>} 释放函数
     */
    async acquire(agent, { waitMs } = {}) {
        const wanted = Number.isFinite(waitMs) ? waitMs : this.defaultWaitMs;
        const limit = Math.max(0, Math.min(wanted, this.maxWaitMs));

        if (!this.holder || this.holder === agent) {
            this.holder = agent;
            this.depth++;
            this.totalAcquired++;
            return this._releaseFn(agent);
        }

        if (limit === 0) {
            this.totalRejected++;
            throw this._busyError();
        }

        const ticket = { agent, grant: null, reject: null, timer: null };
        const ready = new Promise((resolve, reject) => {
            ticket.grant = resolve;
            ticket.reject = reject;
        });
        ticket.timer = setTimeout(() => {
            const index = this.queue.indexOf(ticket);
            if (index >= 0) { this.queue.splice(index, 1); }
            this.totalRejected++;
            const err = this._busyError();
            err.waitedMs = limit;
            ticket.reject(err);
        }, limit);
        this.queue.push(ticket);
        return ready;
    }

    _busyError() {
        const err = new Error('desktop_busy');
        err.code = 'desktop_busy';
        err.holder = this.holder;
        err.queue = this.queue.length;
        return err;
    }

    _releaseFn(agent) {
        let released = false;
        return () => {
            if (released) { return; }
            released = true;
            if (this.holder !== agent) { return; }
            this.depth--;
            if (this.depth > 0) { return; }
            this.holder = null;
            this._grantNext();
        };
    }

    _grantNext() {
        if (this.holder || this.queue.length === 0) { return; }
        const ticket = this.queue.shift();
        clearTimeout(ticket.timer);
        this.holder = ticket.agent;
        this.depth = 1;
        this.totalAcquired++;
        ticket.grant(this._releaseFn(ticket.agent));
    }

    status() {
        return {
            holder: this.holder,
            depth: this.depth,
            queue: this.queue.length,
            queuedAgents: this.queue.map((t) => t.agent),
            totalAcquired: this.totalAcquired,
            totalRejected: this.totalRejected
        };
    }
}

module.exports = { DesktopBroker, agentOf };
