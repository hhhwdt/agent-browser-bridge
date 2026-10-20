/**
 * Agent Browser Bridge —— 页面内执行类注入函数：条件等待、JS 求值、读取站点存储。
 *
 * 本文件只放注入函数：Chrome 会把这些函数序列化后送进页面执行，
 * 因此每个函数都必须自包含——不能引用模块里的任何东西。这条规则由
 * tools/check-inject-scope.js 静态把关。
 */

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
