/**
 * Agent Browser Bridge —— 动作实现：一个动作一个函数，按桥接的 action 名对应。
 *
 * 加一个新动作时，这个文件通常只改一处——新的实现函数加进 runAction 的分派表即可
 * （分派在 background.js，工具的暴露在 mcp.js，命令行的包装在 read.js）。
 */

'use strict';

import { clickInPage, diagInPage, evalInPage, extractInPage, fetchInPage, keyInPage, linksInPage, mediaInPage, readStorageInPage, rectInPage, typeInPage, waitInPage } from './injected.js';
import { BROWSER_NAME } from './config.js';
import { INJECT_TIMEOUT_MS, ensureInjectable, injectAndPick, injectInBestFrame, resolveTab, tabUnresponsive, withTimeout } from './guards.js';

/* ------------------------------------------------------------------ *
 * 任务处理
 * ------------------------------------------------------------------ */
/** 列出所有已打开标签页（只读元信息，不读取页面内容）。 */

export async function listTabs() {
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

/** session 动作里单个 cookie 值的截断长度。 */

const SESSION_VALUE_MAX = 2000;

/** download 动作的默认大小上限（字节），超过直接报 too_large。 */

const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** eval 动作返回值的 JSON 上限，超过则截断并置 truncated=true。 */

const EVAL_MAX_JSON = 200 * 1024;

/** 等待页面条件成立（元素出现/消失、文字出现）。 */

export async function waitTab(task) {
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

export async function activateTab(task) {
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

/** 枚举标签页里的媒体候选，供调用方挑选后再下载。 */

export async function mediaTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const picked = await injectAndPick(
    tab.id,
    mediaInPage,
    [{ minImageSize: task.minImageSize, maxScanChars: task.maxScanChars }],
    // 媒体最多的框架优先，主框架优先
    (res) => {
      const c = res.counts || {};
      return (c.videos || 0) * 100 + (c.streams || 0) * 10 + (c.images || 0) + (res.isMainFrame ? 1 : 0);
    },
    typeof task.frameId === 'number' ? task.frameId : undefined
  );

  if (picked.error) { return { ...picked.error, url: tab.url }; }
  const data = picked.data || {};

  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      frameId: picked.frameId,
      browser: BROWSER_NAME,
      ...data
    }
  };
}

/** 诊断标签页内所有框架的状态，返回全部框架结果（不做挑选）。 */

