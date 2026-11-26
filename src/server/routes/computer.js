/**
 * Agent Browser Bridge —— computer 动作路由（本地执行，不经扩展）。
 *
 * 与 generic.js 的差别：动作在本机完成，不走队列/浏览器派发。
 * 每个动作：门禁（gateDeny / force）→ 取桌面写锁 → 校验参数并执行 → sendJson。
 *
 * 参数校验与执行在 dispatch.js；这里只负责 HTTP、门禁、审计、并发。
 * 写操作（输入/点按/窗口动作/写剪贴板）全局串行；读操作可以并行。
 */

'use strict';

const { gateDeny, auditTarget } = require('../../computer/index.js');
const { dispatch, isWriteVerb, VerbError, num, clamp } = require('../../computer/dispatch.js');
const { DesktopBroker, agentOf } = require('../../computer/broker.js');
const { IS_WINDOWS } = require('../../computer/exec.js');
const { policy } = require('../../computer/policy.js');
const { metrics } = require('../../computer/metrics.js');
const { IdempotencyStore } = require('../../computer/idempotency.js');
const { readJsonBody, sendJson } = require('../http.js');
const { logAudit } = require('../audit.js');

const broker = new DesktopBroker({ maxWaitMs: 300000 });
const idempotency = new IdempotencyStore();

/** 从 body 里取排队时长；默认不排队，冲突立即 409。 */
function waitMsOf(body) {
    return clamp(num(body.waitMs, 0), 0, 300000);
}

/**
 * 幂等入口：同一个 agent + requestId 的请求只执行一次。
 *
 * 重试窗口内返回原结果；原请求还在执行时等它结束再回放。返回 responded=true
 * 表示响应已经发出，调用方直接结束即可。
 *
 * @param {object} req HTTP 请求
 * @param {object} res HTTP 响应
 * @param {string} agent 调用方身份
 * @param {object} body 请求体
 * @returns {Promise<{key: string|null, responded?: boolean}>}
 */
async function beginIdempotent(req, res, agent, body) {
    const rid = body.requestId;
    if (rid === undefined || rid === null || rid === '') {
        return { key: null };
    }
    if (!idempotency.validId(rid)) {
        sendJson(res, 400, {
            ok: false,
            error: 'bad_request_id',
            hint: 'requestId 只允许 1-64 位字母、数字、点、冒号、下划线或连字符。'
        }, req);
        return { key: null, responded: true };
    }
    const key = idempotency.key(agent, rid);
    const hit = idempotency.lookup(key);
    if (hit && hit.pending) {
        const done = await hit.pending;
        if (done) {
            sendJson(res, done.status, done.body, req);
            return { key: null, responded: true };
        }
        // 原请求执行到一半被中断，登记已清掉：这一次重新执行
    } else if (hit) {
        sendJson(res, hit.status, hit.body, req);
        return { key: null, responded: true };
    }
    idempotency.begin(key);
    return { key };
}

