/**
 * Agent Browser Bridge —— 桌面动作指标。
 *
 * 7x24 运行时最常问的两个问题：现在还在动吗、有没有变慢。这里只保留最近
 * 256 次调用的耗时和一个动作级累计表，内存恒定，不做持久化。
 *
 * 指标通过 /health 的 desktopMetrics 暴露，供 supervisor 与人工排查读取。
 */

'use strict';

const WINDOW = 256;

/** 单次调用结果分类。 */
const OUTCOMES = new Set(['ok', 'failed', 'invalid', 'busy', 'denied', 'replay']);

class DesktopMetrics {
    /**
     * @param {{ window?: number }} options 保留多少次调用的耗时
     */
    constructor({ window = WINDOW } = {}) {
        this.windowSize = Math.max(16, Math.min(4096, window));
        this.samples = [];
        this.sampleAt = 0;
        this.counters = { calls: 0, ok: 0, failed: 0, invalid: 0, busy: 0, denied: 0, replay: 0 };
        this.actions = new Map();
        this.lastAt = 0;
    }

    /**
     * 记录一次调用。
     *
     * @param {string} verb 动作键
     * @param {string} outcome ok / failed / invalid / busy / denied / replay
     * @param {number} ms 耗时
     */
    record(verb, outcome, ms) {
        const kind = OUTCOMES.has(outcome) ? outcome : 'failed';
        this.counters.calls++;
        this.counters[kind]++;
        this.lastAt = Date.now();

        if (kind !== 'replay' && isFinite(ms) && ms >= 0) {
            this.samples.push(Math.round(ms));
            if (this.samples.length > this.windowSize) { this.samples.shift(); }
        }

        let row = this.actions.get(verb);
        if (!row) {
            row = { calls: 0, ok: 0, failed: 0, busy: 0, denied: 0, totalMs: 0, maxMs: 0 };
            this.actions.set(verb, row);
        }
        row.calls++;
        if (kind === 'ok') { row.ok++; }
        else if (kind === 'failed' || kind === 'invalid') { row.failed++; }
        else if (kind === 'busy') { row.busy++; }
        else if (kind === 'denied') { row.denied++; }
        if (kind !== 'replay' && isFinite(ms)) {
            row.totalMs += ms;
            row.maxMs = Math.max(row.maxMs, Math.round(ms));
        }
    }

    /** 耗时的分位数（只统计最近 windowSize 次）。 */
    percentile(p) {
        if (this.samples.length === 0) { return 0; }
        const sorted = this.samples.slice().sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
        return sorted[idx];
    }

    /** /health 用的快照。 */
    snapshot() {
        const byAction = {};
        for (const [verb, row] of this.actions) {
            byAction[verb] = {
                calls: row.calls,
                ok: row.ok,
                failed: row.failed,
                busy: row.busy,
                denied: row.denied,
                avgMs: row.calls ? Math.round(row.totalMs / row.calls) : 0,
                maxMs: row.maxMs
            };
        }
        return {
            ...this.counters,
            avgMs: this.samples.length
                ? Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length) : 0,
            p95Ms: this.percentile(95),
            maxMs: this.samples.length ? Math.max(...this.samples) : 0,
            samples: this.samples.length,
            window: this.windowSize,
            lastAt: this.lastAt || null,
            byAction
        };
    }
}

module.exports = { DesktopMetrics, metrics: new DesktopMetrics() };
