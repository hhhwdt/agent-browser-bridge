/**
 * Agent Browser Bridge —— 页面内点击注入函数。
 *
 * 本文件只放注入函数：Chrome 会把这些函数序列化后送进页面执行，
 * 因此每个函数都必须自包含——不能引用模块里的任何东西。这条规则由
 * tools/check-inject-scope.js 静态把关。
 */

export async function clickInPage(opts) {
  const wantedIndex = typeof opts.index === 'number' && opts.index >= 0 ? opts.index : 0;
  const allowNonLink = !!opts.allowNonLink;
  const isMainFrame = (function () { try { return window === window.top; } catch (e) { return false; } })();

  // 页面侧虚拟鼠标：agent 操作时在页面上可见地移动和按下。
  // 必须定义在注入函数内部（页面里不存在模块作用域），靠固定 ID 幂等复用元素。
  // 纯可视化：任何失败都不能影响动作本身，全部吞掉异常。
  const cursor = (function () {
    const ensureCursor = () => {
      let el = document.getElementById('__abb_virtual_cursor__');
      if (el && el.dataset.abbCursorVer !== '3') { el.remove(); el = null; } /* 扩展更新后旧元素按版本号重建 */
      if (!el) {
        el = document.createElement('div');
        el.id = '__abb_virtual_cursor__';
        // popover 让光标进 top layer：<dialog>、popover、全屏元素会盖住任何 z-index，
        // 只有 top layer 压得住。不支持的浏览器忽略这个属性，退回普通 fixed。
        try { if (typeof el.showPopover === 'function') { el.setAttribute('popover', 'manual'); } } catch (e) { /* 忽略 */ }
        el.style.cssText = 'position:fixed;left:0;top:0;margin:0;padding:0;border:0;background:transparent;'
          + 'inset:auto;overflow:visible;pointer-events:none;z-index:2147483647;'
          + 'width:32px;height:32px;transition:left .18s ease-out,top .18s ease-out,transform .08s ease-in;'
          + 'filter:drop-shadow(1px 2px 2px rgba(0,0,0,.35));';
        el.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32"><path d="M5 3l14 9-6.5 1.5L9 20z" '
          + 'fill="#fff" stroke="#f85149" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        document.documentElement.appendChild(el);
        el.dataset.abbCursorVer = '3';
      }
      return el;
    };
    const guard = (fn) => { try { fn(); } catch (e) { /* 可视化失败不影响动作 */ } };
    return {
      /** 目标不在视野里就先滚到中间：箭头必须出现在用户看得见的地方。 */
      reveal(target) {
        guard(() => {
          const r = target.getBoundingClientRect();
          const vw = window.innerWidth || 0;
          const vh = window.innerHeight || 0;
          const inside = r && r.width > 0 && r.height > 0
            && r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
          if (!inside) { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); }
        });
        // 元素可能在 iframe 里，而且 iframe 本身滚出了父页面：把每一层 iframe 也滚进视野。
        // frameElement 只有同源才拿得到；跨域会抛 SecurityError，那种情况下元素已经
        // 滚到 iframe 中央，只要 iframe 在屏幕上箭头就可见。
        guard(() => {
          let win = window;
          for (let depth = 0; depth < 8; depth++) {
            const frameEl = win.frameElement;
            if (!frameEl) { break; }
            frameEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
            win = win.parent;
            if (!win || win === win.parent) { break; }
          }
        });
      },
      move(x, y) {
        guard(() => {
          const el = ensureCursor();
          if (el.hasAttribute('popover')) {
            try {
              if (!el.matches(':popover-open')) { el.showPopover(); }
            } catch (e) {
              // 打开失败就去掉属性，否则 [popover] 未打开会被 UA 样式 display:none 隐藏
              try { el.removeAttribute('popover'); } catch (e2) { /* 忽略 */ }
            }
          }
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
  const simulateClick = async (el) => {
    // 先把目标滚进视野，箭头才看得见；已经可见时不动用户的滚动位置
    cursor.reveal(el);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // 虚拟光标：让用户看到 agent 的"鼠标"移动到目标并按下。
    // cursor 至少包含一个动作类型，因此探测路径（probe/dryRun）不会走到这里。
    cursor.move(cx, cy);
    cursor.press();

    // 可见的标签页里稍等一下再派发事件，让人看清箭头移过去、按下去。
    // 链接/表单提交会立刻跳转，旧页面连同箭头一起被替换——这一等是唯一能
    // "看见"这次点击的机会。后台标签页没人看，不付这份时间。
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && isLink) {
      await new Promise((r) => setTimeout(r, 180));
      try {
        const after = el.getBoundingClientRect();
        if (after && (after.left !== rect.left || after.top !== rect.top)) {
          cursor.move(after.left + after.width / 2, after.top + after.height / 2);
        }
      } catch (e) { /* 元素可能已在动画中消失 */ }
    }

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
    await simulateClick(clickTarget);
  } catch (e) {
    return { ok: false, error: 'click_failed', message: String(e && e.message ? e.message : e), info };
  }

  // urlAfter 让调用方立刻知道是否已经跳转（同步导航不需要再等）
  return { ok: true, clicked: info, urlBefore: location.href, urlAfter: location.href, isMainFrame };
}
