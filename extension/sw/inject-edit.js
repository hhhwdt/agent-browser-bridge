/**
 * Agent Browser Bridge —— 页面内输入类注入函数：富文本/输入框写入与按键派发。
 *
 * 本文件只放注入函数：Chrome 会把这些函数序列化后送进页面执行，
 * 因此每个函数都必须自包含——不能引用模块里的任何东西。这条规则由
 * tools/check-inject-scope.js 静态把关。
 */

export function typeInPage(opts) {
  const isMainFrame = (function () { try { return window === window.top; } catch (e) { return false; } })();

  // 页面侧虚拟鼠标：agent 操作时在页面上可见地移动和按下。
  // 必须定义在注入函数内部（页面里不存在模块作用域），靠固定 ID 幂等复用元素。
  // 纯可视化：任何失败都不能影响动作本身，全部吞掉异常。与点击动作同款实现。
  const cursor = (function () {
    const ensureCursor = () => {
      let el = document.getElementById('__abb_virtual_cursor__');
      if (el && el.dataset.abbCursorVer !== '2') { el.remove(); el = null; } /* 扩展更新后旧元素按版本号重建 */
      if (!el) {
        el = document.createElement('div');
        el.id = '__abb_virtual_cursor__';
        el.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;'
          + 'width:32px;height:32px;transition:left .18s ease-out,top .18s ease-out,transform .08s ease-in;'
          + 'filter:drop-shadow(1px 2px 2px rgba(0,0,0,.35));';
        el.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32"><path d="M5 3l14 9-6.5 1.5L9 20z" '
          + 'fill="#fff" stroke="#f85149" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        document.documentElement.appendChild(el);
        el.dataset.abbCursorVer = '2';
      }
      return el;
    };
    const guard = (fn) => { try { fn(); } catch (e) { /* 可视化失败不影响动作 */ } };
    return {
      move(x, y) {
        guard(() => {
          const el = ensureCursor();
          el.style.left = (x - 6) + 'px';
          el.style.top = (y - 3) + 'px';
        });
      },
      press() {
        guard(() => {
          const el = ensureCursor();
          el.style.transform = 'scale(.82)';
          setTimeout(() => {
            if (el.isConnected) { el.style.transform = 'scale(1)'; }
          }, 90);
        });
      }
    };
  })();

  /* 以下两个辅助函数必须定义在本函数内部：注入到页面的函数只携带自身源码，
     模块作用域的函数在页面里并不存在，若在外层定义会直接抛 ReferenceError。 */

  /** 极简 HTML 清洗：只用于 method=html 的插入，去掉可执行内容。 */
  const sanitizeHtml = (html) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html);

    tpl.content.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((n) => n.remove());

    const walk = (el) => {
      Array.from(el.attributes || []).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const val = String(attr.value || '');
        // 去掉事件处理器与 javascript: 协议
        if (name.startsWith('on') || /javascript:/i.test(val)) {
          el.removeAttribute(attr.name);
        }
      });
      Array.from(el.children || []).forEach(walk);
    };
    Array.from(tpl.content.children).forEach(walk);

    return tpl.innerHTML;
  };

  /** 用原生 setter 赋值，绕过 React 等框架对 value 的劫持。 */
  const setNativeValue = (el, val) => {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, val);
    } else {
      el.value = val;
    }
  };

  const value = opts.value == null ? '' : String(opts.value);
  const method = opts.method === 'html' ? 'html' : 'text';
  const clearFirst = !!opts.clear;
  const allowNonInput = !!opts.allowNonInput;

  const EDITABLE_SEL = 'input:not([type=hidden]), textarea, '
    + '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], '
    + '[role="textbox"]';

  const isEditable = (el) => {
    if (!el) { return false; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') { return true; }
    if (el.isContentEditable) { return true; }
    if (el.getAttribute('role') === 'textbox') { return true; }
    // designMode 文档整体可编辑，但元素上没有 contenteditable 属性（TinyMCE 的做法）
    if (document.designMode === 'on'
      && (el === document.body || el === document.documentElement)) {
      return true;
    }
    return false;
  };

  // ---- 定位目标 ----
  let target = null;
  let how = '';

  if (opts.selector) {
    target = document.querySelector(opts.selector);
    how = 'selector';
  } else if (opts.text) {
    const near = String(opts.text).trim();
    const pool = Array.from(document.querySelectorAll(EDITABLE_SEL));
    // 先按可访问名称精确匹配，再退化为包含匹配
    target = pool.find((el) => {
      const hay = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.id,
        el.getAttribute('data-testid')
      ].filter(Boolean).join(' ');
      return hay.includes(near);
    }) || pool.find((el) => {
      const hay = [el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ');
      return hay.includes(near);
    }) || null;
    how = 'text';
  } else if (document.designMode === 'on') {
    // designMode 编辑器（TinyMCE）没有可挂 contenteditable 的元素，直接写 body
    target = document.body;
    how = 'designModeBody';
  } else {
    // 未指定目标时，写入当前已聚焦的可编辑元素
    const ae = document.activeElement;
    if (isEditable(ae)) { target = ae; how = 'activeElement'; }
  }

  if (!target) {
    return {
      ok: false,
      error: 'no_element_matched',
      isMainFrame,
      hint: '未找到可输入元素。可先用 --selector 指定，或先在页面上点击编辑区使其获得焦点。'
    };
  }

  if (!isEditable(target) && !allowNonInput) {
    return {
      ok: false,
      error: 'not_editable',
      isMainFrame,
      tag: target.tagName.toLowerCase(),
      hint: '目标不是输入框、文本域或可编辑区域。确认无副作用后可加 allowNonInput=true 重试。'
    };
  }

  // 只读探测：点击动作同款做法，先在所有框架定位、再只对命中的框架执行。
  // 定位到可写目标即算命中，不聚焦、不写入。
  if (opts.probe) {
    return { ok: true, probe: true, found: true, isMainFrame, tag: target.tagName.toLowerCase() };
  }

  const tag = target.tagName.toLowerCase();

  // 输入会改变页面状态，先记录插入前的内容长度，便于核对
  const beforeLength = (target.isContentEditable
    ? (target.innerText || '')
    : (target.value || '')).length;

  // preventScroll 避免聚焦时把用户的视图滚走
  try {
    const tro = target.getBoundingClientRect();
    if (tro && (tro.width || tro.height)) {
      cursor.move(tro.left + tro.width / 2, tro.top + tro.height / 2);
      cursor.press();
    }
  } catch (e) { /* 虚拟光标失败不影响动作 */ }
  try {
    target.focus({ preventScroll: true });
  } catch (e) {
    target.focus();
  }

  let usedExecCommand = false;

  if (tag === 'input' || tag === 'textarea') {
    const next = clearFirst ? value : (target.value || '') + value;
    setNativeValue(target, next);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // contenteditable：必须让编辑器自己处理，才能同步内部模型
    if (clearFirst) {
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, null);
    }

    try {
      if (method === 'html') {
        usedExecCommand = document.execCommand('insertHTML', false, sanitizeHtml(value));
      } else {
        usedExecCommand = document.execCommand('insertText', false, value);
      }
    } catch (e) {
      usedExecCommand = false;
    }

    // execCommand 在个别环境下返回 false 或已被禁用，退回手工插入
    if (!usedExecCommand) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !target.contains(sel.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      if (method === 'html') {
        const frag = range.createContextualFragment(sanitizeHtml(value));
        range.insertNode(frag);
      } else {
        range.insertNode(document.createTextNode(value));
      }
      range.collapse(false);
    }

    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }

  const afterLength = (target.isContentEditable
    ? (target.innerText || '')
    : (target.value || '')).length;

  return {
    ok: true,
    isMainFrame,
    typed: {
      tag,
      how,
      method,
      cleared: clearFirst,
      insertedChars: value.length,
      beforeLength,
      afterLength,
      editable: target.isContentEditable === true,
      usedExecCommand,
      preview: (target.isContentEditable ? (target.innerText || '') : (target.value || '')).slice(0, 200)
    },
    url: location.href
  };
}

