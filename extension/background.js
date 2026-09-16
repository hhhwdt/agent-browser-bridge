/**
 * Agent Browser Bridge —— 后台服务脚本。
 *
 * 工作方式：
 *   1. 通过长轮询（long-poll）连接本机 HTTP 桥接服务，地址固定为
 *      http://127.0.0.1:18777。
 *   2. 收到任务后，用 chrome.scripting.executeScript 在目标标签页里执行只读
 *      提取脚本，然后把结果回传。
 *
 * 关键点：executeScript 对后台标签页同样有效，且不会切换标签、不会聚焦窗口，
 * 因此用户在前台做别的事情时完全不受影响。
 *
 * 安全边界：
 *   - 只读。本扩展不提供点击、输入、导航等任何写操作。
 *   - 读取非默认授权站点时，需要用户在该站点的权限弹窗中明确授权。
 *   - 只连接 127.0.0.1，不访问任何外部网络。
 */

const BRIDGE_URL = 'http://127.0.0.1:18777';
const POLL_TIMEOUT_MS = 25000;   // 服务端最长挂起时间，略小于服务端超时
const RETRY_DELAY_MS = 3000;     // 桥接服务不可用时的重试间隔
const KEEPALIVE_ALARM = 'abb-keepalive';

/**
 * 当前扩展所在浏览器的标识。
 * 服务端据此把任务路由到正确的浏览器，避免同机多个浏览器互相顶替连接。
 */
const BROWSER_NAME = (() => {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('edg/')) { return 'edge'; }
  if (ua.includes('firefox/')) { return 'firefox'; }
  if (ua.includes('chrome/')) { return 'chrome'; }
  return 'unknown';
})();

let loopRunning = false;

/* ------------------------------------------------------------------ *
 * 页面内提取函数
 * 该函数会被序列化后注入目标标签页执行，因此不能引用外部作用域。
 * ------------------------------------------------------------------ */
function extractInPage(selector, includeLinks, returnHtml) {
  const pick = () => {
    if (selector) {
      const el = document.querySelector(selector);
      if (el) { return { el, used: selector }; }
    }
    // 依次回退到常见正文容器，最后兜底 body
    const candidates = [
      ['#main-content', '#main-content'],          // Confluence
      ['.wiki-content', '.wiki-content'],          // Confluence 旧版正文
      ['#content', '#content'],
      ['main', 'main'],
      ['article', 'article']
    ];
    for (const [sel, label] of candidates) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').trim().length > 0) {
        return { el, used: label };
      }
    }
    return { el: document.body, used: 'body' };
  };

  const { el, used } = pick();

  // 表单控件的值不在 innerText 里，必须单独取，否则读输入框永远为空
  const tag = el.tagName;
  const isFormControl = tag === 'INPUT' || tag === 'TEXTAREA';
  let text;

  if (isFormControl) {
    text = el.value == null ? '' : String(el.value);
  } else if (tag === 'SELECT') {
    const opt = el.options[el.selectedIndex];
    text = opt ? opt.text : '';
  } else {
    // 必须读取仍在文档中的元素：innerText 依赖渲染结果，脱离文档的克隆体会退化成
    // textContent，导致换行全部丢失。innerText 本身已排除 script/style 等不渲染内容，
    // 因此不需要预先克隆剔除。
    text = el.innerText || '';

    // 元素不可见等情况下 innerText 可能拿不到换行，退回按块级元素逐行拼接
    if (text && !text.includes('\n')) {
      const lines = [];
      el.querySelectorAll('p, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote').forEach((n) => {
        const t = (n.innerText || n.textContent || '').trim();
        if (t) { lines.push(t); }
      });
      if (lines.length > 1) { text = lines.join('\n'); }
    }
  }

  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let links = [];
  if (includeLinks) {
    links = Array.from(el.querySelectorAll('a[href]'))
      .map((a) => ({ text: (a.innerText || '').trim(), href: a.href }))
      .filter((l) => l.href && !l.href.startsWith('javascript:'));
  }

  const bodyEl = document.body;
  const frameEditable = !!bodyEl && (
    bodyEl.isContentEditable
    || document.designMode === 'on'
    || !!document.querySelector('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]')
  );

  const result = {
    title: document.title,
    url: location.href,
    usedSelector: used,
    // 供多框架注入时挑选结果
    isMainFrame: (function () { try { return window === window.top; } catch (e) { return false; } })(),
    selectorMatched: !!(selector && document.querySelector(selector)),
    // 编辑态下正文在编辑器框架里，主框架只剩工具栏，据此区分
    frameEditable,
    text,
    charCount: text.length,
    links
  };

  // 需要定位元素（例如找编辑器选择器）时，附上结构信息
  if (returnHtml) {
    const MAX = 200000;
    const html = el.outerHTML || '';
    result.html = html.length > MAX ? html.slice(0, MAX) : html;
    result.htmlTruncated = html.length > MAX;

    result.contentEditables = [];

    // TinyMCE 等老式富文本编辑器用 designMode='on' 让整个文档可编辑，
    // 此时 body 上没有 contenteditable 属性，必须单独识别，否则会误判为"无编辑器"。
    if (document.designMode === 'on' && document.body) {
      const r = document.body.getBoundingClientRect();
      result.contentEditables.push({
        index: 0,
        tag: 'body',
        id: document.body.id || '',
        className: (typeof document.body.className === 'string' ? document.body.className : '').slice(0, 120),
        ariaLabel: document.body.getAttribute('aria-label') || '',
        dataTestId: document.body.getAttribute('data-testid') || '',
        visible: r.width > 0 && r.height > 0,
        textLength: (document.body.innerText || '').length,
        designMode: true
      });
    }

    Array.from(document.querySelectorAll(
      '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    )).slice(0, 50).forEach((n) => {
      const r = n.getBoundingClientRect();
      result.contentEditables.push({
        index: result.contentEditables.length,
        tag: n.tagName.toLowerCase(),
        id: n.id || '',
        className: (typeof n.className === 'string' ? n.className : '').slice(0, 120),
        ariaLabel: n.getAttribute('aria-label') || '',
        dataTestId: n.getAttribute('data-testid') || '',
        visible: r.width > 0 && r.height > 0,
        textLength: (n.innerText || '').length,
        designMode: false
      });
    });
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * 页面内点击函数
 * 同样会被序列化注入目标标签页，不能引用外部作用域。
 * ------------------------------------------------------------------ */
function clickInPage(opts) {
  const wantedIndex = typeof opts.index === 'number' && opts.index >= 0 ? opts.index : 0;
  const allowNonLink = !!opts.allowNonLink;
  const isMainFrame = (function () { try { return window === window.top; } catch (e) { return false; } })();

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) { return false; }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { return false; }
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };

  let candidates = [];

  if (opts.selector) {
    candidates = Array.from(document.querySelectorAll(opts.selector));
  } else if (opts.href) {
    candidates = Array.from(document.querySelectorAll('a[href]'))
      .filter((a) => a.href.includes(opts.href));
  } else if (opts.text) {
    const near = String(opts.text).trim();
    const pool = Array.from(document.querySelectorAll(
      'a, button, [role="button"], [role="link"], [role="tab"], summary, '
      + 'input[type="submit"], input[type="button"], label, li, span, div'
    ));
    // 优先命中链接，其次命中文本最短的元素，避免选到包裹性的大容器
    candidates = pool
      .filter((el) => ((el.innerText || el.textContent || '').trim()).includes(near))
      .sort((a, b) => {
        const aIsLink = a.closest && a.closest('a[href]') ? 0 : 1;
        const bIsLink = b.closest && b.closest('a[href]') ? 0 : 1;
        if (aIsLink !== bIsLink) { return aIsLink - bIsLink; }
        return (a.innerText || '').trim().length - (b.innerText || '').trim().length;
      });
  } else {
    return { ok: false, error: 'missing_target', hint: '需要 selector、text 或 href 之一' };
  }

  candidates = candidates.filter(visible);

  if (candidates.length === 0) {
    return { ok: false, error: 'no_element_matched', isMainFrame };
  }
  if (wantedIndex >= candidates.length) {
    return { ok: false, error: 'index_out_of_range', matched: candidates.length, isMainFrame };
  }

  const target = candidates[wantedIndex];
  const tag = target.tagName.toLowerCase();
  const anchor = target.closest ? target.closest('a[href]') : null;
  const isLink = !!anchor;

  // 非链接元素按风险分级：
  //   按钮类元素 + 非破坏性文案（编辑、插入、格式、取消…）→ 自动放行，便于全自动操作
  //   按钮类元素 + 破坏性文案（删除/提交/发布/保存…）→ 必须显式 allowNonLink=true
  //   其他元素（容器 div 等）→ 仍要求 allowNonLink，因为点容器不是有效的 UI 操作
  const DESTRUCTIVE_RE = /删除|移除|清空|清掉|提交|发布|发送|保存|更新|覆盖|注销|退出|回滚|停用|下线|作废|确认|同意|delete|remove|clear|discard|submit|publish|send|save|update|overwrite|logout|rollback|revoke|deactivate|confirm/i;

  const role = target.getAttribute('role') || '';
  const isButtonLike = ['button', 'input', 'summary'].includes(tag)
    || ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch'].includes(role)
    || target.hasAttribute('onclick')
    || target.classList.contains('aui-button')
    || target.classList.contains('btn')
    || target.classList.contains('button');

  const label = (target.innerText || target.textContent || '').trim();
  const destructive = isButtonLike && label.length <= 60 && DESTRUCTIVE_RE.test(label);

  // 试运行：只回报判定结果，不真正点击，也不返回拦截错误。
  // 必须放在拦截检查之前，否则容器类目标会直接报 not_a_link，拿不到判定信息。
  if (opts.dryRun) {
    return {
      ok: true,
      isMainFrame,
      dryRun: true,
      wouldClick: {
        tag,
        text: label.slice(0, 200),
        href: isLink ? target.href : null,
        isLink,
        isButtonLike,
        destructive,
        // 不传 allowNonLink 时是否会被拦截
        blocked: !isLink && (!isButtonLike || destructive)
      },
      matched: candidates.length
    };
  }

  if (!isLink && !isButtonLike && !allowNonLink) {
    return {
      ok: false,
      error: 'not_a_link',
      isMainFrame,
      tag,
      text: label.slice(0, 120),
      hint: '目标既不是链接也不是按钮。确认该元素没有副作用后，可加 --force（allowNonLink=true）重试。'
    };
  }

  if (destructive && !allowNonLink) {
    return {
      ok: false,
      error: 'destructive_action_blocked',
      isMainFrame,
      tag,
      text: label.slice(0, 120),
      hint: '该按钮疑似不可逆操作（删除/提交/发布/保存等）。确认无副作用后加 --force（allowNonLink=true）重试。'
    };
  }

  const clickTarget = isLink ? anchor : target;

  const info = {
    tag,
    text: (clickTarget.innerText || clickTarget.textContent || '').trim().slice(0, 200),
    href: isLink ? clickTarget.href : null,
    linkTarget: isLink ? (clickTarget.getAttribute('target') || '') : '',
    matched: candidates.length,
    index: wantedIndex,
    isLink,
    isButtonLike,
    destructive
  };

  // 派发完整的鼠标事件序列。
  // 只用 element.click() 不够：React/Vue 等框架常把处理器绑在 mousedown/pointerdown
  // 上，合成 click 不会触发它们，导致"点编辑按钮"这类操作静默失效。
  const simulateClick = (el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: cx,
      screenY: cy,
      button: 0,
      detail: 1
    };

    const fire = (type, buttons) => {
      const isPointer = type.indexOf('pointer') === 0;
      let ev;
      try {
        ev = isPointer
          ? new PointerEvent(type, { ...common, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true })
          : new MouseEvent(type, { ...common, buttons });
      } catch (e) {
        // 个别环境不支持 PointerEvent，退回鼠标事件
        ev = new MouseEvent(type === 'pointerdown' ? 'mousedown' : (type === 'pointerup' ? 'mouseup' : type),
          { ...common, buttons });
      }
      el.dispatchEvent(ev);
    };

    try { el.focus({ preventScroll: true }); } catch (e) { /* 元素可能不可聚焦 */ }

    fire('pointerdown', 1);
    fire('mousedown', 1);
    fire('pointerup', 0);
    fire('mouseup', 0);
    fire('click', 0);
  };

  try {
    simulateClick(clickTarget);
  } catch (e) {
    return { ok: false, error: 'click_failed', message: String(e && e.message ? e.message : e), info };
  }

  return { ok: true, clicked: info, urlBefore: location.href, isMainFrame };
}

