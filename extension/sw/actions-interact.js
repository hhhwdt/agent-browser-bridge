/**
 * 动作实现：点击、导航、输入、按键。
 *
 * 对应 action：click / navigate / type / key。
 */

import { clickInPage } from './inject-click.js';
import { keyInPage, typeInPage } from './inject-edit.js';
import { ensureInjectable, injectInBestFrame, resolveTab } from './guards.js';

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