export function keyInPage(opts) {
  const key = String(opts.key || '');
  if (!key) { return { ok: false, error: 'missing_key' }; }

  const isMainFrame = (function () { try { return window === window.top; } catch (e) { return false; } })();

  // 页面侧虚拟鼠标：agent 操作时在页面上可见地移动和按下。
  // 必须定义在注入函数内部（页面里不存在模块作用域），靠固定 ID 幂等复用元素。
  // 纯可视化：任何失败都不能影响动作本身，全部吞掉异常。与点击动作同款实现。
  const cursor = (function () {
    const ensureCursor = () => {
      let el = document.getElementById('__abb_virtual_cursor__');
      if (el && el.dataset.abbCursorVer !== '2') { el.remove(); el = null; } /* 扩展更新后旧元素按版本号重建 */
      if (!el) {
        el = document.createElement('div');
        el.id = '__abb_virtual_cursor__';
        el.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;'
          + 'width:32px;height:32px;transition:left .18s ease-out,top .18s ease-out,transform .08s ease-in;'
          + 'filter:drop-shadow(1px 2px 2px rgba(0,0,0,.35));';
        el.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32"><path d="M5 3l14 9-6.5 1.5L9 20z" '
          + 'fill="#fff" stroke="#f85149" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        document.documentElement.appendChild(el);
        el.dataset.abbCursorVer = '2';
      }
      return el;
    };
    const guard = (fn) => { try { fn(); } catch (e) { /* 可视化失败不影响动作 */ } };
    return {
      move(x, y) {
        guard(() => {
          const el = ensureCursor();
          el.style.left = (x - 6) + 'px';
          el.style.top = (y - 3) + 'px';
        });
      },
      press() {
        guard(() => {
          const el = ensureCursor();
          el.style.transform = 'scale(.82)';
          setTimeout(() => {
            if (el.isConnected) { el.style.transform = 'scale(1)'; }
          }, 90);
        });
      }
    };
  })();

  let target = opts.selector ? document.querySelector(opts.selector) : null;
  if (!target) { target = document.activeElement; }
  if (!target || target === document.body) {
    // 主框架的 body 没有意义，交给其他框架竞争
    return { ok: false, error: 'no_target', isMainFrame };
  }

  // 只读探测：点击动作同款做法。找到按压目标即算命中，不派发任何事件。
  if (opts.probe) {
    return { ok: true, probe: true, found: true, isMainFrame, target: target.tagName.toLowerCase() };
  }

  const KEY_CODES = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32
  };
  const keyCode = KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);

  const init = {
    key,
    code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
    metaKey: !!opts.meta
  };

  try {
    const kro = target.getBoundingClientRect();
    if (kro && (kro.width || kro.height)) {
      cursor.move(kro.left + kro.width / 2, kro.top + kro.height / 2);
      cursor.press();
    }
  } catch (e) { /* 虚拟光标失败不影响动作 */ }

  try {
    target.focus({ preventScroll: true });
  } catch (e) { /* 元素可能不可聚焦，继续尝试派发 */ }

  const down = new KeyboardEvent('keydown', init);
  const notCancelled = target.dispatchEvent(down);

  // keypress 只对可打印字符有意义
  if (key.length === 1 || key === 'Enter') {
    target.dispatchEvent(new KeyboardEvent('keypress', init));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init));

  return {
    ok: true,
    isMainFrame,
    pressed: { key, keyCode, notCancelled, target: target.tagName.toLowerCase() },
    url: location.href
  };
}
