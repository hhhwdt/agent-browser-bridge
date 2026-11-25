/**
 * Agent Browser Bridge —— 常驻桌面宿主的 Node 侧封装。
 *
 * 每个 DesktopHost 是一个常驻的 powershell.exe，按 NDJSON 一问一答：
 *   -> {"id":1,"fn":"screen","params":{...}}
 *   <- {"id":1,"ok":true,"data":{...}}
 *
 * 进程生命周期由本文件负责：
 *   - 首个请求前惰性启动，握手后开始发命令
 *   - 单条命令超时 → 杀掉宿主并重启（卡死的命令无法从外部取消）
 *   - 宿主崩溃 → 所有在途请求以 host_restarted 失败，下一次调用自动重启
 *   - 父进程退出时 stdin 关闭，宿主自己退出，不留孤儿
 *
 * 池子里多个进程是为了让读操作（截图、列窗口）互不阻塞；写操作由
 * broker 串行化，跨进程也不会并发执行。
 */

'use strict';

const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

const IS_WINDOWS = process.platform === 'win32';
const HOST_SCRIPT = path.join(__dirname, 'host', 'host.ps1');
const READY_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 3000;

/** 每个 fn 的默认超时；路由可以覆盖。 */
const FN_TIMEOUTS = {
    screen: 30000,
    windows: 30000,
    input: 60000,
    clip: 15000,
    notify: 15000,
    audio: 20000,
    ping: 5000
};

/**
 * 单个常驻宿主进程。
 */
class DesktopHost extends EventEmitter {
    /**
     * @param {{ name?: string, autoRestart?: boolean }} options 宿主名与是否自动重启
     */
    constructor({ name = 'desktop', autoRestart = true } = {}) {
        super();
        this.name = name;
        this.autoRestart = autoRestart;
        this.child = null;
        this.starting = null;
        this.pending = new Map();
        this.nextId = 1;
        this.stderrTail = '';
        this.readyAt = 0;
        this.restartCount = 0;
        this.callCount = 0;
        this.errorCount = 0;
        this.lastError = null;
        this.lastErrorAt = 0;
        this.stopping = false;
        this.backoffMs = 500;
    }

    get running() {
        return Boolean(this.child);
    }

    get queueDepth() {
        return this.pending.size;
    }

    /**
     * 启动宿主并等待握手。重复调用是安全的。
     */
    async start() {
        if (!IS_WINDOWS) { throw new Error('unsupported_platform'); }
        if (this.child && this.readyAt) { return; }
        if (this.starting) { return this.starting; }
        this.stopping = false;
        this.starting = this._spawn();
        try {
            await this.starting;
        } finally {
            this.starting = null;
        }
    }

    _spawn() {
        return new Promise((resolve, reject) => {
            const child = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-File', HOST_SCRIPT
            ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

            this.child = child;
            this.stderrTail = '';
            this.readyAt = 0;

            const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
            let ready = false;

            const readyTimer = setTimeout(() => {
                this.lastError = 'host_start_timeout';
                this.lastErrorAt = Date.now();
                this._kill();
                reject(new Error('host_start_timeout'));
            }, READY_TIMEOUT_MS);

            rl.on('line', (line) => {
                const text = line.trim();
                if (!text) { return; }
                let msg;
                try {
                    msg = JSON.parse(text);
                } catch (e) {
                    // 非协议输出（脚本里误用 Write-Output 之类）：记下来，不致命
                    this.lastError = 'non_json_output: ' + text.slice(0, 120);
                    this.lastErrorAt = Date.now();
                    return;
                }
                if (msg.ready) {
                    ready = true;
                    clearTimeout(readyTimer);
                    this.readyAt = Date.now();
                    this.backoffMs = 500;
                    resolve();
                    return;
                }
                this._settle(msg);
            });

            child.stderr.on('data', (chunk) => {
                this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
            });

            child.on('error', (err) => {
                clearTimeout(readyTimer);
                this.lastError = 'spawn_error: ' + err.message;
                this.lastErrorAt = Date.now();
                if (!ready) { reject(err); }
            });

            child.on('exit', (code, signal) => {
                clearTimeout(readyTimer);
                const wasReady = ready;
                this.child = null;
                this.readyAt = 0;
                this.restartCount++;
                this.lastError = `host_exit code=${code} signal=${signal}`
                    + (this.stderrTail ? ' stderr=' + this.stderrTail.slice(-300) : '');
                this.lastErrorAt = Date.now();
                this._failAll('host_restarted');
                this.emit('exit', { code, signal });
                if (!wasReady) {
                    reject(new Error('host_exit_before_ready: ' + this.lastError));
                }
                if (this.autoRestart && !this.stopping) {
                    this._scheduleRestart();
                }
            });
        });
    }

