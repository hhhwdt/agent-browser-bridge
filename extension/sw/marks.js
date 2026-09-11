/**
 * Agent Browser Bridge —— "这个页面被 agent 动过"的可见标记：徽标、站点图标角点、标题前缀、页面内浮层。
 * 标记要能被找回、能过期、能在扩展重载后清理，所以状态与操作放在一起。
 */

'use strict';

import { indicatorInPage, tabMarkInPage } from './injected.js';
import { BROWSER_NAME } from './config.js';
import { ensureInjectable, resolveTab, withTimeout } from './guards.js';

/** 视觉标记类注入的预算。标记是锦上添花，遇到冻结标签页不值得久等。 */

const MARK_INJECT_TIMEOUT_MS = 4000;

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

export async function loadMarks() {
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

export async function saveMarks() {
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

      // 标题前缀被页面改掉了，但徽标还在 —— 同样是残留标记。
      // 徽标由我们设置，页面改不了，也不受标题变化影响，是可靠的第二判据。
      //
      // 这里以前判断的是 favIconUrl 是否为 data: URL。那个判据不成立：站点自带的
      // 64x64 PNG 图标与我们的图标头部字节完全相同（实测 DevFlow 的图标前缀与我们
      // 一致到第 41 字节，差异只从 IDAT 数据开始），无法区分。后果是每次清标记都会
      // 去动无关的标签页——它可能没被授权、可能已冻结，白等一次注入超时。
      try {
        const badge = await chrome.action.getBadgeText({ tabId: t.id });
        if (badge === BADGE_TEXT) { ids.add(t.id); }
      } catch (e) {
        // 受限页面取不到徽标，跳过
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

export async function removeBadge(tabId) {
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

export async function markTab(tabId, action, detail) {
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

export async function markTask(task) {
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

export async function unmarkTask(task) {
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

/* 供其他模块使用 */
export { MARKS_KEY, markedTabs };

