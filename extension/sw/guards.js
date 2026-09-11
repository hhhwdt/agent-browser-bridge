/**
 * Agent Browser Bridge —— 注入的守卫与辅助：把"会不会永不返回""该操作哪个标签页""有没有权限"这几件事
 * 收在一处，动作实现只管调用。
 */

'use strict';

/**
 * 注入超时。标签页的渲染进程可能已休眠或无响应，此时 executeScript 永远不返回，
 * 会把整个任务（乃至轮询循环）一起拖死。加超时后快速失败并给出明确原因。
 */

const INJECT_TIMEOUT_MS = 12000;

/** 给 Promise 加超时。用于包装可能永不返回的浏览器 API 调用。 */

export function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'operation'} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); });
}

/** 把注入失败归一化成可读错误，区分"标签页无响应"与其他失败。 */

export function tabUnresponsive(err, tabId) {
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

export async function injectAndPick(tabId, func, args, picker, frameId, timeoutOverride) {
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

/**
 * 先只读探测、再单框架执行的注入，用于 click / type / key 这类有副作用的动作。
 *
 * allFrames 注入会让函数在每个框架里真实跑一遍：按钮点一次、文字插一遍，
 * 框架有几个就发生几次。injectAndPick 只能决定"回报哪一份结果"，
 * 收不回其他框架里已经发生的副作用。所以写操作分两步：
 *   1. 以 probe=true 在所有框架里只读定位；
 *   2. 只对命中的那个框架执行真实动作。
 * 没有任何框架命中时退回原来的全框架执行，保持既有报错与兜底行为不变。
 */

export async function injectInBestFrame(tabId, func, args, picker, frameId, timeoutOverride) {
  // 调用方已指名框架：不必探测
  if (typeof frameId === 'number') {
    return injectAndPick(tabId, func, args, picker, frameId, timeoutOverride);
  }

  const probeArgs = args.map((a) => (a && typeof a === 'object' ? { ...a, probe: true } : a));
  const probed = await injectAndPick(
    tabId,
    func,
    probeArgs,
    // 命中的框架优先，未命中的仍用原评分排序，仅用于挑出兜底时的报错来源
    (res, fid) => picker(res, fid) + (res && res.probe && res.found ? 1000000 : 0),
    undefined,
    timeoutOverride
  );

  // 注入本身就失败了（标签页无响应等）：真实动作不可能成功，直接把原因报上去，
  // 不要再等一轮十几秒的注入超时。
  if (probed.error) {
    return probed;
  }
  if (probed.data && probed.data.probe && probed.data.found) {
    return injectAndPick(tabId, func, args, picker, probed.frameId, timeoutOverride);
  }
  // 只是没有框架命中：退回原来的全框架执行，保留既有的报错与兜底行为
  return injectAndPick(tabId, func, args, picker, undefined, timeoutOverride);
}

/** 按 tabId / match / url 定位目标标签页。 */

export async function resolveTab(task) {
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

export async function ensureInjectable(tab) {
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

/* 供其他模块使用 */
export { INJECT_TIMEOUT_MS };