/* ------------------------------------------------------------------ *
 * 页面内链接枚举
 * ------------------------------------------------------------------ */
function linksInPage(selector, filterText) {
  const scope = selector ? document.querySelector(selector) : document;
  if (!scope) {
    return { links: [], usedSelector: null, error: 'selector_not_found' };
  }

  const out = [];
  scope.querySelectorAll('a[href]').forEach((a) => {
    const r = a.getBoundingClientRect();
    const st = window.getComputedStyle(a);
    const isVisible = r.width > 0 && r.height > 0
      && st.visibility !== 'hidden' && st.display !== 'none';
    const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) { return; }
    if (filterText && !text.includes(filterText)) { return; }
    out.push({ index: out.length, text: text.slice(0, 200), href: a.href, visible: isVisible });
  });

  return {
    links: out,
    usedSelector: selector || 'document',
    isMainFrame: (function () { try { return window === window.top; } catch (e) { return false; } })(),
    href: location.href
  };
}

/* ------------------------------------------------------------------ *
 * 页面内文本输入函数
 *
 * 富文本编辑器（Confluence 等）的正文区是 contenteditable，直接改 value 或
 * innerHTML 不会被编辑器识别，必须用 execCommand 触发真实的编辑行为，
 * 编辑器才能正确更新内部模型。普通表单控件则用原生 setter + input 事件。
 * ------------------------------------------------------------------ */