export async function framesDiag(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  let injection;
  try {
    // 与其他注入一致地加超时：标签页渲染进程无响应时 executeScript 永不返回
    injection = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: diagInPage
    }), INJECT_TIMEOUT_MS, 'frames');
  } catch (e) {
    return tabUnresponsive(e, tab.id);
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

export async function readTab(task) {
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

/** 在目标标签页里执行一段 JS，返回可序列化结果（量 DOM、取计算样式用）。 */

export async function evalTab(task) {
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
  //
  // 只注入一个框架。eval 的代码可能带副作用（点按钮、提交表单），allFrames 会让它
  // 在每个框架里各跑一次，而回报的只是其中一份结果——副作用收不回来。与 click/type/key
  // 同一条规矩：副作用只能发生一次。默认主框架，要动 iframe 里的东西就显式给 frameId。
  const evalFrameId = typeof task.frameId === 'number' ? task.frameId : 0;
  const target = { tabId: tab.id, frameIds: [evalFrameId] };

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

  // 只在主框架里执行时，失败要说明"可以换框架再试"，否则调用方会以为页面上没有这个东西
  const frameHint = typeof task.frameId === 'number'
    ? undefined
    : '代码只在页面主框架里执行。若目标在 iframe 内，用 frames 查出 frameId 后用 --frameId 指定。';

  if (best.error) {
    return {
      ok: false,
      error: 'page_script_error',
      message: best.error,
      url: tab.url,
      frameId: best.frameId,
      hint: frameHint
    };
  }
  const picked = { data: best.result, frameId: best.frameId, frameCount: frames.length };
  const data = picked.data;
  if (data && data.evalError) {
    return {
      ok: false,
      error: 'eval_error',
      message: data.evalError,
      url: tab.url,
      frameId: picked.frameId,
      hint: frameHint
    };
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

export async function screenshotTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const format = task.format === 'jpeg' ? 'jpeg' : 'png';

  // 元素截图：先量出元素在页面坐标里的矩形。
  // 主框架直接注入量；指定了子框架就交给 CDP——注入量到的坐标是那个框架自己的
  // 坐标系，直接当 clip 用会截到页面别的区域。
  let clip = null;
  if (task.selector) {
    const frameId = typeof task.frameId === 'number' ? task.frameId : 0;
    clip = frameId === 0
      ? await elementRectInMainFrame(tab.id, task.selector)
      : await elementRectByCdp(tab.id, task.selector, frameId);
    if (!clip) {
      return {
        ok: false,
        error: 'element_not_found',
        selector: task.selector,
        frameId,
        url: tab.url,
        hint: frameId === 0
          ? '元素不在主框架里。用 frames 动作查出它所在框架的 frameId，再用 --frameId 指定。'
          : '该框架里没有命中这个选择器，或框架内容读不到（跨进程 iframe）。'
      };
    }
  }

  // 首选 CDP：能截后台标签页、整页和指定元素（中途会短暂附加调试器）
  try {
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
 * 只有 cookies 是可选权限（安装时不索取，由用户在扩展弹窗中按需授予）。
 * debugger 不是可选的 —— Chrome 明确禁止其出现在 optional_permissions 中，
 * 因此它只能作为必需权限，无需也无法在运行时申请。
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

export async function sessionTab(task) {
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

/**
 * 把本地文件塞进页面的 file input（走 CDP DOM.setFileInputFiles）。
 *
 * 扩展自身读不到任意路径的文件，只能让浏览器去读，因此必须走调试器；期间会短暂 attach。
 */

export async function uploadTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }
  const files = Array.isArray(task.files) ? task.files.filter(Boolean) : [];
  if (files.length === 0) {
    return { ok: false, error: 'missing_files', hint: '用 --file <绝对路径> 指定要上传的文件，可重复多次' };
  }

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
 * 用浏览器自己的下载栈把 URL 落盘。
 *
 * 与 downloadTab 的本质区别：
 *   - 这是浏览器级下载，不是页面内的 fetch，因此**不受 CORS 限制**，
 *     也不受 downloadTab 那个 20MB 上限约束；
 *   - 字节直接写盘，不经过桥接服务回传，因此大文件（视频）也可行；
 *   - 文件落在浏览器下载目录，filename 只能指定其下的相对路径。
 *
 * 不支持 blob: —— 那是页面内存里的对象引用，不是可下载的网络地址。
 */
/**
 * 保存「有防盗链且不发 CORS 头」的媒体。
 *
 * save 走浏览器下载栈，不带 Referer，会被防盗链 403；download 在页面里 fetch
 * 能带上 Referer，但跨域读取被 CORS 拦。这里把两者拼起来：
 *   1. 用 CDP 的 Fetch 域在**响应阶段**拦截目标 CDN 的响应，
 *      给它补上 Access-Control-Allow-Origin，让页面能合法读到字节；
 *   2. 页面内 fetch（自动带正确的 Referer）拿到 blob，
 *      用 blob URL + <a download> 触发浏览器下载，字节不经过桥接服务；
 *   3. 全程只在目标 origin 上拦截，其他请求原样放行，避免卡住页面。
 *
 * 代价：期间会短暂附加调试器（浏览器顶部会出现提示条），且与 DevTools 互斥。
 */

export async function grabTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页' };
  }
  if (!task.url) { return { ok: false, error: 'missing_url', hint: '用 --url 指定媒体地址' }; }

  let pattern;
  try { pattern = new URL(task.url).origin + '/*'; }
  catch (e) { return { ok: false, error: 'bad_url', url: task.url }; }

  const target = { tabId: tab.id };
  const targetKey = String(task.url).slice(0, 120);
  const paused = [];
  let attached = false;
  let downloadId = null;

  /** 只拦截目标响应，其余一律放行，否则页面会被 Fetch 域卡住。 */
  const onEvent = (source, method, params) => {
    if (!source || source.tabId !== tab.id || method !== 'Fetch.requestPaused') { return; }
    const p = params || {};
    const url = (p.request && p.request.url) || '';
    const isTarget = url.includes(targetKey) || url.slice(0, 120) === targetKey;

    if (isTarget && p.responseStatusCode) {
      const headers = (p.responseHeaders || [])
        .filter((h) => h.name.toLowerCase() !== 'access-control-allow-origin');
      headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      paused.push({ url: url.slice(0, 90), status: p.responseStatusCode });

      chrome.debugger.sendCommand(target, 'Fetch.continueResponse', {
        requestId: p.requestId,
        responseHeaders: headers
      }).catch(() => {
        chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      });
      return;
    }

    chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  };

  // 页面触发下载后，由这里拿到 downloadId，才能等到它真正落盘
  const onCreated = (item) => {
    if (downloadId === null && item && typeof item.id === 'number') { downloadId = item.id; }
  };

  // 页面侧用 <a download> 触发下载，文件名只能是纯名字（不能带路径），
  // 因此这里不加子目录；落点由浏览器下载目录决定，与 save 相同。
  const filename = task.filename
    ? String(task.filename).split(/[\\/]/).pop()
    : filenameFromUrl(task.url);

  try {
    chrome.downloads.onCreated.addListener(onCreated);
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    chrome.debugger.onEvent.addListener(onEvent);
    await chrome.debugger.sendCommand(target, 'Fetch.enable', {
      patterns: [{ urlPattern: pattern, requestStage: 'Response' }]
    });

    const inj = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (url, name) => {
        try {
          const res = await fetch(url, { credentials: 'omit', mode: 'cors' });
          if (!res.ok) { return { ok: false, status: res.status }; }
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          // 交给扩展用 chrome.downloads 接管，这样能指定子目录与重名策略；
          // 成功后由扩展通知页面回收 blob URL。
          return { ok: true, bytes: blob.size, type: blob.type || null, objectUrl };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      },
      args: [task.url, filename]
    }), task.timeoutMs || 180000);

    const fetched = inj && inj[0] ? inj[0].result : null;

    if (!fetched || !fetched.ok) {
      return {
        ok: false,
        error: 'grab_fetch_failed',
        url: task.url,
        status: fetched && fetched.status,
        message: fetched && fetched.error,
        cdpPaused: paused,
        hint: '页面内取流失败。注意 grab 与 DevTools 互斥（一个标签页同时只能有一个调试器）。'
      };
    }

    // 用扩展的下载栈接管页面里生成的 blob URL，从而能指定统一子目录
    if (fetched.objectUrl) {
      try {
        downloadId = await chrome.downloads.download({
          url: fetched.objectUrl,
          filename: withMediaSubdir(task.filename || filenameFromUrl(task.url)),
          conflictAction: task.overwrite ? 'overwrite' : 'uniquify'
        });
      } catch (e) {
        // 跨上下文 blob URL 不被接受时，退回页面自己触发下载（会落在下载根目录）
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (u, n) => {
            const a = document.createElement('a');
            a.href = u; a.download = n; a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { try { URL.revokeObjectURL(u); a.remove(); } catch (e) { /* 忽略 */ } }, 60000);
          },
          args: [fetched.objectUrl, filename]
        }).catch(() => {});
      }
    } else {
      return { ok: false, error: 'grab_no_blob_url', url: task.url, cdpPaused: paused };
    }

    // 等下载真正落盘
    const waitMs = typeof task.waitMs === 'number' ? task.waitMs : 60000;
    const deadline = Date.now() + waitMs;
    let item = null;
    while (Date.now() < deadline) {
      if (downloadId !== null) {
        const found = await chrome.downloads.search({ id: downloadId }).catch(() => null);
        item = found && found[0] ? found[0] : null;
        if (item && (item.state === 'complete' || item.state === 'interrupted')) { break; }
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // 从头到尾没有登记任何下载项：扩展侧接管失败，页面兜底的 <a download> 也没触发下载。
    // 这种情况下文件不在磁盘上，报成功会让调用方以为已经拿到了。
    if (downloadId === null) {
      return {
        ok: false,
        error: 'download_not_tracked',
        url: task.url,
        fetchedBytes: fetched.bytes,
        cdpPaused: paused,
        hint: '页面已取到数据，但浏览器没有登记任何下载项，无法确认文件是否落盘。'
      };
    }

    // 与 save 保持一致：中断就是失败，不能只看"下载项存在"
    if (item && item.state === 'interrupted') {
      return {
        ok: false,
        error: 'interrupted',
        url: task.url,
        downloadId,
        fetchedBytes: fetched.bytes,
        cdpPaused: paused,
        reason: item.error || null,
        hint: '下载被中断（服务端拒绝、磁盘不可写或被取消），文件没有完整落盘。'
      };
    }

    return {
      ok: true,
      data: {
        tabId: tab.id,
        url: task.url,
        fetchedBytes: fetched.bytes,
        mime: fetched.type,
        cdpPaused: paused,
        downloadId,
        state: item ? item.state : 'unknown',
        filename: item ? item.filename : null,
        bytes: item && item.totalBytes > 0 ? item.totalBytes : fetched.bytes,
        done: !!item && item.state === 'complete'
      }
    };
  } catch (e) {
    return { ok: false, error: 'grab_failed', message: String(e && e.message ? e.message : e) };
  } finally {
    try { chrome.downloads.onCreated.removeListener(onCreated); } catch (e) { /* 忽略 */ }
    try { chrome.debugger.onEvent.removeListener(onEvent); } catch (e) { /* 忽略 */ }
    if (attached) {
      try { await chrome.debugger.sendCommand(target, 'Fetch.disable'); } catch (e) { /* 忽略 */ }
      try { await chrome.debugger.detach(target); } catch (e) { /* 忽略 */ }
    }
  }
}

