/**
 * Agent Browser Bridge —— 标记类注入函数：页面右下角浮动提示与标签页标记角标。
 *
 * 本文件只放注入函数：Chrome 会把这些函数序列化后送进页面执行，
 * 因此每个函数都必须自包含——不能引用模块里的任何东西。这条规则由
 * tools/check-inject-scope.js 静态把关。
 */

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