function typeInPage(opts) {
  const isMainFrame = (function () { try { return window === window.top; } catch (e) { return false; } })();
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

  const tag = target.tagName.toLowerCase();

  // 输入会改变页面状态，先记录插入前的内容长度，便于核对
  const beforeLength = (target.isContentEditable
    ? (target.innerText || '')
    : (target.value || '')).length;

  // preventScroll 避免聚焦时把用户的视图滚走
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

/* ------------------------------------------------------------------ *
 * 页面内按键函数
 *
 * 注意：这里派发的是合成 KeyboardEvent，只会触发页面内的 JS 处理器，
 * 不会触发浏览器级快捷键（如 Ctrl+S、Ctrl+T），因此不会影响用户浏览器。
 * 但合成事件不会产生文本输入，插入文本请用 type。
 * ------------------------------------------------------------------ */
function keyInPage(opts) {
  const key = String(opts.key || '');
  if (!key) { return { ok: false, error: 'missing_key' }; }

  const isMainFrame = (function () { try { return window === window.top; } catch (e) { return false; } })();

  let target = opts.selector ? document.querySelector(opts.selector) : null;
  if (!target) { target = document.activeElement; }
  if (!target || target === document.body) {
    // 主框架的 body 没有意义，交给其他框架竞争
    return { ok: false, error: 'no_target', isMainFrame };
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

/* ------------------------------------------------------------------ *
 * 页面内操作标记
 *
 * 在被操作的页面上显示一个不影响布局、不拦截点击的浮动提示，让用户能直观
 * 看到"这个页面正被 agent 操作"。挂在 documentElement 下（body 的兄弟节点），
 * 因此不会被正文提取（读取 #main-content 或 body）收进结果里。
 * ------------------------------------------------------------------ */
function indicatorInPage(opts) {
  const ID = '__abb_agent_indicator__';
  const existing = document.getElementById(ID);

  if (opts && opts.clear) {
    if (existing) {
      const anim = existing.animate(
        [{ opacity: 0.97 }, { opacity: 0, transform: 'translateY(6px) scale(.98)' }],
        { duration: 180, easing: 'ease-in', fill: 'forwards' }
      );
      anim.onfinish = () => existing.remove();
    }
    return { ok: true, cleared: !!existing };
  }

  if (existing) { existing.remove(); }

  // 按操作类型区分强调色，让用户一眼看出刚发生了什么
  const ACCENT = {
    read: '#4c9aff',
    links: '#4c9aff',
    click: '#3fb950',
    type: '#e3a008',
    key: '#e3a008',
    navigate: '#a371f7',
    mark: '#3fb950'
  };
  const accent = (opts && ACCENT[opts.kind]) || '#3fb950';

  const el = document.createElement('div');
  el.id = ID;
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('data-abb-indicator', '1');
  el.style.cssText = [
    'position:fixed',
    'right:20px',
    'bottom:20px',
    'z-index:2147483647',
    'display:inline-flex',
    'align-items:center',
    'gap:9px',
    'padding:9px 16px 9px 14px',
    'border-radius:999px',
    'background:rgba(22,26,33,.93)',
    'backdrop-filter:blur(14px) saturate(160%)',
    '-webkit-backdrop-filter:blur(14px) saturate(160%)',
    'color:#eef2f7',
    'font:500 12.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif',
    'letter-spacing:.2px',
    'border:1px solid rgba(255,255,255,.10)',
    'box-shadow:0 8px 28px rgba(0,0,0,.30), 0 1px 2px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.07)',
    'pointer-events:none',
    'white-space:nowrap',
    'max-width:min(360px,calc(100vw - 40px))',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'opacity:0'
  ].join(';');

  // 呼吸圆点：提示"正在进行"
  const dot = document.createElement('span');
  dot.style.cssText = [
    'width:7px',
    'height:7px',
    'border-radius:50%',
    'flex:none',
    'background:' + accent,
    'box-shadow:0 0 8px ' + accent
  ].join(';');
  dot.animate(
    [
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(1.35)', opacity: .55 },
      { transform: 'scale(1)', opacity: 1 }
    ],
    { duration: 1700, iterations: Infinity, easing: 'ease-in-out' }
  );
  el.appendChild(dot);

  const label = document.createElement('span');
  label.style.cssText = [
    'overflow:hidden',
    'text-overflow:ellipsis',
    'white-space:nowrap'
  ].join(';');
  label.textContent = (opts && opts.text) || 'agent 操作中';
  el.appendChild(label);

  document.documentElement.appendChild(el);

  // 入场：轻微上浮 + 淡入
  el.animate(
    [
      { opacity: 0, transform: 'translateY(10px) scale(.96)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ],
    { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' }
  );

  const ttl = opts && typeof opts.ttlMs === 'number' ? opts.ttlMs : 15000;
  if (ttl > 0) {
    setTimeout(() => {
      const cur = document.getElementById(ID);
      if (!cur || cur !== el) { return; }
      const anim = cur.animate(
        [{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px) scale(.98)' }],
        { duration: 220, easing: 'ease-in', fill: 'forwards' }
      );
      anim.onfinish = () => cur.remove();
    }, ttl);
  }

  return { ok: true, shown: true, text: label.textContent, accent };
}

/* ------------------------------------------------------------------ *
 * 页面内等待函数
 *
 * 自动化流程需要等待异步 UI：编辑器加载、对话框弹出、列表刷新。
 * 返回 Promise，Chrome 会等它 resolve 后再返回结果。
 * ------------------------------------------------------------------ */
async function waitInPage(opts) {
  const isMainFrame = (function () {
    try { return window === window.top; } catch (e) { return false; }
  })();

  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10000;
  const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 200;
  const state = opts.state === 'disappear' ? 'disappear' : 'appear';
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();

  const satisfied = () => {
    if (opts.selector) {
      const el = document.querySelector(opts.selector);
      if (!el) { return false; }
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      // 只在要求"出现"时校验可见性，避免隐藏元素永远等不到
      if (state === 'appear' && r && (r.width <= 0 || r.height <= 0)) { return false; }
      return true;
    }
    if (opts.text) {
      return !!document.body && (document.body.innerText || '').includes(opts.text);
    }
    return false;
  };

  for (;;) {
    const now = satisfied();
    if (state === 'appear' ? now : !now) {
      return { ok: true, isMainFrame, state, satisfied: true, elapsedMs: Date.now() - started };
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: 'wait_timeout', isMainFrame, state, timeoutMs, elapsedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/* ------------------------------------------------------------------ *
 * 页面内标签页角标
 *
 * 扩展图标上的徽标只在切到该标签页时才可见，标签栏本身看不出来。
 * 这里直接把站点 favicon 重绘并叠加一个彩色圆点，写回 <link rel="icon">，
 * 这样标签栏上能一眼看出哪些页面正被 agent 操作。
 *
 * 清除时只需移除我们插入的 link，浏览器会自动回退到页面原有的图标。
 * ------------------------------------------------------------------ */
function tabMarkInPage(opts) {
  const ATTR_HREF = 'data-abb-favicon-original';
  const ATTR_TYPE = 'data-abb-favicon-original-type';
  const ATTR_TITLE = 'data-abb-original-title';
  const CREATED_ID = '__abb_favicon_mark__';
  // 必须在本函数内定义：注入到页面的函数拿不到模块作用域的常量
  const DEFAULT_TITLE_PREFIX = '🤖 ';

  const ICON_SEL = 'link[rel~="icon"], link[rel="shortcut icon"]';
  const TIMER_KEY = '__abb_mark_timer__';

  /** 还原标题与图标。清空标记与自动过期共用这段逻辑。 */
  const restore = () => {
    let restored = 0;

    const root = document.documentElement;
    if (root.hasAttribute(ATTR_TITLE)) {
      document.title = root.getAttribute(ATTR_TITLE);
      root.removeAttribute(ATTR_TITLE);
      restored++;
    }

    document.querySelectorAll('link[' + ATTR_HREF + ']').forEach((l) => {
      const orig = l.getAttribute(ATTR_HREF);
      if (orig) {
        l.setAttribute('href', orig);
      } else {
        // 原本没有 href（依赖浏览器默认 /favicon.ico）时不要留下空 href
        l.removeAttribute('href');
      }
      const origType = l.getAttribute(ATTR_TYPE);
      if (origType) { l.setAttribute('type', origType); } else { l.removeAttribute('type'); }

      l.removeAttribute(ATTR_HREF);
      l.removeAttribute(ATTR_TYPE);
      restored++;
    });
    const created = document.getElementById(CREATED_ID);
    if (created) { created.remove(); restored++; }

    return restored;
  };

  /** 取消已排期的自动过期。 */
  const cancelTimer = () => {
    try {
      if (window[TIMER_KEY]) { clearTimeout(window[TIMER_KEY]); window[TIMER_KEY] = null; }
    } catch (e) { /* 忽略 */ }
  };

  // ---- 清除：还原标题与图标 ----
  if (opts && opts.clear) {
    cancelTimer();
    return { ok: true, cleared: restore() > 0 };
  }

  // ---- 标题前缀 ----
  // 实测浏览器不会因子图标 link 变化而重绘标签栏图标（DOM 已改但图标不变），
  // 因此标题前缀才是标签栏上唯一可靠的可见标记。
  const root = document.documentElement;
  if (!root.hasAttribute(ATTR_TITLE)) {
    root.setAttribute(ATTR_TITLE, document.title);
  }
  const baseTitle = root.getAttribute(ATTR_TITLE);
  const prefix = opts.titlePrefix || DEFAULT_TITLE_PREFIX;
  if (document.title !== prefix + baseTitle) {
    document.title = prefix + baseTitle;
  }

  const accent = (opts && opts.accent) || '#1a7f37';
  const size = 64;

  let href = null;
  try {
    const links = Array.from(document.querySelectorAll(ICON_SEL));
    const last = links[links.length - 1];
    if (last && (last.getAttribute('href') || last.href)) {
      href = last.getAttribute('href') || last.href;
    }
  } catch (e) { /* 走无图标兜底 */ }

  /** 把原图标画进画布，右下角叠加圆点。 */
  const compose = (img) => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');

    if (img) {
      const s = Math.round(size * 0.76);
      g.drawImage(img, 0, 0, s, s);
    } else {
      g.fillStyle = '#8b949e';
      g.fillRect(0, 0, size, size);
    }

    const r = size * 0.29;
    const cx = size - r - 1;
    const cy = size - r - 1;

    g.beginPath();
    g.arc(cx, cy, r + 2, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();

    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = accent;
    g.fill();

    return c;
  };

  /**
   * 把 dataUrl 装到所有图标 link 上。
   *
   * 两个关键点：
   *   1. 必须同时改所有 <link rel=icon>，只改最后一个的话浏览器可能仍采用另一个；
   *   2. 必须把 type 一并改成 image/png。我们写的是 PNG data URL，
   *      若 type 仍是 image/x-icon，浏览器按 ico 解码会失败并回退到原图标——
   *      表现就是"DOM 里有标记，标签栏却看不到"。
   */
  const install = (dataUrl) => {
    const links = Array.from(document.querySelectorAll(ICON_SEL));
    if (links.length > 0) {
      links.forEach((l) => {
        if (!l.hasAttribute(ATTR_HREF)) {
          l.setAttribute(ATTR_HREF, l.getAttribute('href') || '');
          l.setAttribute(ATTR_TYPE, l.getAttribute('type') || '');
        }
        l.setAttribute('href', dataUrl);
        l.setAttribute('type', 'image/png');
      });
      return { els: links, mode: 'patched' };
    }

    const link = document.createElement('link');
    link.id = CREATED_ID;
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = dataUrl;
    (document.head || document.documentElement).appendChild(link);
    return { els: [link], mode: 'created' };
  };

  // 先立即装上纯色底角标，绝不同步等待图片。
  // 后台标签页的定时器会被浏览器节流（最长可达分钟级），
  // 若在此 await 图片加载，注入会迟迟不返回，把整个任务拖到超时。
  let installed;
  try {
    installed = install(compose(null).toDataURL('image/png'));
  } catch (e) {
    return { ok: false, error: 'favicon_mark_failed', message: String(e && e.message ? e.message : e) };
  }

  // 再异步尝试把站点原图标合成进去，成功就替换，失败保持纯色底。
  if (href) {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const better = compose(img).toDataURL('image/png');
          (installed.els || []).forEach((el) => {
            if (document.contains(el)) { el.setAttribute('href', better); }
          });
        } catch (e) {
          // 跨域图标会污染画布，保持纯色底即可
        }
      };
      img.src = href;
    } catch (e) { /* 忽略，纯色底已可用 */ }
  }

  // ---- 自动过期 ----
  // 页面侧定时器。后台标签页的定时器会被节流，但用户一旦切回该标签页就会触发，
  // 因此标记不会永久残留——这是"冻住的标签页清不掉"的兜底方案。
  // 默认 3 分钟：agent 的操作是连续的，每次操作都会重置计时，因此足够；
  // 残留窗口更短，避免标签页看起来"一直被占用"。
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : 3 * 60 * 1000;
  cancelTimer();
  if (ttlMs > 0) {
    try {
      window[TIMER_KEY] = setTimeout(() => {
        try { restore(); } catch (e) { /* 忽略 */ }
      }, ttlMs);
    } catch (e) { /* 定时器不可用时忽略 */ }
  }

  return {
    ok: true,
    marked: true,
    mode: installed.mode,
    accent,
    titleMarked: true,
    autoExpireMs: ttlMs,
    originalUpgradePending: !!href
  };
}

/* ------------------------------------------------------------------ *
 * 页面内框架诊断
 *
 * 用于排查"编辑器藏在哪个框架、以何种方式可编辑"这类问题。
 * 只读取框架自身的状态，不改动页面。
 * ------------------------------------------------------------------ */
function diagInPage() {
  const CE_SEL = '[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';
  const body = document.body;

  return {
    isMainFrame: (function () { try { return window === window.top; } catch (e) { return false; } })(),
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    designMode: document.designMode || 'off',
    bodyExists: !!body,
    bodyIsContentEditable: body ? body.isContentEditable : null,
    bodyCEAttr: body ? body.getAttribute('contenteditable') : null,
    bodyEditableByDesignMode: !!body && document.designMode === 'on',
    editableAttrCount: document.querySelectorAll(CE_SEL).length,
    textboxRoleCount: document.querySelectorAll('[role="textbox"]').length,
    inputCount: document.querySelectorAll('input, textarea').length,
    iframeCount: document.querySelectorAll('iframe').length,
    bodyTextLength: body ? (body.innerText || '').length : 0,
    activeElement: document.activeElement ? document.activeElement.tagName.toLowerCase() : null
  };
}

/* ------------------------------------------------------------------ *
 * 任务处理
 * ------------------------------------------------------------------ */

/** 列出所有已打开标签页（只读元信息，不读取页面内容）。 */
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    ok: true,
    tabs: tabs
      .filter((t) => t.url && !t.url.startsWith('edge://') && !t.url.startsWith('chrome://'))
      .map((t) => ({
        id: t.id,
        windowId: t.windowId,
        index: t.index,
        active: t.active,
        discarded: !!t.discarded,
        status: t.status || '',
        title: t.title || '',
        url: t.url || '',
        // 我们打标记时会把图标换成 data URL，据此可发现标题前缀已丢的残留标记
        favIconUrl: (t.favIconUrl || '').slice(0, 60)
      }))
  };
}

/**
 * 注入超时。标签页的渲染进程可能已休眠或无响应，此时 executeScript 永远不返回，
 * 会把整个任务（乃至轮询循环）一起拖死。加超时后快速失败并给出明确原因。
 */
const INJECT_TIMEOUT_MS = 12000;

/** 视觉标记类注入的预算。标记是锦上添花，遇到冻结标签页不值得久等。 */
const MARK_INJECT_TIMEOUT_MS = 4000;

/** session 动作里单个 cookie 值的截断长度。 */
const SESSION_VALUE_MAX = 2000;

/** download 动作的默认大小上限（字节），超过直接报 too_large。 */
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** eval 动作返回值的 JSON 上限，超过则截断并置 truncated=true。 */
const EVAL_MAX_JSON = 200 * 1024;

/** 给 Promise 加超时。用于包装可能永不返回的浏览器 API 调用。 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); });
}

/** 把注入失败归一化成可读错误，区分"标签页无响应"与其他失败。 */
function tabUnresponsive(err, tabId) {
  const msg = String(err && err.message ? err.message : err);
  const isTimeout = /timeout/i.test(msg);
  return {
    ok: false,
    error: isTimeout ? 'tab_unresponsive' : 'inject_failed',
    tabId,
    message: msg,
    hint: isTimeout
      ? '该标签页的渲染进程无响应（可能已休眠或卡死）。可在浏览器里点开该标签页唤醒，或换一个标签页。'
      : undefined
  };
}

/**
 * 在标签页内注入脚本，覆盖所有框架后挑选最合适的结果。
 *
 * 为什么要覆盖所有框架：Confluence 的富文本编辑器位于 iframe 内，
 * 只注入主框架拿不到编辑器，输入与读取都会失败。
 *
 * picker 接收每个框架的结果，返回得分；得分最高者被采用。
 * 注入失败的框架会被跳过（例如无权限的跨域子框架）。
 */
async function injectAndPick(tabId, func, args, picker, frameId, timeoutOverride) {
  let injection;
  const budget = typeof timeoutOverride === 'number' ? timeoutOverride : INJECT_TIMEOUT_MS;

  // 指定框架时只注入该框架，用于精确操作 iframe 内的编辑器
  if (typeof frameId === 'number') {
    try {
      injection = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args }),
        budget
      );
    } catch (e) {
      return {
        error: {
          ok: false,
          error: 'frame_not_accessible',
          frameId,
          message: String(e && e.message ? e.message : e),
          hint: '该框架不可注入。可用 frames 动作查看当前所有框架及其 frameId。'
        }
      };
    }
  } else {
    try {
      injection = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args }),
        budget
      );
    } catch (e) {
      // 超时说明渲染进程无响应（常见于长期未打开的标签页里有挂死的子框架），
      // 再退一次只是白等一轮，直接报告。只有非超时错误才退回主框架重试。
      if (/timeout/i.test(String(e && e.message ? e.message : e))) {
        return { error: tabUnresponsive(e, tabId) };
      }
      try {
        injection = await withTimeout(
          chrome.scripting.executeScript({ target: { tabId }, func, args }),
          budget
        );
      } catch (e2) {
        return { error: tabUnresponsive(e2, tabId) };
      }
    }
  }

  const frames = (injection || []).map((r) => ({
    frameId: r.frameId,
    error: r.error ? (r.error.message || r.error.value || String(r.error)) : null,
    result: r.result || null
  }));

  if (frames.length === 0) {
    return { error: { ok: false, error: 'no_injection_result' } };
  }

  const usable = frames.filter((f) => f.result && !f.error);
  if (usable.length === 0) {
    const firstErr = frames.find((f) => f.error);
    if (firstErr) {
      return { error: { ok: false, error: 'page_script_error', message: firstErr.error } };
    }
    return { error: { ok: false, error: 'empty_result' } };
  }

  let best = usable[0];
  let bestScore = -Infinity;
  for (const f of usable) {
    const s = picker(f.result, f.frameId);
    if (s > bestScore) { bestScore = s; best = f; }
  }

  return { data: best.result, frameId: best.frameId, frameCount: frames.length };
}