export async function saveTab(task) {
  if (!task.url) {
    return { ok: false, error: 'missing_url', hint: '用 --url 指定要保存的地址' };
  }

  // 允许相对地址：给出标签页时按该页面的 URL 解析
  let target = String(task.url);
  let pageUrl = null;
  if (typeof task.tabId === 'number' || task.match || task.url) {
    const tab = await resolveTab(task).catch(() => null);
    if (tab && tab.url) {
      pageUrl = tab.url;
      try { target = new URL(target, tab.url).href; } catch (e) { /* 保持原值 */ }
    }
  }

  if (target.startsWith('blob:')) {
    return {
      ok: false,
      error: 'unsupported_scheme',
      url: target,
      hint: 'blob: 是页面内存里的对象引用，无法用浏览器下载栈保存。可在页面内用 eval 取出为 data URL，但受体积限制。'
    };
  }
  if (!/^https?:/i.test(target)) {
    return { ok: false, error: 'unsupported_scheme', url: target, hint: '只支持 http/https 地址' };
  }

  const options = {
    url: target,
    // 同名文件默认自动改名，避免静默覆盖已有文件
    conflictAction: task.overwrite ? 'overwrite' : 'uniquify'
  };
  options.filename = withMediaSubdir(task.filename || filenameFromUrl(target));
  if (task.saveAs) { options.saveAs = true; }

  let downloadId;
  try {
    downloadId = await chrome.downloads.download(options);
  } catch (e) {
    return { ok: false, error: 'download_failed', url: target, message: String(e && e.message ? e.message : e) };
  }

  // 等待完成，好把真实落盘路径回报给调用方
  const waitMs = typeof task.waitMs === 'number' ? task.waitMs : 30000;
  const deadline = Date.now() + waitMs;
  let item = null;

  for (;;) {
    const found = await chrome.downloads.search({ id: downloadId }).catch(() => null);
    item = found && found[0] ? found[0] : null;
    if (!item) { break; }
    if (item.state === 'complete' || item.state === 'interrupted') { break; }
    if (Date.now() >= deadline) { break; }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!item) {
    return { ok: true, data: { downloadId, url: target, pageUrl, state: 'unknown' } };
  }

  if (item.state === 'interrupted') {
    return {
      ok: false,
      error: 'interrupted',
      url: target,
      pageUrl,
      reason: item.error || null,
      hint: item.error === 'SERVER_FORBIDDEN' || item.error === 'SERVER_UNAUTHORIZED'
        ? '服务器拒绝下载，可能是链接已过期或不带正确的登录态。'
        : undefined
    };
  }

  return {
    ok: true,
    data: {
      downloadId,
      url: target,
      pageUrl,
      state: item.state,
      filename: item.filename || null,
      bytes: item.totalBytes > 0 ? item.totalBytes : (item.bytesReceived || null),
      mime: item.mime || null,
      done: item.state === 'complete'
    }
  };
}

