/**
 * 动作实现：读取标签页登录态（cookies + localStorage/sessionStorage）。
 *
 * 对应 action：session。
 */

import { readStorageInPage } from './inject-run.js';
import { ensureInjectable, injectAndPick, resolveTab, withTimeout } from './guards.js';

const SESSION_VALUE_MAX = 2000;

function truncate(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max) + '…[截断]' : s;
}

/**
 * 检查可选权限是否已授予。
 *
 * cookies 与 debugger 都是可选权限（安装时不索取，由用户在扩展弹窗中按需授予）。
 * 返回未授予的权限名列表。
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

/**
 * 读取目标标签页的登录态：cookies（含 httpOnly，走 chrome.cookies）+ localStorage / sessionStorage。
 *
 * 用途：默认复用浏览器里已经在用的登录态做操作，不必重新登录。
 * 只按需返回：--name 过滤 cookie 名，--key 过滤存储键，长值截断，避免把整站数据倒出来。
 */
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