/** 返回扩展的运行诊断信息：标识、连接状态、错误日志。 */
async function diagAction() {
  let errors = [];
  let marks = [];
  let alarm = null;
  try {
    const stored = await chrome.storage.session.get(ERROR_LOG_KEY);
    errors = (stored && stored[ERROR_LOG_KEY]) || [];
  } catch (e) { /* 忽略 */ }
  try {
    const stored = await chrome.storage.session.get(MARKS_KEY);
    marks = (stored && stored[MARKS_KEY]) || [];
  } catch (e) { /* 忽略 */ }
  try {
    alarm = await chrome.alarms.get(KEEPALIVE_ALARM);
  } catch (e) { /* 忽略 */ }

  let boot = null;
  try {
    const stored = await chrome.storage.local.get('abb-boot');
    boot = (stored && stored['abb-boot']) || null;
  } catch (e) { /* 忽略 */ }

  return {
    ok: true,
    data: {
      browser: BROWSER_NAME,
      bridgeUrl: BRIDGE_URL,
      version: chrome.runtime.getManifest().version,
      loopRunning,
      // service worker 启动次数与时间，用于判断是否被频繁回收
      boot,
      markedTabs: marks,
      keepaliveAlarm: alarm ? { periodInMinutes: alarm.periodInMinutes, scheduledTime: alarm.scheduledTime } : null,
      errorCount: errors.length,
      errors
    }
  };
}

/** 等待页面条件成立（元素出现/消失、文字出现）。 */
async function waitTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  if (!task.selector && !task.text) {
    return { ok: false, error: 'missing_condition', hint: '需要提供 selector 或 text 作为等待条件' };
  }

  const timeoutMs = typeof task.timeoutMs === 'number' ? task.timeoutMs : 10000;

  const picked = await injectAndPick(
    tab.id,
    waitInPage,
    [{
      selector: task.selector || null,
      text: task.text || null,
      state: task.state === 'disappear' ? 'disappear' : 'appear',
      timeoutMs,
      pollMs: typeof task.pollMs === 'number' ? task.pollMs : 200
    }],
    // 满足条件的框架优先；都未满足时取主框架的报错
    (res) => (res.ok ? 1000 : 0) + (res.isMainFrame ? 10 : 0),
    typeof task.frameId === 'number' ? task.frameId : undefined,
    timeoutMs + 5000
  );

  if (picked.error) { return { ...picked.error, url: tab.url }; }
  const data = picked.data;
  if (!data.ok) {
    return {
      ok: false,
      error: data.error || 'wait_timeout',
      tabId: tab.id,
      frameId: picked.frameId,
      state: data.state,
      timeoutMs,
      hint: '等待超时：条件在指定时间内未成立'
    };
  }

  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      frameId: picked.frameId,
      state: data.state,
      elapsedMs: data.elapsedMs,
      url: tab.url || ''
    }
  };
}

/**
 * 把一个标签页切到前台并聚焦其窗口。
 *
 * 用途：长期未访问的标签页会被浏览器冻结，渲染进程不响应注入。
 * 需要对其操作时先唤醒。会改变用户当前视图，属于打断性操作。
 */
async function activateTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页' };
  }

  const wasActive = !!tab.active;
  if (!wasActive) {
    try {
      await chrome.tabs.update(tab.id, { active: true });
    } catch (e) {
      return { ok: false, error: 'activate_failed', message: String(e && e.message ? e.message : e) };
    }
  }

  // 窗口最小化时，仅激活标签页不足以唤醒渲染进程
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    // 窗口 API 失败不影响标签页已激活的事实
  }

  return {
    ok: true,
    data: {
      tabId: tab.id,
      windowId: tab.windowId,
      wasActive,
      browser: BROWSER_NAME,
      title: tab.title || '',
      url: tab.url || ''
    }
  };
}

/** 诊断标签页内所有框架的状态，返回全部框架结果（不做挑选）。 */
async function framesDiag(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: diagInPage
    });
  } catch (e) {
    return { ok: false, error: 'inject_failed', message: String(e && e.message ? e.message : e) };
  }

  const frames = (injection || []).map((r) => ({
    frameId: r.frameId,
    error: r.error ? (r.error.message || String(r.error)) : null,
    info: r.result || null
  }));

  return {
    ok: true,
    data: {
      tabId: tab.id,
      frameCount: frames.length,
      frames,
      title: tab.title || '',
      url: tab.url || ''
    }
  };
}

/** 按 tabId / match / url 定位目标标签页。 */
async function resolveTab(task) {
  const all = await chrome.tabs.query({});

  if (typeof task.tabId === 'number') {
    return all.find((t) => t.id === task.tabId) || null;
  }
  if (task.match) {
    // 优先命中当前激活的标签页，其次命中第一个匹配项
    const hit = all.filter((t) => (t.url || '').includes(task.match));
    return hit.find((t) => t.active) || hit[0] || null;
  }
  if (task.url) {
    const exact = all.find((t) => t.url === task.url);
    const prefix = all.find((t) => t.url && t.url.startsWith(String(task.url).split('?')[0]));
    return exact || prefix || null;
  }
  return null;
}

/**
 * 校验目标标签页可注入且站点已授权。
 * 浏览器安全策略要求授权必须来自用户手势，服务脚本无法弹授权框，
 * 因此这里只做检查并报告，由用户在扩展弹窗中完成授权。
 */
async function ensureInjectable(tab) {
  if (!tab || typeof tab.id !== 'number') {
    return { error: { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' } };
  }

  const url = tab.url || '';
  if (url.startsWith('edge://') || url.startsWith('chrome://') || url.startsWith('about:')) {
    return { error: { ok: false, error: 'restricted_scheme', url } };
  }

  let origin;
  try {
    origin = new URL(url).origin + '/*';
  } catch (e) {
    return { error: { ok: false, error: 'bad_url', url } };
  }

  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    return {
      error: {
        ok: false,
        error: 'permission_denied',
        origin,
        hint: `需要在扩展弹窗中为该站点授权后才能操作：${origin}`
      }
    };
  }

  return { origin };
}

/* ------------------------------------------------------------------ *
 * 标签页标记
 *
 * 两道标记同时使用，确保用户能明确看到哪些页面正被操作：
 *   1. 标签页徽标：扩展图标上的绿底字母，按标签页独立设置，切到该标签页即可见。
 *   2. 页面内浮动提示：显示最近一次操作，默认 15 秒后自动消失。
 * 标记会一直保留到显式清除，便于回溯本次会话操作过哪些页面。
 * ------------------------------------------------------------------ */
const BADGE_TEXT = 'A';
const BADGE_COLOR = '#1a7f37';
// 标题前缀，同时作为"该标签页被标记过"的可发现标志
const TITLE_PREFIX = '🤖 ';
// 按操作类型区分徽标底色，与页面内浮层强调色保持一致
const BADGE_COLORS = {
  read: '#1f6feb',
  links: '#1f6feb',
  click: '#1a7f37',
  type: '#9a6700',
  key: '#9a6700',
  navigate: '#8250df',
  mark: '#1a7f37'
};
const MARKS_KEY = 'abb-marked-tabs';
const markedTabs = new Set();

// 用 storage.local 而非 storage.session：session 在扩展重载时会清空，
// 而页面上的标记（标题前缀、图标角标）是留在页面里的，会变成清不掉的残留。
async function loadMarks() {
  try {
    const stored = await chrome.storage.local.get(MARKS_KEY);
    const ids = stored && stored[MARKS_KEY];
    if (Array.isArray(ids)) {
      ids.forEach((id) => markedTabs.add(id));
    }
  } catch (e) {
    // 存储不可用时退化为仅内存记录
  }
}

async function saveMarks() {
  try {
    await chrome.storage.local.set({ [MARKS_KEY]: Array.from(markedTabs) });
  } catch (e) {
    // 保存失败不影响当前会话内的标记行为
  }
}

/**
 * 收集所有被标记的标签页。
 *
 * 除了内存记录，还会按标题前缀扫描一遍：扩展重载后内存记录可能丢失，
 * 但页面上的标记仍在，只靠内存会留下永远清不掉的残留。
 */
async function collectMarkedTabs() {
  const ids = new Set(markedTabs);
  try {
    const all = await chrome.tabs.query({});
    for (const t of all) {
      if (typeof t.id !== 'number') { continue; }

      // 标题前缀还在 —— 明确的标记
      if (typeof t.title === 'string' && t.title.startsWith(TITLE_PREFIX)) {
        ids.add(t.id);
        continue;
      }

      // 标题前缀丢了但图标仍是我们的 data URL —— 同样是残留标记。
      // 页面自己改写了 title（SPA 常见）时会出现这种半边残留，只靠标题扫不到。
      if (typeof t.favIconUrl === 'string' && t.favIconUrl.startsWith('data:image/')) {
        ids.add(t.id);
      }
    }
  } catch (e) {
    // 查询失败时退回仅用内存记录
  }
  return Array.from(ids);
}

/** 给标签页打上徽标标记。 */
async function applyBadge(tabId, tip, kind) {
  try {
    await chrome.action.setBadgeText({ tabId, text: BADGE_TEXT });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: BADGE_COLORS[kind] || BADGE_COLOR
    });
    if (tip) {
      await chrome.action.setTitle({ tabId, title: `Agent Browser Bridge — ${tip}` });
    }
  } catch (e) {
    // 部分标签页（受限页面、已关闭）不允许设置徽标
  }
  markedTabs.add(tabId);
}