/** 统一门禁、策略、锁、执行与审计。 */
async function guarded(req, res, verb, body) {
    const agent = agentOf(req);
    const started = Date.now();
    const gate = await beginIdempotent(req, res, agent, body);
    if (gate.responded) {
        metrics.record(verb, 'replay', 0);
        return;
    }
    const key = gate.key;
    let finished = false;

    /** 发响应、记幂等结果、记指标，三件事绑在一起，避免漏一个分支。 */
    const respond = (status, payload, outcome) => {
        finished = true;
        sendJson(res, status, payload, req);
        if (key) { idempotency.finish(key, status, payload); }
        metrics.record(verb, outcome, Date.now() - started);
    };

    try {
        if (!IS_WINDOWS) {
            respond(400, {
                ok: false, error: 'unsupported_platform', hint: '桌面控制只支持 Windows。'
            }, 'failed');
            return;
        }

        const write = isWriteVerb(verb, body);
        const denied = policy.denyFor(agent, verb, { write });
        if (denied) {
            respond(403, { ok: false, error: denied.code, hint: denied.hint }, 'denied');
            return;
        }

        const gateDenyResult = gateDeny(verb, body, policy.allowsForce(agent, verb, body));
        if (gateDenyResult) {
            respond(400, {
                ok: false, error: gateDenyResult.code, hint: gateDenyResult.hint
            }, 'denied');
            return;
        }

        let release = null;
        if (write) {
            try {
                release = await broker.acquire(agent, { waitMs: waitMsOf(body) });
            } catch (e) {
                respond(409, {
                    ok: false,
                    error: 'desktop_busy',
                    hint: '另一个 agent（' + (e.holder || 'unknown') + '）正在操作桌面。'
                        + '传 waitMs 可排队等待。',
                    holder: e.holder,
                    queue: e.queue
                }, 'busy');
                return;
            }
        }

        let payload;
        let invalid = null;
        try {
            payload = await dispatch(verb, body);
        } catch (e) {
            if (e instanceof VerbError) {
                invalid = e;
            } else {
                payload = {
                    ok: false,
                    error: (e && e.code) || 'host_error',
                    detail: String(e && e.message)
                };
            }
        } finally {
            if (release) { release(); }
        }

        if (invalid) {
            respond(400, { ok: false, error: invalid.code, hint: invalid.hint }, 'invalid');
            return;
        }

        const ok = Boolean(payload && payload.ok);
        try {
            logAudit({
                timestamp: new Date().toISOString(),
                action: verb,
                agent,
                target: auditTarget(verb, body),
                outcome: ok ? 'ok' : ((payload && payload.error) || 'fail'),
                duration: Date.now() - started
            });
        } catch (e) { /* 审计失败不影响主流程 */ }

        if (ok) {
            respond(200, { ok: true, data: payload }, 'ok');
            return;
        }
        respond(500, {
            ok: false,
            error: (payload && payload.error) || 'computer_failed',
            hint: payload && payload.hint,
            detail: payload && payload.detail
        }, 'failed');
    } catch (e) {
        // 未预料的异常：清掉幂等登记，否则同 id 的重试会等一个永远不来的结果
        if (key && !finished) { idempotency.abort(key); }
        throw e;
    }
}

/** 读 body 并执行一个动作。 */
function handler(verb) {
    return async function route(req, res) {
        const body = await readJsonBody(req, res);
        if (!body) { return; }
        await guarded(req, res, verb, body);
    };
}

/* ------------------------------------------------------------------ *
 * 批量执行
 * ------------------------------------------------------------------ */

/**
 * 一次请求执行多个动作，共享一次写锁。
 *
 * body: { ops: [{ action: 'computerClick', params: { x, y } }, ...],
 *         waitMs?: number, stopOnError?: boolean }
 *
 * 全部门禁在拿锁之前检查：有一个非法就整批拒绝，不会执行一半。
 */
