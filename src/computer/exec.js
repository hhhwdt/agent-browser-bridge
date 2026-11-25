/**
 * Agent Browser Bridge —— 桌面执行入口（常驻宿主 / 旧式逐次 spawn）。
 *
 * 默认走常驻宿主：一次启动，之后每条命令只在管道上往返，热路径毫秒级。
 * 设置 ABB_DESKTOP_SPAWN=1 可以退回每个动作起一个 powershell.exe 的旧路径，
 * 用于对比行为或在宿主出问题时临时绕过。
 *
 * ABB_DESKTOP_HOSTS 控制宿主进程数（默认 2）：读操作可以并行，写操作由
 * broker 串行化，不会因为多进程而并发写桌面。
 */

'use strict';

const { DesktopPool } = require('./host.js');
const { IS_WINDOWS, runHost } = require('./index.js');

const SPAWN_MODE = process.env.ABB_DESKTOP_SPAWN === '1';
const POOL_SIZE = Number(process.env.ABB_DESKTOP_HOSTS || 2);

const SCRIPT_OF = {
    screen: 'screen.ps1',
    windows: 'windows.ps1',
    input: 'input.ps1',
    clip: 'clip.ps1',
    notify: 'notify.ps1',
    audio: 'audio.ps1'
};

let pool = null;

function getPool() {
    if (!pool) {
        pool = new DesktopPool({ size: Number.isFinite(POOL_SIZE) ? POOL_SIZE : 2 });
    }
    return pool;
}

/**
 * 执行一个宿主能力。
 *
 * @param {string} fn 能力名（screen / windows / input / clip / notify / audio）
 * @param {object} params 参数
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<object>} 结果对象，ok=false 表示失败
 */
async function exec(fn, params, timeoutMs) {
    if (!IS_WINDOWS) {
        return { ok: false, error: 'unsupported_platform' };
    }
    if (SPAWN_MODE) {
        return runHost(SCRIPT_OF[fn], params, timeoutMs);
    }
    try {
        const data = await getPool().call(fn, params, { timeoutMs });
        return Object.assign({ ok: true }, data);
    } catch (e) {
        return {
            ok: false,
            error: (e && e.code) || 'host_error',
            detail: (e && (e.detail || e.message)) || undefined
        };
    }
}

/** 宿主状态，供 /health 与诊断使用。 */
function status() {
    return {
        mode: SPAWN_MODE ? 'spawn' : 'host',
        hosts: Number.isFinite(POOL_SIZE) ? POOL_SIZE : 2,
        started: Boolean(pool),
        pool: pool ? pool.status() : null
    };
}

/**
 * 服务启动时预热宿主进程。
 *
 * 宿主池是惰性启动的：不做这件事，服务每次重启后的第一个桌面动作要付
 * 约 1 秒的 powershell 启动和握手。启动时立刻拉起，第一个请求就是热的。
 * 设置 ABB_DESKTOP_WARM=0 可退回按需启动（测试或省内存场景）。
 * 失败静默：下一次调用会照常惰性启动，autoRestart 兜底。
 */
function warm() {
    if (!IS_WINDOWS || SPAWN_MODE) { return; }
    if (process.env.ABB_DESKTOP_WARM === '0') { return; }
    const current = getPool();
    current.startAll().then(() => {
        // 宿主启动只到 ready；每个能力第一次使用还要编译一次 C#/加载程序集
        // （windows ~0.4s，uia ~0.2s）。重启窗口之后进来的第一个任务不该背这笔钱，
        // 所以把每个宿主的 windows 与 uia 热身掉。出错的分支静默，真实调用重试。
        for (const w of current.workers) {
            w.call('windows', { op: 'list' }).catch(() => { });
            w.call('uia', { op: 'tree' }).catch(() => { });
        }
    }).catch(() => { /* 下次调用重试 */ });
}

/** 关闭所有宿主进程（进程退出与测试用）。 */
async function shutdown() {
    if (!pool) { return; }
    const current = pool;
    pool = null;
    await current.stop();
}

module.exports = { exec, status, shutdown, warm, IS_WINDOWS };