/** 清除标签页徽标标记。 */
async function removeBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'Agent Browser Bridge' });
  } catch (e) {
    // 标签页可能已关闭
  }
  await unmarkFavicon(tabId);
  markedTabs.delete(tabId);
}

/** 在页面内显示浮动提示。失败不影响主流程。 */
async function showIndicator(tabId, text, ttlMs, kind) {
  try {
    await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      func: indicatorInPage,
      args: [{ text, ttlMs: typeof ttlMs === 'number' ? ttlMs : 15000, kind }]
    }), MARK_INJECT_TIMEOUT_MS, 'showIndicator');
    return true;
  } catch (e) {
    return false;
  }
}

/** 在页面内清除浮动提示。 */
async function hideIndicator(tabId) {
  try {
    await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      func: indicatorInPage,
      args: [{ clear: true }]
    }), MARK_INJECT_TIMEOUT_MS, 'hideIndicator');
    return true;
  } catch (e) {
    return false;
  }
}

const ACTION_LABEL = {
  read: '读取',
  links: '枚举链接',
  click: '点击',
  type: '输入',
  key: '按键',
  navigate: '导航',
  tabs: '枚举标签页',
  mark: '标记',
  unmark: '清除标记'
};

/** 标记一个标签页，并显示最近操作。 */
async function markTab(tabId, action, detail) {
  const label = ACTION_LABEL[action] || action;
  const tip = detail ? `${label}：${detail}` : label;
  await applyBadge(tabId, tip, action);
  await markFavicon(tabId, BADGE_COLORS[action] || BADGE_COLOR);
  await showIndicator(tabId, `agent 正在${label}${detail ? '：' + detail : ''}`, undefined, action);
  await saveMarks();
}

/** 在标签栏的站点图标上叠加角标，让用户一眼看出该标签页正被操作。 */
async function markFavicon(tabId, accent, ttlMs) {
  try {
    const inj = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      func: tabMarkInPage,
      args: [{ accent, ttlMs }]
    }), MARK_INJECT_TIMEOUT_MS, 'markFavicon');
    const first = inj && inj[0];
    if (!first) { return { ok: false, error: 'no_injection_result' }; }
    if (first.error) {
      return { ok: false, error: String(first.error.message || first.error.value || first.error) };
    }
    return first.result || { ok: false, error: 'empty_result' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 移除标签栏角标，恢复站点原图标。 */
async function unmarkFavicon(tabId) {
  try {
    const inj = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      func: tabMarkInPage,
      args: [{ clear: true }]
    }), MARK_INJECT_TIMEOUT_MS, 'unmarkFavicon');
    const first = inj && inj[0];
    return first && first.result ? first.result : { ok: false, error: 'empty_result' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 手动标记/清除标记任务的入口。 */
async function markTask(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页' };
  }

  const guard = await ensureInjectable(tab);
  // 受限页面无法注入浮动提示，但徽标仍可用，因此这里只在完全不可用时才失败
  await applyBadge(tab.id, task.text || '已标记', 'mark');

  const favicon = guard.error
    ? { ok: false, error: guard.error.error }
    : await markFavicon(tab.id, BADGE_COLOR, task.ttlMs);

  if (!guard.error) {
    // ttl=0 表示常驻，直到显式清除
    await showIndicator(tab.id, task.text || 'agent 正在操作', 0, 'mark');
  }
  await saveMarks();

  return {
    ok: true,
    data: {
      tabId: tab.id,
      browser: BROWSER_NAME,
      title: tab.title || '',
      url: tab.url || '',
      badge: BADGE_TEXT,
      favicon,
      indicatorPlaced: !guard.error,
      markedCount: markedTabs.size
    }
  };
}

async function unmarkTask(task) {
  let targets = [];

  if (typeof task.tabId === 'number') {
    targets = [task.tabId];
  } else if (task.match || task.url) {
    const tab = await resolveTab(task);
    if (!tab) { return { ok: false, error: 'no_tab_matched' }; }
    targets = [tab.id];
  } else {
    // 未指定目标时清除全部。
    // 用 collectMarkedTabs 而非直接读内存：它同时按标题前缀发现残留标记，
    // 这样即使扩展重载过、内存记录丢了，也能把页面上的标记清干净。
    const all = await chrome.tabs.query({});
    const alive = new Set(all.map((t) => t.id));

    for (const id of Array.from(markedTabs)) {
      if (!alive.has(id)) { markedTabs.delete(id); }
    }

    targets = (await collectMarkedTabs()).filter((id) => alive.has(id));
  }

  // 并行清除：串行时每个冻结标签页都会累积一次注入超时，
  // 三个标签页就能把一次 unmark 拖到几十秒。并行后总耗时约等于单个最慢者。
  const results = await Promise.allSettled(
    targets.map(async (id) => {
      await removeBadge(id);
      const ok = await hideIndicator(id);
      return { id, indicatorCleared: ok };
    })
  );

  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  await saveMarks();

  return {
    ok: true,
    data: {
      cleared: targets,
      browser: BROWSER_NAME,
      markedCount: markedTabs.size,
      // 冻结/无响应的标签页无法注入，标记要等它被打开或刷新后才能清掉
      note: failed.length
        ? `${failed.length} 个标签页无响应，其标记需在浏览器中打开或刷新该标签页后再清除`
        : undefined
    }
  };
}

/**
 * 挑选正文所在框架的评分函数。
 *
 * 优先级：
 *   1. 指定 selector 且命中 —— 调用方明确指名，最高优先
 *   2. 可编辑框架 —— 编辑态下正文在 TinyMCE 的 iframe 里，主框架只剩工具栏按钮，
 *      必须优先取编辑器框架，否则会读到一堆按钮文字
 *   3. 其余按正文长度取最长
 */
function pickContentFrame(selector) {
  return (res) => {
    let score = res.charCount || 0;
    // 命中调用方指定的选择器
    if (selector && res.selectorMatched) { score += 1000000; }
    // 可编辑框架加权。用累加而非短路：像 body 这种选择器会在多个框架里都命中，
    // 此时必须让可编辑的那个框架胜出，否则会读到编辑器外的工具栏文字。
    if (res.frameEditable) { score += 500000; }
    return score;
  };
}

/** 在目标标签页中读取正文。 */
async function readTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const picked = await injectAndPick(
    tab.id,
    extractInPage,
    [task.selector || null, !!task.includeLinks, !!task.returnHtml],
    pickContentFrame(task.selector),
    typeof task.frameId === 'number' ? task.frameId : undefined
  );
  if (picked.error) { return { ...picked.error, url: tab.url }; }
  const data = picked.data;

  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      frameId: picked.frameId,
      frameCount: picked.frameCount,
      ...data
    }
  };
}

/**
 * 在页面里执行一段 JS（在页面主世界跑间接 eval），把结果整理成可序列化的结构。
 * 只保留能跨进程传递的值：DOM 节点转成 node/id/className/text/html，超长内容截断。
 */
async function evalInPage(code) {
  function normalize(v, depth) {
    const d = depth || 0;
    if (v === undefined || v === null) { return null; }
    const t = typeof v;
    if (t === 'string') { return v.length > 4000 ? v.slice(0, 4000) + '…[截断]' : v; }
    if (t === 'number' || t === 'boolean') { return v; }
    if (t === 'bigint') { return String(v); }
    if (t === 'function') { return '[function]'; }
    if (t === 'symbol') { return String(v); }
    if (d > 4) { return '[deep]'; }
    if (typeof Node !== 'undefined' && v instanceof Node) {
      return {
        node: v.nodeName,
        id: v.id || null,
        className: typeof v.className === 'string' ? v.className : null,
        text: (v.textContent || '').slice(0, 300),
        html: v.nodeType === 1 ? v.outerHTML.slice(0, 1000) : null
      };
    }
    if (Array.isArray(v)) { return v.slice(0, 200).map(function (x) { return normalize(x, d + 1); }); }
    if (typeof Map !== 'undefined' && v instanceof Map) { return normalize(Array.from(v.entries()), d + 1); }
    if (typeof Set !== 'undefined' && v instanceof Set) { return normalize(Array.from(v), d + 1); }
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= 200) { out.__truncated = true; break; }
      try { out[k] = normalize(v[k], d + 1); } catch (e) { out[k] = '[unserializable]'; }
    }
    return out;
  }

  let value;
  try {
    // 函数体语义：支持在代码里直接 return（函数体本身仍在全局作用域求值，能访问 document 等）
    value = new Function(code)();
  } catch (e) {
    if (e instanceof SyntaxError) {
      // 兼容直接写表达式的用法，例如 "document.title"
      try {
        value = (0, eval)(code);
      } catch (e2) {
        return { ok: false, evalError: String(e2 && e2.message ? e2.message : e2) };
      }
    } else {
      return { ok: false, evalError: String(e && e.message ? e.message : e) };
    }
  }

  // 代码没写 return 时（例如只写了一个表达式），按表达式取完成值
  if (value === undefined) {
    try { value = (0, eval)(code); } catch (e) { /* 忽略，保持 undefined */ }
  }

  // 允许代码返回 Promise（例如等接口返回后再取数据）
  if (value && typeof value.then === 'function') {
    try {
      value = await value;
    } catch (e) {
      return { ok: false, evalError: String(e && e.message ? e.message : e) };
    }
  }
  return { ok: true, value: normalize(value) };
}

