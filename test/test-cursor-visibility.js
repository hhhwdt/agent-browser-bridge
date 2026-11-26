#!/usr/bin/env node
/**
 * 虚拟光标可见性测试：操作发生时，箭头必须出现在用户看得见的页面上。
 *
 * 防的失败（实测都发生过）：
 *   - 目标在视口外时箭头被画到屏幕外，点击成功了但用户什么都没看到
 *   - 目标在 <dialog>/popover 里，箭头被顶层元素盖住（z-index 再高也没用）
 *   - showPopover 失败时元素留在 [popover] 未打开状态，被 UA 样式 display:none 隐藏，
 *     结果"修好了遮挡、弄丢了箭头"
 *
 * 用假 DOM 直接驱动真实的 clickInPage / keyInPage，不碰浏览器。
 *
 *   node test-cursor-visibility.js
 */

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

/* ---------------- 假 DOM ---------------- */

let scrolled = 0;
let popovers = 0;
let popoverThrows = false;
let cursorEl = null;

class FakeEvent { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } }

/** 光标元素：够跑 ensureCursor / move / press。 */
function makeCursorEl() {
  const attrs = new Set();
  const el = {
    id: '',
    innerHTML: '',
    isConnected: false,
    dataset: {},
    style: {},
    _popoverOpen: false,
    setAttribute: (n, v) => { attrs.add(n); el[n] = v; },
    getAttribute: (n) => (attrs.has(n) ? el[n] : null),
    hasAttribute: (n) => attrs.has(n),
    removeAttribute: (n) => { attrs.delete(n); if (n === 'popover') { el._popoverOpen = false; } },
    matches: (sel) => (sel === ':popover-open' ? el._popoverOpen : false),
    showPopover: () => {
      if (popoverThrows) { throw new Error('showPopover failed'); }
      popovers++;
      el._popoverOpen = true;
    },
    remove: () => { el.isConnected = false; cursorEl = null; }
  };
  return el;
}

/** 目标元素：默认可点击的按钮；opts.link=true 时是链接。 */
function makeTarget(rect, opts) {
  const o = opts || {};
  const el = {
    tagName: o.link ? 'A' : 'BUTTON',
    innerText: '编辑',
    textContent: '编辑',
    href: o.link ? 'https://e.test/next' : undefined,
    isConnected: true,
    _events: [],
    rect,
    classList: { contains: () => false },
    getAttribute: () => '',
    hasAttribute: () => false,
    closest: (sel) => (o.link && sel === 'a[href]' ? el : null),
    getBoundingClientRect: () => el.rect,
    focus: () => {},
    dispatchEvent: (ev) => { el._events.push(ev.type); return true; },
    scrollIntoView: () => {
      scrolled++;
      // 模拟浏览器：滚到视口中间后，元素的视口坐标变了
      el.rect = Object.assign({}, el.rect, {
        top: 400,
        left: 10,
        bottom: 420,
        right: 110
      });
    }
  };
  return el;
}

/** 把假 DOM 装到全局。 */
function installDom(target) {
  globalThis.PointerEvent = FakeEvent;
  globalThis.MouseEvent = FakeEvent;
  globalThis.KeyboardEvent = FakeEvent;
  globalThis.Event = FakeEvent;
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 800;
  globalThis.location = { href: 'https://e.test/page' };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });

  globalThis.document = {
    querySelectorAll: () => [target],
    querySelector: () => target,
    getElementById: () => cursorEl,
    createElement: () => {
      cursorEl = makeCursorEl();
      return cursorEl;
    },
    documentElement: {
      appendChild: (el) => {
        el.isConnected = true;
        cursorEl = el;
      }
    },
    activeElement: target,
    // body 必须与目标不同：keyInPage 会拒绝把 body 当按键目标
    body: { tagName: 'BODY' },
    execCommand: () => true,
    designMode: 'off'
  };
}