/**
 * 用目标标签页的登录态下载文件：在页面里带 credentials 请求，再回传 base64。
 *
 * 这样下载的是「该登录用户能拿到的内容」，不需要在本地重新登录。
 */

export async function downloadTab(task) {
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

/**
 * 媒体下载统一落在浏览器下载目录下的这个子目录里，
 * 与 yt-dlp 的输出目录保持一致（两边都指向同一个物理位置）。
 */

const MEDIA_SUBDIR = 'videos';

/**
 * 给文件名补上媒体子目录。
 * 调用方已经显式给了路径（含分隔符）就尊重它，否则放到统一子目录下。
 * 注意 chrome.downloads 只接受相对路径，绝对路径和 ".." 会被拒绝。
 */

function withMediaSubdir(name) {
  const n = String(name || '').trim();
  if (!n) { return MEDIA_SUBDIR + '/download.bin'; }
  if (n.includes('/') || n.includes('\\')) { return n; }
  return MEDIA_SUBDIR + '/' + n;
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

/**
 * 量出主框架里元素在页面坐标里的矩形（供 CDP clip 使用），找不到返回 null。
 *
 * 只注入主框架：rectInPage 返回的是元素所在框架自己的页面坐标，跨框架拿来当
 * clip 用会截到页面另一处的内容，比报错更难发现。iframe 里的元素走 elementRectByCdp。
 */

async function elementRectInMainFrame(tabId, selector) {
  try {
    const injection = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
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

/**
 * 用 CDP 量出子框架里元素的矩形，返回主框架页面坐标。
 *
 * 走 CDP 而不是自己累加 iframe 偏移：DOM.getBoxModel 的坐标本来就相对主框架视口，
 * 元素在 iframe 里也成立；自己找 iframe 元素再加偏移的做法在跨域、src 动态写入、
 * 多层嵌套时都会算错，而错的坐标会安静地截出另一处画面。
 *
 * 量不到（跨进程 iframe 读不到内容文档、选择器没命中）返回 null，由调用方报找不到。
 */

async function elementRectByCdp(tabId, selector, frameId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    return null;
  }

  try {
    await chrome.debugger.sendCommand(target, 'DOM.enable');

    // 先拿到该框架自身的文档节点
    const owner = await chrome.debugger.sendCommand(target, 'DOM.getFrameOwner', { frameId });
    if (!owner || typeof owner.backendNodeId !== 'number') { return null; }
    const described = await chrome.debugger.sendCommand(target, 'DOM.describeNode', {
      backendNodeId: owner.backendNodeId,
      pierce: true
    });
    const contentDoc = described && described.node ? described.node.contentDocument : null;
    if (!contentDoc || typeof contentDoc.nodeId !== 'number') { return null; }

    const found = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
      nodeId: contentDoc.nodeId,
      selector
    });
    if (!found || typeof found.nodeId !== 'number' || found.nodeId === 0) { return null; }

    const box = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId: found.nodeId });
    const quad = box && box.model ? box.model.content : null;
    if (!quad || quad.length < 8) { return null; }

    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min.apply(null, xs);
    const y = Math.min.apply(null, ys);
    const width = Math.max.apply(null, xs) - x;
    const height = Math.max.apply(null, ys) - y;
    if (!width || !height) { return null; }

    // CDP 给的是视口坐标，clip 要的是页面坐标，补上主框架的滚动偏移
    let scrollX = 0;
    let scrollY = 0;
    try {
      const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
      const viewport = metrics && metrics.cssVisualViewport;
      if (viewport) {
        scrollX = viewport.pageX || 0;
        scrollY = viewport.pageY || 0;
      }
    } catch (e) {
      // 拿不到滚动偏移就按未滚动处理；比直接放弃截图更接近预期
    }

    return { x: x + scrollX, y: y + scrollY, width, height, scale: 1 };
  } catch (e) {
    return null;
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) { /* 忽略 */ }
  }
}