/** 在目标标签页里执行一段 JS，返回可序列化结果（量 DOM、取计算样式用）。 */
async function evalTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }
  if (!task.code || typeof task.code !== 'string') {
    return {
      ok: false,
      error: 'missing_code',
      hint: '用法：eval --match "<URL子串>" --code "<JS>"；用 return 返回结果，例如 return document.title'
    };
  }

  // 注入主世界：能访问页面自身的全局对象；同时避开扩展隔离世界的 CSP 限制
  // （页面若自带严格 CSP 仍可能拦 eval，这种情况会返回 eval_error 并说明原因）
  const target = typeof task.frameId === 'number'
    ? { tabId: tab.id, frameIds: [task.frameId] }
    : { tabId: tab.id, allFrames: true };

  let injection;
  try {
    injection = await withTimeout(
      chrome.scripting.executeScript({ target, func: evalInPage, args: [task.code], world: 'MAIN' }),
      INJECT_TIMEOUT_MS
    );
  } catch (e) {
    return { ...tabUnresponsive(e, tab.id), url: tab.url };
  }

  const frames = (injection || []).map((r) => ({
    frameId: r.frameId,
    error: r.error ? (r.error.message || String(r.error)) : null,
    result: r.result || null
  }));
  if (frames.length === 0) {
    return { ok: false, error: 'no_injection_result', url: tab.url };
  }

  // 主框架优先；页面脚本抛错的结果排在最后
  const score = (f) => (f.error ? -1 : (f.result && f.result.evalError ? 0 : (f.frameId === 0 ? 100 : 1)));
  let best = frames[0];
  let bestScore = -Infinity;
  for (const f of frames) {
    const s = score(f);
    if (s > bestScore) { bestScore = s; best = f; }
  }

  if (best.error) {
    return { ok: false, error: 'page_script_error', message: best.error, url: tab.url, frameId: best.frameId };
  }
  const picked = { data: best.result, frameId: best.frameId, frameCount: frames.length };
  const data = picked.data;
  if (data && data.evalError) {
    return { ok: false, error: 'eval_error', message: data.evalError, url: tab.url, frameId: picked.frameId };
  }

  const value = data ? data.value : null;
  let json = '';
  try { json = JSON.stringify(value); } catch (e) { json = JSON.stringify(String(value)); }
  const truncated = json.length > EVAL_MAX_JSON;
  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      frameId: picked.frameId,
      frameCount: picked.frameCount,
      url: tab.url,
      truncated,
      value: truncated ? null : value,
      json: truncated ? json.slice(0, EVAL_MAX_JSON) : null
    }
  };
}

/** 截取目标标签页当前可见画面。扩展 API 只能截「当前激活」的标签页，不主动切标签。 */
async function screenshotTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const format = task.format === 'jpeg' ? 'jpeg' : 'png';

  // 首选方式走 CDP，需要 debugger 可选权限；未授予时下面会回退到 DOM 方案，
  // 因此这里只探测、不直接失败。
  const cdpPerm = await requireOptionalPermissions(['debugger']);
  const cdpAllowed = !cdpPerm;

  // 元素截图：先量出元素在页面坐标里的矩形
  let clip = null;
  if (task.selector) {
    clip = await elementRect(tab.id, task.selector, typeof task.frameId === 'number' ? task.frameId : 0);
    if (!clip) {
      return { ok: false, error: 'element_not_found', selector: task.selector, url: tab.url };
    }
  }

  // 首选 CDP：能截后台标签页、整页和指定元素（中途会短暂附加调试器）
  try {
    if (!cdpAllowed) {
      // 未授予 debugger 权限时直接走退避方案，不必先撞一次异常
      throw new Error('debugger 权限未授予，跳过 CDP');
    }
    const cdp = await captureByCdp(tab.id, format, clip, !!task.full || !!clip);
    return {
      ok: true,
      data: {
        tabId: tab.id,
        url: tab.url,
        width: cdp.width || tab.width || null,
        height: cdp.height || tab.height || null,
        format,
        via: 'cdp',
        selector: task.selector || null,
        fullPage: !!task.full,
        dataUrl: cdp.dataUrl
      }
    };
  } catch (e) {
    const message = String(e && e.message ? e.message : e);

    // 退避：CDP 不可用时改用扩展自带截屏，但它只能截当前可见标签页
    if (!tab.active) {
      // 区分"没授权"和"CDP 用不了"，否则提示会把人引向错误的方向
      if (!cdpAllowed) {
        return {
          ok: false,
          error: 'permission_not_granted',
          missing: ['debugger'],
          url: tab.url,
          hint: '后台标签页的截图需要 debugger 权限（CDP）。'
            + '请点击扩展图标，在弹窗中「授予高级权限」后重试；'
            + '或先把该标签页切到前台，用扩展自带的截屏退避方案。'
        };
      }
      return {
        ok: false,
        error: 'capture_failed',
        url: tab.url,
        message,
        hint: 'CDP 截屏失败且该标签页不是激活状态（扩展自带截屏只能截当前可见标签页）。'
          + '可先关掉该标签页的 DevTools，或让该页面在前台后重试。'
      };
    }
    try {
      const dataUrl = await withTimeout(
        chrome.tabs.captureVisibleTab(tab.windowId, { format }),
        15000
      );
      return {
        ok: true,
        data: {
          tabId: tab.id,
          url: tab.url,
          width: tab.width || null,
          height: tab.height || null,
          format,
          via: 'captureVisibleTab',
          selector: null,
          fullPage: false,
          note: clip ? '元素截图不支持退避方案，已返回可视区域整屏' : undefined,
          dataUrl
        }
      };
    } catch (e2) {
      return {
        ok: false,
        error: 'capture_failed',
        url: tab.url,
        message: String(e2 && e2.message ? e2.message : e2),
        cdpMessage: message
      };
    }
  }
}

/**
 * 读取目标标签页的登录态：cookies（含 httpOnly，走 chrome.cookies）+ localStorage / sessionStorage。
 *
 * 用途：默认复用浏览器里已经在用的登录态做操作，不必重新登录。
 * 只按需返回：--name 过滤 cookie 名，--key 过滤存储键，长值截断，避免把整站数据倒出来。
 */
/**
 * 检查可选权限是否已授予。
 *
 * debugger 与 cookies 属于可选权限（可选权限不会在安装时强制索取，
 * 由用户在扩展弹窗中按需授予），因此调用前必须先确认，否则 API 直接抛错。
 */
async function requireOptionalPermissions(names) {
  const needed = [];
  for (const n of names) {
    try {
      const has = await chrome.permissions.contains({ permissions: [n] });
      if (!has) { needed.push(n); }
    } catch (e) {
      needed.push(n);
    }
  }
  if (needed.length === 0) { return null; }

  return {
    ok: false,
    error: 'permission_not_granted',
    missing: needed,
    hint: `该操作需要额外权限（${needed.join('、')}）。请点击扩展图标，在弹窗中授予后再试。`
  };
}

async function sessionTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }

  // 读取 Cookie 需要 cookies 可选权限，未授予时直接给出可操作的提示
  const permErr = await requireOptionalPermissions(['cookies']);
  if (permErr) { return permErr; }

  const result = {
    tabId: tab.id,
    url: tab.url,
    cookies: null,
    storage: null
  };

  // cookies：按标签页 URL 取，带 httpOnly 的也能拿到
  try {
    const all = await withTimeout(
      chrome.cookies.getAll({ url: tab.url, name: task.name || undefined }),
      10000
    );
    result.cookies = (all || []).map((c) => ({
      name: c.name,
      value: truncate(c.value, SESSION_VALUE_MAX),
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      session: !!c.session,
      expirationDate: c.expirationDate || null
    }));
  } catch (e) {
    result.cookiesError = String(e && e.message ? e.message : e);
  }

  // 页面本地存储
  if (task.storage !== false) {
    const guard = await ensureInjectable(tab);
    if (guard.error) {
      result.storageError = guard.error.error || 'not_injectable';
    } else {
      const picked = await injectAndPick(
        tab.id,
        readStorageInPage,
        [task.local !== false, task.session !== false, task.key || null],
        (r, frameId) => (r ? (frameId === 0 ? 1 : 0) : -1)
      );
      if (picked.error) {
        result.storageError = picked.error.error || 'inject_failed';
      } else {
        result.storage = picked.data || null;
      }
    }
  }

  return { ok: true, data: result };
}

/** 页面侧：读取 localStorage / sessionStorage（可按 key 过滤，长值截断）。 */
function readStorageInPage(includeLocal, includeSession, key) {
  const MAX = 4000;

  function dump(store) {
    const out = {};
    if (key) {
      out[key] = store.getItem(key);
      return out;
    }
    const len = Math.min(store.length, 300);
    for (let i = 0; i < len; i++) {
      const k = store.key(i);
      out[k] = store.getItem(k);
    }
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'string' && out[k].length > MAX) {
        out[k] = out[k].slice(0, MAX) + '…[截断]';
      }
    }
    return out;
  }

  const result = {};
  if (includeLocal) {
    try { result.localStorage = dump(window.localStorage); } catch (e) { result.localStorageError = String(e); }
  }
  if (includeSession) {
    try { result.sessionStorage = dump(window.sessionStorage); } catch (e) { result.sessionStorageError = String(e); }
  }
  return result;
}

/**
 * 把本地文件塞进页面的 file input（走 CDP DOM.setFileInputFiles）。
 *
 * 扩展自身读不到任意路径的文件，只能让浏览器去读，因此必须走调试器；期间会短暂 attach。
 */
async function uploadTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }
  const files = Array.isArray(task.files) ? task.files.filter(Boolean) : [];
  if (files.length === 0) {
    return { ok: false, error: 'missing_files', hint: '用 --file <绝对路径> 指定要上传的文件，可重复多次' };
  }

  // 走 CDP 需要 debugger 可选权限
  const permErr = await requireOptionalPermissions(['debugger']);
  if (permErr) { return permErr; }

  const selector = task.selector || 'input[type=file]';
  const target = { tabId: tab.id };

  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    return {
      ok: false,
      error: 'cdp_attach_failed',
      message: String(e && e.message ? e.message : e),
      hint: '该标签页可能开着 DevTools（一个标签页同时只能有一个调试器），关掉 DevTools 再试。'
    };
  }

  try {
    const doc = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1 });
    const found = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector
    });
    if (!found || !found.nodeId) {
      return { ok: false, error: 'element_not_found', selector, url: tab.url };
    }
    await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', {
      files,
      nodeId: found.nodeId
    });
    return {
      ok: true,
      data: {
        tabId: tab.id,
        url: tab.url,
        selector,
        files: files.map((p) => String(p).split(/[\\/]/).pop())
      }
    };
  } catch (e) {
    return { ok: false, error: 'upload_failed', message: String(e && e.message ? e.message : e), url: tab.url };
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 用目标标签页的登录态下载文件：在页面里带 credentials 请求，再回传 base64。
 *
 * 这样下载的是「该登录用户能拿到的内容」，不需要在本地重新登录。
 */
async function downloadTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }
  if (!task.url) {
    return { ok: false, error: 'missing_url', hint: '用 --url <地址> 指定要下载的地址（同源地址会自动带上登录态）' };
  }
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const maxBytes = Number(task.maxBytes) > 0 ? Number(task.maxBytes) : DOWNLOAD_MAX_BYTES;
  const picked = await injectAndPick(
    tab.id,
    fetchInPage,
    [task.url, maxBytes, task.headers || null],
    (r, frameId) => (r ? (frameId === 0 ? 1 : 0) : -1)
  );
  if (picked.error) { return { ...picked.error, url: tab.url }; }

  const data = picked.data || {};
  if (data.error) {
    return { ok: false, error: data.error, bytes: data.bytes || null, url: task.url, tabId: tab.id };
  }
  return {
    ok: true,
    data: {
      tabId: tab.id,
      pageUrl: tab.url,
      url: task.url,
      filename: filenameFromDisposition(data.disposition) || filenameFromUrl(task.url),
      contentType: data.contentType || null,
      bytes: data.bytes,
      base64: data.base64
    }
  };
}