async function routeBatch(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) { return; }

    const agent = agentOf(req);
    const started = Date.now();
    const gate = await beginIdempotent(req, res, agent, body);
    if (gate.responded) {
        metrics.record('computerBatch', 'replay', 0);
        return;
    }
    const key = gate.key;
    let finished = false;

    const respond = (status, payload, outcome) => {
        finished = true;
        sendJson(res, status, payload, req);
        if (key) { idempotency.finish(key, status, payload); }
        metrics.record('computerBatch', outcome, Date.now() - started);
    };

    try {
        if (!IS_WINDOWS) {
            respond(400, {
                ok: false, error: 'unsupported_platform', hint: '桌面控制只支持 Windows。'
            }, 'failed');
            return;
        }
        if (!Array.isArray(body.ops) || body.ops.length === 0) {
            respond(400, {
                ok: false, error: 'missing_ops', hint: '需要 ops 数组，每项 { action, params }。'
            }, 'invalid');
            return;
        }
        if (body.ops.length > 50) {
            respond(400, {
                ok: false, error: 'too_many_ops', hint: '单次 batch 最多 50 个动作。'
            }, 'invalid');
            return;
        }

        const prepared = [];
        for (let i = 0; i < body.ops.length; i++) {
            const raw = body.ops[i] || {};
            if (typeof raw.action !== 'string' || !raw.action) {
                respond(400, {
                    ok: false, error: 'bad_op', hint: '第 ' + i + ' 项缺 action。'
                }, 'invalid');
                return;
            }
            const params = raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
                ? raw.params : {};
            const policyDenied = policy.denyFor(agent, raw.action, {
                write: isWriteVerb(raw.action, params)
            });
            if (policyDenied) {
                metrics.record(raw.action, 'denied', 0);
                respond(403, {
                    ok: false,
                    error: policyDenied.code,
                    hint: '第 ' + i + ' 项（' + raw.action + '）：' + policyDenied.hint
                }, 'denied');
                return;
            }
            const deny = gateDeny(raw.action, params,
                policy.allowsForce(agent, raw.action, params));
            if (deny) {
                respond(400, {
                    ok: false,
                    error: deny.code,
                    hint: '第 ' + i + ' 项（' + raw.action + '）：' + deny.hint
                }, 'denied');
                return;
            }
            prepared.push({ action: raw.action, params });
        }

        const anyWrite = prepared.some((op) => isWriteVerb(op.action, op.params));
        let release = null;
        if (anyWrite) {
            try {
                release = await broker.acquire(agent, { waitMs: waitMsOf(body) });
            } catch (e) {
                respond(409, {
                    ok: false,
                    error: 'desktop_busy',
                    hint: '另一个 agent（' + (e.holder || 'unknown') + '）正在操作桌面。'
                        + '传 waitMs 可排队等待。',
                    holder: e.holder,
                    queue: e.queue
                }, 'busy');
                return;
            }
        }

        const stopOnError = body.stopOnError !== false;
        const results = [];
        let failed = false;
        try {
            for (const op of prepared) {
                if (failed && stopOnError) {
                    results.push({ action: op.action, ok: false, skipped: true });
                    continue;
                }
                const stepStarted = Date.now();
                let payload;
                try {
                    payload = await dispatch(op.action, op.params);
                } catch (e) {
                    payload = e instanceof VerbError
                        ? { ok: false, error: e.code, hint: e.hint }
                        : {
                            ok: false,
                            error: (e && e.code) || 'host_error',
                            detail: String(e && e.message)
                        };
                }
                const ok = Boolean(payload && payload.ok);
                results.push(ok
                    ? { action: op.action, ok: true, data: payload }
                    : {
                        action: op.action,
                        ok: false,
                        error: payload.error || 'computer_failed',
                        hint: payload.hint,
                        detail: payload.detail
                    });
                metrics.record(op.action, ok ? 'ok' : 'failed', Date.now() - stepStarted);
                try {
                    logAudit({
                        timestamp: new Date().toISOString(),
                        action: op.action,
                        agent,
                        target: auditTarget(op.action, op.params),
                        outcome: ok ? 'ok' : (payload.error || 'fail'),
                        duration: Date.now() - stepStarted
                    });
                } catch (e) { /* 审计失败不影响主流程 */ }
                if (!ok) { failed = true; }
            }
        } finally {
            if (release) { release(); }
        }

        respond(200, { ok: !failed, agent, count: results.length, results },
            failed ? 'failed' : 'ok');
    } catch (e) {
        if (key && !finished) { idempotency.abort(key); }
        throw e;
    }
}

module.exports = {
    routeScreen: handler('computerScreen'),
    routeOcr: handler('computerOcr'),
    routeWindows: handler('computerWindows'),
    routeWindow: handler('computerWindow'),
    routeClick: handler('computerClick'),
    routeScroll: handler('computerScroll'),
    routeDrag: handler('computerDrag'),
    routeMove: handler('computerMove'),
    routeType: handler('computerType'),
    routeKey: handler('computerKey'),
    routeClipboard: handler('computerClipboard'),
    routeShell: handler('computerShell'),
    routeProcess: handler('computerProcess'),
    routeNotify: handler('computerNotify'),
    routeMedia: handler('computerMedia'),
    routeTree: handler('computerTree'),
    routeFind: handler('computerFind'),
    routeAct: handler('computerAct'),
    routeWaitFor: handler('computerWaitFor'),
    routeBatch,
    broker,
    idempotency,
    metrics
};
