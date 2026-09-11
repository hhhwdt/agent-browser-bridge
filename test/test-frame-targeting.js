#!/usr/bin/env node
/**
 * 写操作的框架选择测试。
 *
 * 注入用 allFrames 时，函数会在**每个**框架里真实执行一遍：按钮点一次、文字插一遍，
 * 框架有几个就发生几次。injectAndPick 只能决定"回报哪一份结果"，收不回其他框架里
 * 已经发生的副作用。所以 click / type / key 改成两步：先只读探测，再只对命中的框架执行。
 *
 * 这个测试用假 DOM 驱动 background.js 里真实的 clickInPage / typeInPage / keyInPage
 * 与 injectInBestFrame，逐个阶段比对副作用增量：
 *   - 探测阶段：不允许有任何点击事件、聚焦、按键
 *   - 真实动作：只发往一个框架，且同名元素只被动到一个
 *   - 没有框架命中时：退回原来的全框架执行，报错与原来一致
 *
 *   node test-frame-targeting.js
 */

'use strict';

const { extractFunction } = require('./sw-source.js');

/** 取出函数源码；找不到就报错，不要让测试静默跳过。 */
function need(name) {
  const found = extractFunction(name);
  if (!found) { throw new Error('在 extension/sw/ 里找不到 ' + name); }
  return found.src;
}

/* ------------------------------------------------------------------ *
 * 运行环境替身：够驱动这几个注入函数即可
 * ------------------------------------------------------------------ */
class FakeEvent { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } }
globalThis.PointerEvent = FakeEvent;
globalThis.MouseEvent = FakeEvent;
globalThis.window = globalThis;
globalThis.top = globalThis;
globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
globalThis.location = { href: 'https://example.test/page' };
globalThis.INJECT_TIMEOUT_MS = 12000;
globalThis.tabUnresponsive = (e) => ({ ok: false, error: 'tab_unresponsive', message: String(e) });
globalThis.withTimeout = (p) => p;

function makeEl(tag, text, opts) {
  const o = opts || {};
  const el = {
    tagName: tag.toUpperCase(),
    innerText: text,
    textContent: text,
    href: o.href || undefined,
    value: o.value,
    isContentEditable: !!o.editable,
    _events: [],
    _focused: 0,
    classList: { contains: () => false },
    getAttribute: (n) => (o.attrs && Object.prototype.hasOwnProperty.call(o.attrs, n) ? o.attrs[n] : null),
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ width: o.hidden ? 0 : 100, height: o.hidden ? 0 : 20, left: 10, top: 10 }),
    closest: (sel) => (sel === 'a[href]' && o.href ? el : null),
    focus: () => { el._focused++; },
    dispatchEvent: (ev) => { el._events.push(ev.type); return true; }
  };
  return el;
}

const btnA = makeEl('button', '确定');
const btnB = makeEl('button', '确定');
const plain = makeEl('div', '正文');
const inputA = makeEl('input', '', { value: '', attrs: { placeholder: '搜索' } });
const inputB = makeEl('input', '', { value: '', attrs: { placeholder: '搜索' } });

// 三个框架：0=主框架（只有正文），5 和 7 都含同名按钮/输入框
// ——改动前，它们各会被点一次、各被写入一次
const frames = [
  { id: 0, els: [plain], doc: { querySelectorAll: () => [plain], querySelector: () => null } },
  { id: 5, els: [btnA, inputA], doc: { querySelectorAll: () => [btnA, inputA], querySelector: () => null } },
  { id: 7, els: [btnB, inputB], doc: { querySelectorAll: () => [btnB, inputB], querySelector: () => null } }
];

const calls = [];

/** 所有框架当前的副作用计数，用于按阶段比对增量。 */
function snapshot() {
  let events = 0;
  let focused = 0;
  for (const f of frames) {
    for (const el of f.els) {
      events += el._events.length;
      focused += el._focused;
    }
  }
  return { events, focused };
}

globalThis.chrome = {
  scripting: {
    executeScript: async (opts) => {
      globalThis.stubCalls = (globalThis.stubCalls || 0) + 1;
      if (globalThis.stubThrow) { throw new Error(globalThis.stubThrow); }
      const ids = Array.isArray(opts.target.frameIds) ? opts.target.frameIds : frames.map((f) => f.id);
      const before = snapshot();
      const out = [];
      for (const id of ids) {
        const f = frames.find((x) => x.id === id);
        globalThis.document = f.doc;
        const a = (opts.args || [])[0];
        // 与 Chrome 一致：注入的函数抛错时记到该框架的 error，不影响其他框架
        try {
          out.push({ frameId: id, result: opts.func(a) });
        } catch (e) {
          out.push({ frameId: id, error: { message: String(e && e.message ? e.message : e) } });
        }
      }
      const after = snapshot();
      calls.push({
        ids,
        probe: !!(opts.args && opts.args[0] && opts.args[0].probe),
        delta: { events: after.events - before.events, focused: after.focused - before.focused }
      });
      return out;
    }
  }
};

