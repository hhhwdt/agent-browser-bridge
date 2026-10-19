/**
 * Agent Browser Bridge —— 注入到页面里执行的函数。
 *
 * 这些函数的源码会被 chrome.scripting.executeScript 序列化后送进页面，因此
 * 每一个都必须自包含：不能引用本模块之外的东西（tools/check-inject-scope.js 会检查）。
 * 它们不能 import 任何东西——这正是这个文件单独存在的意义。
 */

'use strict';

/* ------------------------------------------------------------------ *
 * 页面内提取函数
 * 该函数会被序列化后注入目标标签页执行，因此不能引用外部作用域。
 * ------------------------------------------------------------------ */

export function extractInPage(selector, includeLinks, returnHtml) {
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

export function clickInPage(opts) {
  const wantedIndex = typeof opts.index === 'number' && opts.index >= 0 ? opts.index : 0;
  const allowNonLink = !!opts.allowNonLink;
  const isMainFrame = (function () { try { return window === window.top; } catch (e) { return false; } })();

  // 页面侧虚拟鼠标：agent 操作时在页面上可见地移动和按下。
  // 必须定义在注入函数内部（页面里不存在模块作用域），靠固定 ID 幂等复用元素。
  // 纯可视化：任何失败都不能影响动作本身，全部吞掉异常。
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

  // 只读探测：调用方会先在所有框架里探一遍，再只对命中的那个框架执行真实动作，
  // 避免同一段文字在多个框架里同时命中时被点多次。这里不产生任何副作用。
  if (opts.probe) {
    return { ok: true, probe: true, found: true, isMainFrame, matched: candidates.length };
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

    // 虚拟光标：让用户看到 agent 的"鼠标"移动到目标并按下。
    // cursor 至少包含一个动作类型，因此探测路径（probe/dryRun）不会走到这里。
    cursor.move(cx, cy);
    cursor.press();

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

export function linksInPage(selector, filterText) {
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
    // 供多框架注入时挑选结果：指定了选择器且走到这里，说明该框架命中了。
    // 少了这个字段，调用方的框架打分里那档"命中加权"永远不生效，多个框架都命中时
    // 只能退回第一个框架，iframe 内的链接就再也找不到。
    selectorMatched: !!selector,
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

/* ------------------------------------------------------------------ *
 * 页面内按键函数
 *
 * 注意：这里派发的是合成 KeyboardEvent，只会触发页面内的 JS 处理器，
 * 不会触发浏览器级快捷键（如 Ctrl+S、Ctrl+T），因此不会影响用户浏览器。
 * 但合成事件不会产生文本输入，插入文本请用 type。
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 页面内操作标记
 *
 * 在被操作的页面上显示一个不影响布局、不拦截点击的浮动提示，让用户能直观
 * 看到"这个页面正被 agent 操作"。挂在 documentElement 下（body 的兄弟节点），
 * 因此不会被正文提取（读取 #main-content 或 body）收进结果里。
 * ------------------------------------------------------------------ */

export function indicatorInPage(opts) {
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

export async function waitInPage(opts) {
  const isMainFrame = (function () {
    try { return window === window.top; } catch (e) { return false; }
  })();

  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10000;
  const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 200;
  const state = opts.state === 'disappear' ? 'disappear' : 'appear';
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();

  // idle 条件：记录上次资源数量变化的时间
  let lastResourceCount = -1;
  let lastResourceChange = Date.now();

  const satisfied = () => {
    // selector 条件
    if (opts.selector) {
      const el = document.querySelector(opts.selector);
      if (!el) { return false; }
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      // 只在要求"出现"时校验可见性，避免隐藏元素永远等不到
      if (state === 'appear' && r && (r.width <= 0 || r.height <= 0)) { return false; }
    }
    // text 条件
    if (opts.text) {
      if (!document.body || !(document.body.innerText || '').includes(opts.text)) { return false; }
    }
    // url 条件
    if (opts.url) {
      if (!location.href.includes(opts.url)) { return false; }
    }
    // count 条件（需要 selector）
    if (opts.count) {
      if (!opts.selector) { return false; }
      if (document.querySelectorAll(opts.selector).length < opts.count) { return false; }
    }
    // idle 条件：资源数量在 idleMs 内没有变化
    if (opts.idleMs) {
      const entries = performance.getEntriesByType('resource').length;
      if (entries !== lastResourceCount) {
        lastResourceCount = entries;
        lastResourceChange = Date.now();
      }
      if (Date.now() - lastResourceChange < opts.idleMs) { return false; }
    }
    return true;
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

export function tabMarkInPage(opts) {
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
 * 页面内媒体枚举
 *
 * 把页面里能找到的媒体地址一次性列出来，供调用方挑选后再下载。
 * 覆盖三类来源：媒体元素、页面数据（脚本/JSON）、已是直链的资源。
 * ------------------------------------------------------------------ */

export function mediaInPage(opts) {
  const MIN_IMG = (opts && opts.minImageSize) || 200;   // 过滤图标等小图
  const MAX_SCAN = (opts && opts.maxScanChars) || 3000000;

  const videos = [];
  const audios = [];
  const images = [];
  const streams = [];

  const abs = (u) => {
    if (!u) { return null; }
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  };

  // ---- 媒体元素 ----
  document.querySelectorAll('video').forEach((v) => {
    const src = abs(v.currentSrc || v.src);
    if (src && !src.startsWith('blob:')) {
      videos.push({
        src,
        w: v.videoWidth || null,
        h: v.videoHeight || null,
        duration: isFinite(v.duration) ? Math.round(v.duration) : null,
        poster: abs(v.poster)
      });
    } else if (src && src.startsWith('blob:')) {
      videos.push({ src, blob: true, note: 'MSE/blob 源，需从页面数据里找真实清单' });
    }
    v.querySelectorAll('source').forEach((s) => {
      const u = abs(s.src);
      if (u && !u.startsWith('blob:')) {
        videos.push({ src: u, from: 'source', type: s.type || null });
      }
    });
  });

  document.querySelectorAll('audio').forEach((a) => {
    const src = abs(a.currentSrc || a.src);
    if (src && !src.startsWith('blob:')) { audios.push({ src }); }
  });

  // ---- 图片（按实际渲染尺寸过滤，避免把 UI 图标当内容）----
  document.querySelectorAll('img').forEach((i) => {
    const src = abs(i.currentSrc || i.src);
    if (!src || src.startsWith('data:')) { return; }
    if ((i.naturalWidth || 0) >= MIN_IMG && (i.naturalHeight || 0) >= MIN_IMG) {
      images.push({ src, w: i.naturalWidth, h: i.naturalHeight, alt: (i.alt || '').slice(0, 80) });
    }
  });

  // ---- 页面数据里的播放清单（HLS/DASH 等）----
  // 用字符串化 + 正则，避免对大对象做深度递归（实测会超时）。
  let text = '';
  document.querySelectorAll('script').forEach((s) => {
    if (text.length >= MAX_SCAN) { return; }
    const t = s.textContent || '';
    if (/\.(m3u8|mpd)/i.test(t) || /playAddr|play_url|video_url|backupUrl/i.test(t)) {
      text += t.slice(0, 500000);
    }
  });
  if (document.body && text.length < MAX_SCAN) {
    const pageData = document.getElementById('RENDER_DATA');
    if (pageData && pageData.textContent) { text += pageData.textContent.slice(0, 1500000); }
  }

  if (text) {
    const re = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm|m4s|flv)(?:[?#][^\s"'<>\\]*)?/gi;
    const seen = new Set();
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard < 50000) {
      const u = m[0].replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
      const key = u.slice(0, 200);
      if (!seen.has(key)) { seen.add(key); streams.push({ src: u, from: 'page-data' }); }
      guard++;
    }
  }

  // ---- 去重合并 ----
  const dedupe = (arr, keyName) => {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      const k = item[keyName].slice(0, 300);
      if (seen.has(k)) { continue; }
      seen.add(k);
      out.push(item);
    }
    return out;
  };

  return {
    url: location.href,
    title: document.title,
    counts: { videos: videos.length, streams: streams.length, images: images.length, audios: audios.length },
    videos: dedupe(videos, 'src').slice(0, 30),
    streams: dedupe(streams, 'src').slice(0, 40),
    images: dedupe(images, 'src').slice(0, 60),
    audios: dedupe(audios, 'src').slice(0, 20)
  };
}

/* ------------------------------------------------------------------ *
 * 页面内框架诊断
 *
 * 用于排查"编辑器藏在哪个框架、以何种方式可编辑"这类问题。
 * 只读取框架自身的状态，不改动页面。
 * ------------------------------------------------------------------ */

export function diagInPage() {
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

/**
 * 在页面里执行一段 JS（在页面主世界跑间接 eval），把结果整理成可序列化的结构。
 * 只保留能跨进程传递的值：DOM 节点转成 node/id/className/text/html，超长内容截断。
 */

export async function evalInPage(code) {
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

  // 执行风格必须在运行前定下来，保证代码最多只跑一次。
  // 不能"先跑一次、拿不到值再跑一次"：那样任何没写 return 的语句
  // （例如 "document.querySelector('#x').click()"）都会执行两遍。
  //
  // 判定方式：整段能否当作一个表达式。
  //   能 —— 间接 eval，取语句完成值，支持 "document.title" 这种写法；
  //   不能 —— 按函数体执行，支持代码里直接 return。
  const trimmed = code.replace(/[\s;]+$/, '');
  const isExpression = (function () {
    try { new Function('return (' + trimmed + '\n)'); return true; } catch (e) { return false; }
  })();

  let value;
  try {
    value = isExpression ? (0, eval)(trimmed) : new Function(code)();
  } catch (e) {
    if (!(e instanceof SyntaxError)) {
      return { ok: false, evalError: String(e && e.message ? e.message : e) };
    }
    // 语法错误说明代码一行都没执行过，换另一种风格重试不会产生重复副作用
    try {
      value = isExpression ? new Function(code)() : (0, eval)(trimmed);
    } catch (e2) {
      return { ok: false, evalError: String(e2 && e2.message ? e2.message : e2) };
    }
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

/** 页面侧：读取 localStorage / sessionStorage（可按 key 过滤，长值截断）。 */

export function readStorageInPage(includeLocal, includeSession, key) {
  const MAX = 4000;

  function dump(store) {
    const out = {};
    if (key) {
      out[key] = store.getItem(key);
    } else {
      const len = Math.min(store.length, 300);
      for (let i = 0; i < len; i++) {
        const k = store.key(i);
        out[k] = store.getItem(k);
      }
    }
    // 截断必须对单 key 也生效：指定 key 取到的往往正是一整块缓存或 token，
    // 不截断就会把几百 KB 原样塞进命令行输出与 /result 回传。
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

/** 页面侧：带 cookie 请求目标地址，返回 base64（超过上限直接报 too_large，避免把内存撑爆）。 */

export function fetchInPage(url, maxBytes, headers) {
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

/** 页面侧：返回元素相对页面左上角的矩形（含滚动偏移）。 */

export function rectInPage(selector) {
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

/**
 * 页面侧：把 HTML 元素转成 Markdown。
 * 自包含：标题、段落、列表（一层嵌套）、链接、图片、行内代码、代码块、引用、表格。
 */
export function markdownInPage(el) {
  if (!el) { return { ok: false, error: 'element_not_found' }; }

  const inline = (node) => {
    if (node.nodeType === 3) { return node.textContent; }
    if (node.nodeType !== 1) { return ''; }
    const tag = node.tagName.toLowerCase();
    if (tag === 'code') { return '`' + node.textContent + '`'; }
    if (tag === 'strong' || tag === 'b') { return '**' + Array.from(node.childNodes).map(inline).join('') + '**'; }
    if (tag === 'em' || tag === 'i') { return '*' + Array.from(node.childNodes).map(inline).join('') + '*'; }
    if (tag === 'a') {
      const text = Array.from(node.childNodes).map(inline).join('');
      const href = node.getAttribute('href') || '';
      return '[' + text + '](' + href + ')';
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      return '![' + alt + '](' + src + ')';
    }
    if (tag === 'br') { return '\n'; }
    return Array.from(node.childNodes).map(inline).join('');
  };

  const blocks = (node, depth) => {
    const lines = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.trim();
        if (text) { lines.push(text); }
        continue;
      }
      if (child.nodeType !== 1) { continue; }
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        lines.push('#'.repeat(level) + ' ' + inline(child).trim());
      } else if (tag === 'p') {
        lines.push(inline(child).trim());
      } else if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(child.children).filter((li) => li.tagName.toLowerCase() === 'li');
        items.forEach((li, i) => {
          const marker = tag === 'ol' ? (i + 1) + '.' : '-';
          lines.push('  '.repeat(depth) + marker + ' ' + inline(li).trim());
        });
      } else if (tag === 'blockquote') {
        const inner = blocks(child, depth).join('\n');
        lines.push(inner.split('\n').map((l) => '> ' + l).join('\n'));
      } else if (tag === 'pre') {
        lines.push('```');
        lines.push(child.textContent);
        lines.push('```');
      } else if (tag === 'table') {
        const rows = Array.from(child.querySelectorAll('tr'));
        rows.forEach((row, ri) => {
          const cells = Array.from(row.querySelectorAll('th,td')).map((c) => inline(c).trim());
          lines.push('| ' + cells.join(' | ') + ' |');
          if (ri === 0) { lines.push('| ' + cells.map(() => '---').join(' | ') + ' |'); }
        });
      } else {
        const text = inline(child).trim();
        if (text) { lines.push(text); }
      }
    }
    return lines;
  };

  const markdown = blocks(el, 0).join('\n\n').trim();
  return { ok: true, markdown, charCount: markdown.length };
}

/* 供其他模块使用 */