    _scheduleRestart() {
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 5000);
        const timer = setTimeout(() => {
            this.start().catch(() => { /* 失败后 start() 会再次排程 */ });
        }, delay);
        if (timer.unref) { timer.unref(); }
    }

    /**
     * 发一条命令并等结果。
     *
     * @param {string} fn 处理函数名
     * @param {object} params 参数
     * @param {{ timeoutMs?: number }} options 超时
     * @returns {Promise<object>} 宿主返回的 data
     */
    async call(fn, params = {}, { timeoutMs } = {}) {
        if (!IS_WINDOWS) { throw new Error('unsupported_platform'); }
        await this.start();
        const child = this.child;
        if (!child) { throw new Error('host_not_running'); }

        const id = this.nextId++;
        const limit = Math.min(timeoutMs || FN_TIMEOUTS[fn] || 60000, 600000);
        this.callCount++;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.errorCount++;
                this.lastError = 'host_timeout: ' + fn;
                this.lastErrorAt = Date.now();
                const err = new Error('host_timeout');
                err.code = 'host_timeout';
                reject(err);
                // 卡住的命令无法取消，只能整进程重启
                this._kill();
            }, limit);

            const entry = {
                timer,
                ok: (data) => resolve(data || {}),
                fail: (err) => reject(err)
            };
            this.pending.set(id, entry);

            try {
                child.stdin.write(JSON.stringify({ id, fn, params }) + '\n');
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                this.errorCount++;
                reject(new Error('host_write_failed: ' + e.message));
            }
        });
    }

    _settle(msg) {
        const entry = this.pending.get(msg.id);
        if (!entry) { return; }
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) {
            entry.ok(msg.data);
            return;
        }
        this.errorCount++;
        this.lastError = String(msg.error || 'host_error');
        this.lastErrorAt = Date.now();
        const err = new Error(String(msg.error || 'host_error'));
        err.code = String(msg.error || 'host_error');
        if (msg.detail) { err.detail = String(msg.detail); }
        entry.fail(err);
    }

    _failAll(reason) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            const err = new Error(reason);
            err.code = reason;
            entry.fail(err);
        }
        this.pending.clear();
    }

    _kill() {
        const child = this.child;
        if (!child || !child.pid) { return; }
        // taskkill 连子进程一起收：PowerShell 里可能还有 Start-Process 出来的东西
        try {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } catch (e) { /* 忽略 */ }
        const grace = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
        }, KILL_GRACE_MS);
        if (grace.unref) { grace.unref(); }
    }

    /**
     * 主动停止宿主（测试与进程退出时用）。
     */
    async stop() {
        this.stopping = true;
        this._failAll('host_stopped');
        if (!this.child) { return; }
        await new Promise((resolve) => {
            const child = this.child;
            const done = () => resolve();
            child.once('exit', done);
            try { child.stdin.end(); } catch (e) { /* 忽略 */ }
            setTimeout(() => {
                if (this.child) { this._kill(); }
                resolve();
            }, 1500);
        });
    }

    status() {
        return {
            name: this.name,
            running: this.running,
            pid: this.child ? this.child.pid : null,
            uptimeMs: this.readyAt ? Date.now() - this.readyAt : 0,
            pending: this.pending.size,
            restarts: this.restartCount,
            calls: this.callCount,
            errors: this.errorCount,
            lastError: this.lastError,
            lastErrorAt: this.lastErrorAt
        };
    }
}

/**
 * 宿主池：按待办数量挑最闲的一个，读操作之间互不阻塞。
 *
 * uia 是例外：元素 ref 只存在于创建它的那个宿主进程里，
 * 所以所有 uia 请求固定落到 0 号进程。
 */
class DesktopPool {
    /**
     * @param {{ size?: number }} options 进程数
     */
    constructor({ size = 2 } = {}) {
        const n = Math.max(1, Math.min(8, size));
        this.workers = Array.from({ length: n }, (_, i) => new DesktopHost({ name: 'desktop-' + i }));
        this.lastPicked = 0;
        this.roundRobin = 0;
        this.warmed = false;
    }

    _pick(fn) {
        if (fn === 'uia') {
            // ref 是宿主进程内状态，换进程就等于全部失效
            this.lastPicked = 0;
            return this.workers[0];
        }
        // 同分时轮转，否则 0 号进程永远拿到全部请求，池子等于没开。
        const n = this.workers.length;
        const start = this.roundRobin++ % n;
        let best = this.workers[start];
        let bestScore = Infinity;
        for (let i = 0; i < n; i++) {
            const w = this.workers[(start + i) % n];
            const score = w.pending.size + (w.readyAt ? 0 : 0.5);
            if (score < bestScore) {
                best = w;
                bestScore = score;
            }
        }
        this.lastPicked = this.workers.indexOf(best);
        return best;
    }

    call(fn, params, options) {
        const worker = this._pick(fn);;
        const pending = worker.call(fn, params, options);
        // 第一个请求不等待其余宿主：本次立刻执行，其余进程在后台预热，
        // 后续并发读操作才有多进程可用。
        if (!this.warmed) {
            this.warmed = true;
            for (const w of this.workers) {
                if (w !== worker && !w.running) {
                    w.start().catch(() => { /* 崩溃后由 autoRestart 负责 */ });
                }
            }
        }
        return pending;
    }

    async startAll() {
        await Promise.all(this.workers.map((w) => w.start()));
        return this;
    }

    status() {
        return {
            size: this.workers.length,
            workers: this.workers.map((w) => w.status())
        };
    }

    async stop() {
        await Promise.all(this.workers.map((w) => w.stop()));
    }
}

module.exports = {
    DesktopHost,
    DesktopPool,
    FN_TIMEOUTS,
    IS_WINDOWS
};