const factory = new Function(
  'chrome',
  need('injectAndPick') + '\n'
  + need('injectInBestFrame') + '\n'
  + need('clickInPage') + '\n'
  + need('typeInPage') + '\n'
  + need('keyInPage') + '\n'
  + 'return { injectAndPick, injectInBestFrame, clickInPage, typeInPage, keyInPage };'
);
const { injectInBestFrame, clickInPage, typeInPage, keyInPage } = factory(globalThis.chrome);

const clickPicker = (res) => (res.ok ? 1000 : 0) + (res.isMainFrame ? 10 : 0);
const settle = () => new Promise((r) => setTimeout(r, 0));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 220)}`);
  }
}

(async () => {
  console.log('\n[1] click：探测无副作用，真实点击只发生在一个框架');
  calls.length = 0;
  btnA._events.length = 0; btnB._events.length = 0; plain._events.length = 0;
  const picked = await injectInBestFrame(1, clickInPage, [{ text: '确定', index: 0 }], clickPicker);
  await settle();

  check('第一次注入是覆盖全部框架的探测',
    calls[0] && calls[0].probe === true && calls[0].ids.length === 3, JSON.stringify(calls[0]));
  check('探测阶段没有产生任何点击事件', calls[0] && calls[0].delta.events === 0,
    `探测阶段事件数=${calls[0] && calls[0].delta.events}`);
  check('真实动作只发往一个框架', calls[1] && calls[1].ids.length === 1 && calls[1].probe === false,
    JSON.stringify(calls[1]));
  check('一次动作共两次注入调用', calls.length === 2, `calls=${calls.length}`);
  const clicked = [btnA, btnB].filter((b) => b._events.length > 0);
  check('同名按钮只有一个被点，且只点了一次',
    clicked.length === 1 && clicked[0]._events.length === 5,
    `被点框架数=${clicked.length} 事件=${JSON.stringify(clicked.map((b) => b._events))}`);
  check('返回值仍是正常的点击结果',
    picked.data && picked.data.ok && picked.data.clicked.text === '确定', JSON.stringify(picked).slice(0, 160));

  console.log('\n[2] click：没有任何框架命中时退回原来的全框架执行');
  calls.length = 0;
  const miss = await injectInBestFrame(1, clickInPage, [{ text: '不存在的按钮', index: 0 }], clickPicker);
  check('真实动作覆盖全部框架', calls[1] && calls[1].ids.length === 3, JSON.stringify(calls[1]));
  check('报错与原来一致', miss.data && miss.data.error === 'no_element_matched',
    JSON.stringify(miss).slice(0, 160));

  console.log('\n[3] click：显式指定 frameId 时不探测，只注入该框架');
  calls.length = 0;
  btnB._events.length = 0;
  await injectInBestFrame(1, clickInPage, [{ text: '确定', index: 0 }], clickPicker, 7);
  check('只调用一次且直接命中指定框架',
    calls.length === 1 && calls[0].ids.length === 1 && calls[0].ids[0] === 7, JSON.stringify(calls));

  console.log('\n[4] type：探测不聚焦、不写入');
  calls.length = 0;
  inputA._focused = 0; inputB._focused = 0;
  await injectInBestFrame(1, typeInPage, [{ text: '搜索', value: '关键词', method: 'text' }], clickPicker);
  await settle();
  check('探测阶段没有聚焦任何输入框', calls[0] && calls[0].delta.focused === 0,
    `探测阶段聚焦数=${calls[0] && calls[0].delta.focused}`);
  check('真实动作只发往一个框架', calls[1] && calls[1].ids.length === 1, JSON.stringify(calls[1]));
  const focused = [inputA, inputB].filter((i) => i._focused > 0);
  check('只有一个输入框被聚焦一次', focused.length === 1 && focused[0]._focused === 1, `聚焦数=${focused.length}`);

  console.log('\n[5] key：探测不派发按键事件');
  calls.length = 0;
  btnA._events.length = 0; btnB._events.length = 0;
  await injectInBestFrame(1, keyInPage, [{ key: 'Enter', selector: 'button' }], clickPicker);
  await settle();
  check('探测阶段没有按键事件', btnA._events.length === 0 && btnB._events.length === 0,
    `events=${btnA._events.length}/${btnB._events.length}`);

  console.log('\n[6] 注入本身失败时不重试第二轮，直接把原因报上去');
  calls.length = 0;
  globalThis.stubThrow = 'executeScript timeout 12000ms';
  globalThis.stubCalls = 0;
  const dead = await injectInBestFrame(1, clickInPage, [{ text: '确定', index: 0 }], clickPicker);
  globalThis.stubThrow = null;
  check('只发起了一次注入，没有白等第二轮', globalThis.stubCalls === 1, `实际注入次数=${globalThis.stubCalls}`);
  check('返回标签页无响应的错误', dead.error && dead.error.error === 'tab_unresponsive',
    JSON.stringify(dead).slice(0, 160));

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