/** 枚举目标标签页里的链接。 */

export async function linksTab(task) {
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

  // 页面侧说选择器没命中：这是失败，不能当成"页面里没有链接"报成功
  if (data.error) {
    return {
      ok: false,
      error: data.error,
      selector: task.selector,
      url: tab.url,
      hint: '选择器在所有框架里都没有命中元素。可用 frames 查看框架，或用 read --returnHtml 看结构。'
    };
  }

  return {
    ok: true,
    data: {
      tabId: tab.id,
      wasActive: !!tab.active,
      title: tab.title || '',
      url: tab.url || '',
      frameId: picked.frameId,
      frameCount: picked.frameCount,
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

export async function clickTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const beforeTabs = await chrome.tabs.query({});
  const beforeIds = new Set(beforeTabs.map((t) => t.id));

  const picked = await injectInBestFrame(
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
 *
 * fromUrl 是导航前的地址（新建标签页时没有，传 undefined）。它用来挡住
 * chrome.tabs.update 刚返回、新导航还没开始的这一小段：此时读到的仍是旧地址、
 * status 仍是 complete，会被误判成"服务端重定向"而立刻按旧地址返回。
 *
 * 命中判断只看去掉 # 之后的完整地址，不能用前缀包含：当前地址是目标的超集时
 * （例如当前 /doc?id=1、目标是 /doc）前缀包含会把旧地址当成功。
 */

async function waitForTabUrl(tabId, targetUrl, timeoutMs = 10000, fromUrl) {
  const base = String(targetUrl).split('#')[0];
  const deadline = Date.now() + timeoutMs;
  let last = '';

  for (;;) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) { return { url: null, tabGone: true }; }

    last = t.url || '';
    const settled = last.split('#')[0];
    if (last === targetUrl || settled === base) {
      return { url: last };
    }
    // 加载已完成但地址已不是导航前那个，通常是服务端重定向，按实际地址返回
    if (t.status === 'complete' && last !== fromUrl) {
      return { url: last, redirected: true };
    }
    if (Date.now() >= deadline) {
      return { url: last, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 导航到指定 URL。默认在后台新建标签页，不影响用户当前视图。 */

export async function navigateTab(task) {
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
  const settled = await waitForTabUrl(tab.id, target, waitMs, urlBefore);

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

export async function typeTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const picked = await injectInBestFrame(
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

export async function keyTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const picked = await injectInBestFrame(
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

/* 供其他模块使用 */

