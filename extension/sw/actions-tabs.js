/**
 * 动作实现：标签页元信息、等待、激活唤醒、框架诊断。
 *
 * 对应 action：tabs / wait / activate / frames。
 */

import { diagInPage } from './inject-read.js';
import { waitInPage } from './inject-run.js';
import { BROWSER_NAME } from './config.js';
import { INJECT_TIMEOUT_MS, ensureInjectable, injectAndPick, resolveTab, tabUnresponsive, withTimeout } from './guards.js';

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

export async function waitTab(task) {
  const tab = await resolveTab(task);
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  if (!task.selector && !task.text && !task.url && !task.idleMs) {
    return { ok: false, error: 'missing_condition', hint: '需要提供 selector、text、url 或 idleMs 作为等待条件' };
  }

  const timeoutMs = typeof task.timeoutMs === 'number' ? task.timeoutMs : 10000;

  const picked = await injectAndPick(
    tab.id,
    waitInPage,
    [{
      selector: task.selector || null,
      text: task.text || null,
      url: task.url || null,
      count: typeof task.count === 'number' ? task.count : null,
      idleMs: typeof task.idleMs === 'number' ? task.idleMs : null,
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