/** 页面侧：带 cookie 请求目标地址，返回 base64（超过上限直接报 too_large，避免把内存撑爆）。 */
function fetchInPage(url, maxBytes, headers) {
  return fetch(url, { credentials: 'include', redirect: 'follow', headers: headers || undefined })
    .then(function (res) {
      if (!res.ok) { return { error: 'http_' + res.status }; }
      return res.arrayBuffer().then(function (buf) {
        const bytes = new Uint8Array(buf);
        if (bytes.length > maxBytes) { return { error: 'too_large', bytes: bytes.length }; }
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return {
          base64: btoa(bin),
          bytes: bytes.length,
          contentType: res.headers.get('content-type'),
          disposition: res.headers.get('content-disposition')
        };
      });
    })
    .catch(function (e) { return { error: String(e && e.message ? e.message : e) }; });
}

/** 从 Content-Disposition 里取文件名（兼容 filename* 与 filename）。 */
function filenameFromDisposition(disposition) {
  if (!disposition) { return null; }
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star && star[1]) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch (e) { /* 忽略 */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain && plain[1] ? plain[1].trim() : null;
}

/** 从 URL 末段推一个文件名。 */
function filenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const name = path.split('/').filter(Boolean).pop();
    return name || 'download.bin';
  } catch (e) {
    return 'download.bin';
  }
}

/** 字符串截断，用于 session 返回的长值。 */
function truncate(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max) + '…[截断]' : s;
}

/**
 * 通过 CDP 截屏（支持后台标签页、整页、元素区域）。
 * 期间会短暂 attach 调试器，结束后立即 detach。
 */
async function captureByCdp(tabId, format, clip, beyondViewport) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const params = { format, captureBeyondViewport: !!beyondViewport };
    if (clip) {
      params.clip = clip;
    }
    const shot = await withTimeout(
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params),
      20000
    );
    if (!shot || !shot.data) {
      throw new Error('empty_screenshot');
    }
    // 顺带取一下页面实际尺寸，便于调用方判断
    let metrics = null;
    try {
      metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    } catch (e) { /* 忽略 */ }
    const content = metrics && metrics.cssContentSize ? metrics.cssContentSize : null;
    // 整页截图才有意义报内容尺寸；否则报视口尺寸，避免误导
    const showContentSize = !!beyondViewport;
    return {
      dataUrl: 'data:image/' + format + ';base64,' + shot.data,
      width: clip ? Math.round(clip.width) : (showContentSize && content ? Math.round(content.width) : null),
      height: clip ? Math.round(clip.height) : (showContentSize && content ? Math.round(content.height) : null)
    };
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) { /* 忽略 */ }
  }
}

/** 量出元素在页面坐标里的矩形（供 CDP clip 使用），找不到返回 null。 */
async function elementRect(tabId, selector, frameId) {
  try {
    const injection = await withTimeout(
      chrome.scripting.executeScript({
        target: typeof frameId === 'number' ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true },
        func: rectInPage,
        args: [selector]
      }),
      INJECT_TIMEOUT_MS
    );
    const hit = (injection || []).find((r) => r.result);
    return hit ? hit.result : null;
  } catch (e) {
    return null;
  }
}

/** 页面侧：返回元素相对页面左上角的矩形（含滚动偏移）。 */
function rectInPage(selector) {
  const el = document.querySelector(selector);
  if (!el) { return null; }
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) { return null; }
  return {
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    width: r.width,
    height: r.height,
    scale: 1
  };
}

/** 枚举目标标签页里的链接。 */
async function linksTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const picked = await injectAndPick(
    tab.id,
    linksInPage,
    [task.selector || null, task.text || null],
    pickContentFrame(task.selector),
    typeof task.frameId === 'number' ? task.frameId : undefined
  );
  if (picked.error) { return { ...picked.error, url: tab.url }; }
  const data = picked.data;

  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      title: tab.title || '',
      url: tab.url || '',
      links: data.links,
      usedSelector: data.usedSelector
    }
  };
}

/**
 * 在目标标签页中点击元素。
 * 默认只允许点击链接；点击其他元素必须显式开启 allowNonLink。
 * 点击后等待片刻，回报是否发生跳转以及新开了哪些标签页。
 */
async function clickTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const beforeTabs = await chrome.tabs.query({});
  const beforeIds = new Set(beforeTabs.map((t) => t.id));

  const picked = await injectAndPick(
    tab.id,
    clickInPage,
    [{
      selector: task.selector || null,
      text: task.text || null,
      href: task.href || null,
      index: typeof task.index === 'number' ? task.index : 0,
      allowNonLink: !!task.allowNonLink,
      dryRun: !!task.dryRun
    }],
    // 成功点到的框架优先，其次主框架
    (res) => (res.ok ? 1000 : 0) + (res.isMainFrame ? 10 : 0),
    typeof task.frameId === 'number' ? task.frameId : undefined
  );
  if (picked.error) { return { ...picked.error, url: tab.url }; }
  const data = picked.data;
  if (!data.ok) { return data; }

  // 试运行：直接回报判定结果，不等待跳转、不检查标签页变化
  if (data.dryRun) {
    return {
      ok: true,
      data: {
        tabId: tab.id,
        wasActive: !!tab.active,
        frameId: picked.frameId,
        dryRun: true,
        wouldClick: data.wouldClick,
        matched: data.matched,
        url: tab.url || ''
      }
    };
  }

  // 留出时间让页面完成跳转或打开新标签页
  await new Promise((r) => setTimeout(r, 800));

  const afterTabs = await chrome.tabs.query({});
  const openedTabs = afterTabs
    .filter((t) => !beforeIds.has(t.id))
    .map((t) => ({ id: t.id, url: t.url || '', title: t.title || '', active: !!t.active }));
  const self = afterTabs.find((t) => t.id === tab.id);

  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      frameId: picked.frameId,
      clicked: data.clicked,
      urlBefore: data.urlBefore,
      urlAfter: self ? (self.url || '') : null,
      navigated: !!(self && self.url && self.url !== data.urlBefore),
      openedTabs
    }
  };
}

/**
 * 等待标签页 URL 真正变成目标地址。
 *
 * chrome.tabs.update 返回时导航尚未提交，此刻读 tab.url 仍是旧地址。
 * 若不等待，调用方紧接着 read 会匹配到旧页面甚至报 no_tab_matched。
 */
async function waitForTabUrl(tabId, targetUrl, timeoutMs = 10000) {
  const base = String(targetUrl).split('#')[0];
  const deadline = Date.now() + timeoutMs;
  let last = '';

  for (;;) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) { return { url: null, tabGone: true }; }

    last = t.url || '';
    if (last === targetUrl || last.startsWith(base)) {
      return { url: last };
    }
    // 加载已完成但地址不同，通常是服务端重定向，按实际地址返回
    if (t.status === 'complete') {
      return { url: last, redirected: true };
    }
    if (Date.now() >= deadline) {
      return { url: last, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 导航到指定 URL。默认在后台新建标签页，不影响用户当前视图。 */
async function navigateTab(task) {
  const target = task.url;
  if (!target) { return { ok: false, error: 'missing_url' }; }
  if (!/^https?:/i.test(target)) {
    return { ok: false, error: 'unsupported_scheme', url: target, hint: '只支持 http/https' };
  }

  let origin;
  try {
    origin = new URL(target).origin + '/*';
  } catch (e) {
    return { ok: false, error: 'bad_url', url: target };
  }

  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    return {
      ok: false,
      error: 'permission_denied',
      origin,
      hint: `需要在扩展弹窗中为该站点授权：${origin}`
    };
  }

  const waitMs = typeof task.waitMs === 'number' ? task.waitMs : 10000;

  // 没有指定目标标签页，或显式要求新开时，在后台新建标签页
  const wantNewTab = task.newTab || (typeof task.tabId !== 'number' && !task.match);
  if (wantNewTab) {
    // 默认后台新建，不打断用户；显式要求 active 时才置于前台
    const created = await chrome.tabs.create({ url: target, active: !!task.active });
    const settled = await waitForTabUrl(created.id, target, waitMs);
    return {
      ok: true,
      data: {
        tabId: created.id,
        url: settled.url || target,
        requestedUrl: target,
        openedNewTab: true,
        wasActive: !!task.active,
        redirected: !!settled.redirected,
        waitTimedOut: !!settled.timedOut
      }
    };
  }

  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched' };
  }

  const wasActive = !!tab.active;
  const urlBefore = tab.url || '';

  // 已在目标地址时跳过导航，避免无谓刷新
  if (urlBefore === target) {
    return {
      ok: true,
      data: {
        tabId: tab.id, url: urlBefore, requestedUrl: target,
        openedNewTab: false, wasActive, navigated: false
      }
    };
  }

  await chrome.tabs.update(tab.id, { url: target });

  // 关键：等待地址真正变更后再返回，否则调用方紧接着匹配会落空
  const settled = await waitForTabUrl(tab.id, target, waitMs);

  return {
    ok: true,
    data: {
      tabId: tab.id,
      url: settled.url || target,
      requestedUrl: target,
      openedNewTab: false,
      wasActive,
      navigated: true,
      redirected: !!settled.redirected,
      waitTimedOut: !!settled.timedOut
    }
  };
}

/** 在目标标签页中输入文本。 */
async function typeTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const picked = await injectAndPick(
    tab.id,
    typeInPage,
    [{
      selector: task.selector || null,
      text: task.text || null,
      value: task.value == null ? '' : String(task.value),
      method: task.method === 'html' ? 'html' : 'text',
      clear: !!task.clear,
      allowNonInput: !!task.allowNonInput
    }],
    // 找到可编辑元素的框架优先（Confluence 编辑器在 iframe 内），其次主框架
    (res) => (res.ok ? 1000 : 0) + (res.isMainFrame ? 10 : 0),
    typeof task.frameId === 'number' ? task.frameId : undefined
  );
  if (picked.error) { return { ...picked.error, url: tab.url }; }
  const data = picked.data;
  if (!data.ok) { return data; }

  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      frameId: picked.frameId,
      title: tab.title || '',
      url: tab.url || '',
      ...data.typed
    }
  };
}

