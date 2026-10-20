/**
 * 动作实现：读取正文（text/markdown）、eval、媒体候选、链接。
 *
 * 对应 action：read / eval / media / links。
 */

import { extractInPage, linksInPage, markdownInPage } from './inject-read.js';
import { evalInPage } from './inject-run.js';
import { mediaInPage } from './inject-media.js';
import { BROWSER_NAME } from './config.js';
import { INJECT_TIMEOUT_MS, ensureInjectable, injectAndPick, resolveTab, tabUnresponsive, withTimeout } from './guards.js';

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

const EVAL_MAX_JSON = 200 * 1024;

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

export async function readTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const format = task.format === 'markdown' ? 'markdown' : 'text';

  if (format === 'markdown') {
    // markdown 模式：先提取元素，再转 markdown
    const picked = await injectAndPick(
      tab.id,
      extractInPage,
      [task.selector || null, false, false],
      pickContentFrame(task.selector),
      typeof task.frameId === 'number' ? task.frameId : undefined
    );
    if (picked.error) { return { ...picked.error, url: tab.url }; }
    const el = picked.data && picked.data.el;
    if (!el) { return { ok: false, error: 'element_not_found', url: tab.url }; }
    const md = await injectAndPick(
      tab.id,
      markdownInPage,
      [el],
      pickContentFrame(task.selector),
      typeof task.frameId === 'number' ? task.frameId : undefined
    );
    if (md.error) { return { ...md.error, url: tab.url }; }
    return {
      ok: true,
      data: {
        tabId: tab.id,
        wasActive: !!tab.active,
        frameId: picked.frameId,
        frameCount: picked.frameCount,
        format: 'markdown',
        markdown: md.data.markdown,
        charCount: md.data.charCount
      }
    };
  }

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