(async () => {
  const clickModule = await import(pathToFileURL(path.join(__dirname, '..', 'extension', 'sw', 'inject-click.js')).href);
  const keyModule = await import(pathToFileURL(path.join(__dirname, '..', 'extension', 'sw', 'inject-edit.js')).href);

  console.log('\n[1] 目标在视口外：先滚进视野，箭头画在滚动后的位置');
  {
    scrolled = 0; popovers = 0; popoverThrows = false; cursorEl = null;
    const target = makeTarget({ top: 5000, left: 10, bottom: 5020, right: 110, width: 100, height: 20 });
    installDom(target);

    const res = await clickModule.clickInPage({ selector: '#b' });
    check('点击成功', res && res.ok === true, JSON.stringify(res));
    check('调了一次 scrollIntoView', scrolled === 1, `scrolled=${scrolled}`);
    check('箭头位置按滚动后的坐标算', cursorEl && cursorEl.style.left === '54px' && cursorEl.style.top === '407px',
      cursorEl ? JSON.stringify({ left: cursorEl.style.left, top: cursorEl.style.top }) : 'no cursor');
    check('箭头进了 top layer', cursorEl && cursorEl.hasAttribute('popover') && popoverThrows === false && popovers === 1,
      cursorEl ? JSON.stringify({ popover: cursorEl.hasAttribute('popover'), popovers }) : 'no cursor');
  }

  console.log('\n[2] 目标已经可见：不动用户的滚动位置');
  {
    scrolled = 0; popovers = 0; popoverThrows = false; cursorEl = null;
    const target = makeTarget({ top: 100, left: 10, bottom: 120, right: 110, width: 100, height: 20 });
    installDom(target);

    const res = await clickModule.clickInPage({ selector: '#b' });
    check('点击成功', res && res.ok === true, JSON.stringify(res));
    check('没有滚动页面', scrolled === 0, `scrolled=${scrolled}`);
    check('箭头仍然出现并进了 top layer', cursorEl && cursorEl.style.left === '54px' && popoverThrows === false,
      cursorEl ? JSON.stringify(cursorEl.style) : 'no cursor');
  }

  console.log('\n[3] showPopover 失败：退回普通 fixed，箭头不能消失');
  {
    scrolled = 0; popovers = 0; popoverThrows = true; cursorEl = null;
    const target = makeTarget({ top: 100, left: 10, bottom: 120, right: 110, width: 100, height: 20 });
    installDom(target);

    const res = await clickModule.clickInPage({ selector: '#b' });
    check('点击仍然成功', res && res.ok === true, JSON.stringify(res));
    check('popover 属性被摘掉（否则会被 display:none 隐藏）',
      cursorEl && cursorEl.hasAttribute('popover') === false,
      cursorEl ? String(cursorEl.hasAttribute('popover')) : 'no cursor');
    check('位置仍然设置', cursorEl && cursorEl.style.left === '54px',
      cursorEl ? String(cursorEl.style.left) : 'no cursor');
  }

  console.log('\n[4] 按键同样先把目标滚进视野');
  {
    scrolled = 0; popovers = 0; popoverThrows = false; cursorEl = null;
    const target = makeTarget({ top: 5000, left: 10, bottom: 5020, right: 110, width: 100, height: 20 });
    installDom(target);

    const res = keyModule.keyInPage({ key: 'Enter', selector: '#b' });
    check('按键成功', res && res.ok === true, JSON.stringify(res));
    check('调了一次 scrollIntoView', scrolled === 1, `scrolled=${scrolled}`);
    check('箭头出现在滚动后的位置', cursorEl && cursorEl.style.top === '407px',
      cursorEl ? String(cursorEl.style.top) : 'no cursor');
  }

  console.log('\n[5] 元素在 iframe 里：外层 iframe 也滚进视野');
  {
    scrolled = 0; popovers = 0; popoverThrows = false; cursorEl = null;
    const target = makeTarget({ top: 100, left: 10, bottom: 120, right: 110, width: 100, height: 20 });
    installDom(target);
    let frameScrolled = 0;
    globalThis.frameElement = { scrollIntoView: () => { frameScrolled++; } };
    globalThis.parent = globalThis;

    await clickModule.clickInPage({ selector: '#b' });
    check('元素本身已可见，不再滚它', scrolled === 0, `scrolled=${scrolled}`);
    check('外层 iframe 被滚进视野', frameScrolled === 1, `frameScrolled=${frameScrolled}`);

    delete globalThis.frameElement;
    delete globalThis.parent;
  }

  console.log('\n[6] 只有"可见标签页 + 链接"才等那一拍（速度和可见性各让一步）');
  {
    const realSetTimeout = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); };
    try {
      const cases = [
        { state: 'visible', link: true, expect: true },
        { state: 'visible', link: false, expect: false },
        { state: 'hidden', link: true, expect: false }
      ];
      for (const c of cases) {
        delays.length = 0; scrolled = 0; popovers = 0; cursorEl = null;
        const target = makeTarget(
          { top: 100, left: 10, bottom: 120, right: 110, width: 100, height: 20 },
          { link: c.link }
        );
        installDom(target);
        globalThis.document.visibilityState = c.state;

        await clickModule.clickInPage({ selector: '#b' });
        check(`visibility=${c.state} ${c.link ? '链接' : '按钮'}：${c.expect ? '有' : '没有'} 180ms 展示等待`,
          c.expect ? delays.indexOf(180) >= 0 : delays.indexOf(180) < 0,
          JSON.stringify(delays));
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
