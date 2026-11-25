#!/usr/bin/env node
/**
 * 队列背压测试：在飞上限、一次把队列排空、坏通道兜底、超时释放名额。
 *
 * 防的失败：
 *   - 队列里堆了 N 个任务，通道重连后每次触发只发一个，后面的长时间没人管
 *   - 一次几千个并发调用全塞进同一个 service worker，一起变慢、一起超时
 *   - 通道其实已经死了却还在给它发任务（任务被静默吞掉）
 *   - 任务超时后名额没还回去，越跑越少，最后完全不动
 *
 * 直接在进程内驱动 src/server/queue.js，用假通道代替 WebSocket，不启服务、不碰浏览器。
 * 上限通过 ABB_MAX_INFLIGHT 固定成 2，测试才能看出边界的差别。
 *
 *   node test-queue-inflight.js
 */

'use strict';

process.env.ABB_MAX_INFLIGHT = '2';

const queue = require('../src/server/queue.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假通道：记录发下去的任务；dead=true 时 sendTask 返回 false。 */
function makeChannel(opts) {
  const o = opts || {};
  const sent = [];
  return {
    sent,
    sendTask(task) {
      if (o.dead) { return false; }
      sent.push(task);
      return true;
    },
    close() { /* 不需要 */ }
  };
}

/** 浏览器"在线"但没有通道：心跳还在 30 秒窗口内。 */
function markSeen(browser) {
  queue.lastSeen.set(browser, Date.now());
}

/** 把已下发的任务全部结算（每个只结算一次），直到队列和在飞都清空。 */
async function settleAll(channel) {
  const done = new Set();
  let guard = 0;
  while ((queue.inflightFor('edge') > 0 || queue.queuedCount() > 0) && guard++ < 50) {
    const next = channel.sent.find((t) => !done.has(t.id));
    if (!next) { await sleep(0); continue; }   // 等下一次 flush 把队列里的补进来
    done.add(next.id);
    queue.recordResult('edge', next.id, { ok: true });
    await sleep(0);
  }
}

(async () => {
  /* ---------- 1. 在飞上限 ---------- */
  console.log('\n[1] 在飞上限：超出的任务留在队列里');
  const ch = makeChannel();
  queue.registerWsChannel('edge', ch);

  const waiting = [];
  for (let i = 0; i < 5; i++) {
    waiting.push(queue.dispatch({ action: 'read', match: 'x', tabId: 100 + i }, 3000));
  }
  await sleep(0);

  check('只下发到上限的两个任务', ch.sent.length === 2, `下发 ${ch.sent.length} 个`);
  check('其余三个仍在队列里', queue.queuedCount() === 3, `队列 ${queue.queuedCount()} 个`);
  check('在飞计数与上限一致', queue.inflightFor('edge') === 2, `在飞 ${queue.inflightFor('edge')}`);

  /* ---------- 2. 结算一个，立刻补一个 ---------- */
  console.log('\n[2] 结算后空出的名额马上被队列用上');
  queue.recordResult('edge', ch.sent[0].id, { ok: true, data: { n: 0 } });
  await sleep(0);
  check('又下发了一个', ch.sent.length === 3, `下发 ${ch.sent.length} 个`);
  check('队列相应减少', queue.queuedCount() === 2, `队列 ${queue.queuedCount()} 个`);
  check('在飞仍是 2', queue.inflightFor('edge') === 2, `在飞 ${queue.inflightFor('edge')}`);

  /* ---------- 3. 全部结算 ---------- */
  console.log('\n[3] 全部结算');
  await settleAll(ch);
  const settled = await Promise.all(waiting);
  check('五个调用方都拿到成功结果', settled.every((r) => r.ok === true),
    JSON.stringify(settled.map((r) => r.ok)));
  check('名额全部还回', queue.inflightFor('edge') === 0, `在飞 ${queue.inflightFor('edge')}`);
  check('队列清空', queue.queuedCount() === 0, `队列 ${queue.queuedCount()}`);

  /* ---------- 4. 通道重连后一次排空 ---------- */
  console.log('\n[4] 通道断开期间堆积的任务，重连后一次排空');
  queue.unregisterWsChannel('edge', ch);
  markSeen('edge');           // 浏览器还在线（心跳未过期），只是没有 WS 通道
  const offline = [];
  for (let i = 0; i < 3; i++) {
    offline.push(queue.dispatch({ action: 'read', match: 'y', tabId: 200 + i }, 4000));
  }
  await sleep(0);
  check('没有通道时任务只排队不下发', queue.queuedCount() === 3, `队列 ${queue.queuedCount()}`);

  const ch2 = makeChannel();
  queue.registerWsChannel('edge', ch2);
  queue.flushTasks();
  await sleep(0);
  check('重连后一次下发到上限（而不是只发一个）', ch2.sent.length === 2, `下发 ${ch2.sent.length} 个`);
  check('剩下的一个继续排队', queue.queuedCount() === 1, `队列 ${queue.queuedCount()}`);

  queue.recordResult('edge', ch2.sent[0].id, { ok: true });
  await sleep(0);
  check('结算后最后一个也发出去了', ch2.sent.length === 3, `下发 ${ch2.sent.length} 个`);
  await settleAll(ch2);
  await Promise.all(offline);

  /* ---------- 5. 坏通道：不发、不丢 ---------- */
  console.log('\n[5] 通道其实已死：不发、不丢');
  queue.unregisterWsChannel('edge', ch2);
  markSeen('edge');
  const dead = makeChannel({ dead: true });
  queue.registerWsChannel('edge', dead);
  const orphan = queue.dispatch({ action: 'read', match: 'z', tabId: 300 }, 400);
  await sleep(0);
  check('坏通道上一个任务都没发出去', dead.sent.length === 0, `下发 ${dead.sent.length} 个`);
  const orphanResult = await orphan;
  check('任务没有被静默吞掉，调用方收到超时', orphanResult.error === 'timeout', JSON.stringify(orphanResult));

  /* ---------- 6. 坏通道之后换上新通道，照常工作 ---------- */
  console.log('\n[6] 换上新通道后队列继续走');
  const ch3 = makeChannel();
  queue.registerWsChannel('edge', ch3);
  const after = queue.dispatch({ action: 'read', match: 'w', tabId: 301 }, 2000);
  await sleep(0);
  check('新通道拿到了任务', ch3.sent.length === 1 && queue.inflightFor('edge') === 1,
    `下发 ${ch3.sent.length} 在飞 ${queue.inflightFor('edge')}`);

  /* ---------- 7. 超时释放名额 ---------- */
  console.log('\n[7] 超时要归还名额，不能越跑越少');
  const r1 = await after; // 这个任务不会被结算，等它超时
  check('超时后报 timeout', r1.error === 'timeout', JSON.stringify(r1));
  check('名额已还回', queue.inflightFor('edge') === 0, `在飞 ${queue.inflightFor('edge')}`);

  const t2 = queue.dispatch({ action: 'read', match: 'v', tabId: 302 }, 2000);
  await sleep(0);
  check('下一个任务能立刻下发（名额没漏）', ch3.sent.length === 2, `下发 ${ch3.sent.length} 个`);

  /* ---------- 8. 超时之后迟到的结果不算数 ---------- */
  console.log('\n[8] 迟到的结果被忽略，不会重复扣名额');
  const late = queue.recordResult('edge', ch3.sent[0].id, { ok: true });
  check('对已超时的任务回结果是 no-op', late.resolved === false, JSON.stringify(late));
  check('在飞计数仍为 1', queue.inflightFor('edge') === 1, `在飞 ${queue.inflightFor('edge')}`);
  queue.recordResult('edge', ch3.sent[1].id, { ok: true });
  await t2;

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