/** 在目标标签页中派发按键事件。 */
async function keyTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const picked = await injectAndPick(
    tab.id,
    keyInPage,
    [{
      key: task.key,
      selector: task.selector || null,
      ctrl: !!task.ctrl,
      shift: !!task.shift,
      alt: !!task.alt,
      meta: !!task.meta
    }],
    (res) => (res.ok ? 1000 : 0) + (res.isMainFrame ? 10 : 0),
    typeof task.frameId === 'number' ? task.frameId : undefined
  );
  if (picked.error) { return { ...picked.error, url: tab.url }; }
  const data = picked.data;
  if (!data.ok) { return data; }

  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      frameId: picked.frameId,
      url: tab.url || '',
      ...data.pressed
    }
  };
}

/** 执行任务本体，不含标记逻辑。 */
async function runAction(task) {
  switch (task.action) {
    case 'tabs':
      return await listTabs();
    case 'read':
      return await readTab(task);
    case 'eval':
      return await evalTab(task);
    case 'screenshot':
      return await screenshotTab(task);
    case 'session':
      return await sessionTab(task);
    case 'upload':
      return await uploadTab(task);
    case 'download':
      return await downloadTab(task);
    case 'links':
      return await linksTab(task);
    case 'frames':
      return await framesDiag(task);
    case 'wait':
      return await waitTab(task);
    case 'diag':
      return await diagAction();
    case 'activate':
      return await activateTab(task);
    case 'click':
      return await clickTab(task);
    case 'type':
      return await typeTab(task);
    case 'key':
      return await keyTab(task);
    case 'navigate':
      return await navigateTab(task);
    case 'mark':
      return await markTask(task);
    case 'unmark':
      return await unmarkTask(task);
    case 'close':
      return await closeTab(task);
    case 'reload':
      return reloadExtension();
    case 'ping':
      return { ok: true, pong: true, browser: BROWSER_NAME };
    default:
      return { ok: false, error: 'unknown_action', action: task.action };
  }
}

/** 除这些动作外，操作过的标签页都会自动打上标记。 */
const NO_MARK_ACTIONS = new Set(['tabs', 'unmark', 'ping', 'mark', 'close', 'reload']);

/**
 * 关闭标签页。
 * 必须显式指定 tabId，不支持按 match 批量关闭，避免误关用户正在看的页面。
 */
async function closeTab(task) {
  if (typeof task.tabId !== 'number') {
    return {
      ok: false,
      error: 'missing_tab_id',
      hint: '关闭标签页必须显式提供 tabId，以免误关其他页面'
    };
  }

  const tab = await chrome.tabs.get(task.tabId).catch(() => null);
  if (!tab) {
    return { ok: false, error: 'no_tab_matched', tabId: task.tabId };
  }

  await removeBadge(task.tabId);
  await saveMarks();

  try {
    await chrome.tabs.remove(task.tabId);
  } catch (e) {
    return { ok: false, error: 'close_failed', message: String(e && e.message ? e.message : e) };
  }

  return {
    ok: true,
    data: {
      tabId: task.tabId,
      browser: BROWSER_NAME,
      closedTitle: tab.title || '',
      closedUrl: tab.url || ''
    }
  };
}

/**
 * 重新加载扩展自身。
 *
 * 用途：开发时改了扩展代码，无需用户手动去 edge://extensions 点"重新加载"。
 * 先延时再重载，确保本次任务的结果能先回传给服务端，否则响应会丢失。
 * 重载后长轮询会自动重建（service worker 重新启动时调用 bootstrap）。
 */
function reloadExtension() {
  setTimeout(() => {
    try {
      chrome.runtime.reload();
    } catch (e) {
      // 重载失败时保持原状态，不影响后续任务
    }
  }, 1200);

  return {
    ok: true,
    data: {
      browser: BROWSER_NAME,
      reloading: true,
      delayMs: 1200,
      hint: '扩展将在约 1.2 秒后重新加载，之后自动重连'
    }
  };
}

async function handleTask(task) {
  try {
    // 目标浏览器的校验：服务端已按浏览器分队列，这里是第二道防线，
    // 确保即使路由出错，任务也不会被另一个浏览器执行。
    if (task.browser && task.browser !== BROWSER_NAME) {
      return {
        ok: false,
        error: 'browser_mismatch',
        expected: task.browser,
        actual: BROWSER_NAME
      };
    }

    const result = await runAction(task);

    // 操作成功后给目标标签页打标记，让用户能看到哪些页面被操作过
    if (result && result.ok && !NO_MARK_ACTIONS.has(task.action)) {
      const tabId = result.data && result.data.tabId;
      if (typeof tabId === 'number') {
        const detail = result.data.clicked && result.data.clicked.text
          ? result.data.clicked.text.slice(0, 40)
          : undefined;
        await markTab(tabId, task.action, detail);
      }
    }

    return result;
  } catch (e) {
    return { ok: false, error: 'handler_exception', message: String(e && e.message ? e.message : e) };
  }
}

/* ------------------------------------------------------------------ *
 * 长轮询主循环
 * ------------------------------------------------------------------ */
async function pollOnce() {
  const res = await fetch(`${BRIDGE_URL}/poll?browser=${encodeURIComponent(BROWSER_NAME)}`, {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5000)
  });

  if (res.status === 204) {
    return; // 正常超时，没有任务
  }
  if (!res.ok) {
    throw new Error(`poll HTTP ${res.status}`);
  }

  const task = await res.json();
  if (!task || typeof task.id === 'undefined') {
    return;
  }

  // 关键：不要把任务执行 await 在轮询循环里。
  // 一个耗时任务（例如遍历大量已关闭标签页的 unmark）会阻塞后续轮询，
  // 服务端 30 秒收不到轮询就会判定该浏览器掉线——表现为"卡住然后掉线"。
  // 因此异步执行，立刻回去接收下一个任务。
  handleTask(task)
    .then((result) => postResult(task.id, result))
    .catch((e) => postResult(task.id, {
      ok: false,
      error: 'handler_exception',
      message: String(e && e.message ? e.message : e)
    }));
}

/** 回传任务结果。 */
async function postResult(taskId, result) {
  // 让结果里带上来源浏览器，便于调用方确认实际读取的是哪一个
  if (result && typeof result === 'object') {
    result.browser = BROWSER_NAME;
    if (result.data && typeof result.data === 'object') {
      result.data.browser = BROWSER_NAME;
    }
  }

  try {
    await fetch(`${BRIDGE_URL}/result?browser=${encodeURIComponent(BROWSER_NAME)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, result }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    logError('postResult', e);
  }
}

async function pollLoop() {
  if (loopRunning) { return; }
  loopRunning = true;

  try {
    // 服务脚本可能被浏览器回收，这里用循环保证连接持续恢复。
    // 连续失败时逐步退避，避免桥接服务长时间不可用时空转耗电。
    let failures = 0;
    for (;;) {
      try {
        await pollOnce();
        failures = 0;
      } catch (e) {
        failures++;
        const backoff = Math.min(RETRY_DELAY_MS * Math.pow(1.6, Math.min(failures, 6)), 30000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  } finally {
    loopRunning = false;
  }
}

// 标签页关闭后清理它的标记记录，避免列表无限增长
chrome.tabs.onRemoved.addListener((tabId) => {
  if (markedTabs.delete(tabId)) {
    saveMarks();
  }
});

// 定时唤醒，防止 MV3 服务脚本被回收后不再自行恢复。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    pollLoop();
  }
});

const ERROR_LOG_KEY = 'abb-error-log';

/** 记录运行时错误，供 diag 动作读取，便于定位 service worker 异常。 */
function logError(where, err) {
  try {
    const msg = err && err.stack ? err.stack : String(err && err.message ? err.message : err);
    chrome.storage.session.get(ERROR_LOG_KEY).then((stored) => {
      const arr = (stored && stored[ERROR_LOG_KEY]) || [];
      arr.push({ where, msg: msg.slice(0, 500) });
      return chrome.storage.session.set({ [ERROR_LOG_KEY]: arr.slice(-25) });
    }).catch(() => {});
  } catch (e) {
    // 记录失败不影响主流程
  }
}

// 捕获未处理异常与未处理的 Promise 拒绝。
// MV3 的 service worker 不会把这类错误显示在任何界面上，
// 不主动记录就只能看到"扩展莫名掉线"。
try {
  self.addEventListener('error', (ev) => logError('error', ev.error || ev.message));
  self.addEventListener('unhandledrejection', (ev) => logError('unhandledrejection', ev.reason));
} catch (e) {
  // 非 service worker 环境
}

/**
 * 启动计数。MV3 的 service worker 会被浏览器回收，每次重新启动都会再跑一遍
 * 顶层代码。计数增长快说明 SW 频繁被回收，长轮询没能维持存活。
 */
function bumpBootCount() {
  try {
    chrome.storage.local.get('abb-boot').then((o) => {
      const s = (o && o['abb-boot']) || { count: 0, firstAt: Date.now() };
      s.count += 1;
      s.lastAt = Date.now();
      return chrome.storage.local.set({ 'abb-boot': s });
    }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

/**
 * 供扩展弹窗调用的本地操作。
 * 走消息而不是 HTTP，这样桥接服务没开时也能查看和清除标记。
 */
try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'abb-popup') { return undefined; }

    (async () => {
      try {
        if (msg.action === 'status') {
          sendResponse({
            ok: true,
            browser: BROWSER_NAME,
            version: chrome.runtime.getManifest().version,
            markedCount: markedTabs.size,
            markedTabs: Array.from(markedTabs)
          });
          return;
        }

        if (msg.action === 'clearMarks') {
          const r = await unmarkTask({});
          sendResponse({ ok: true, cleared: (r.data && r.data.cleared) || [] });
          return;
        }

        sendResponse({ ok: false, error: 'unknown_action' });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();

    return true; // 异步响应
  });
} catch (e) {
  logError('runtime.onMessage', e);
}

function bootstrap() {
  bumpBootCount();
  try {
    loadMarks();
  } catch (e) {
    logError('bootstrap.loadMarks', e);
  }
  pollLoop();
}

// 定时唤醒。个别浏览器对最小周期有限制，失败则退回 1 分钟。
try {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
} catch (e) {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  } catch (e2) {
    logError('alarms.create', e2);
  }
}

try {
  chrome.runtime.onStartup.addListener(bootstrap);
  chrome.runtime.onInstalled.addListener(bootstrap);
} catch (e) {
  logError('runtime.listeners', e);
}

bootstrap();
