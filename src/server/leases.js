/**
 * Agent Browser Bridge —— Per-tab lease：防止两个 agent 同时操作同一个标签页。
 *
 * caller 用 remotePort 标识。lease 在完成、超时或标签页关闭时释放。
 * opt-in：只有 task.lease 为 true 时才获取 lease。
 */

'use strict';

const tabLeases = new Map(); // tabId -> { caller, ts }

/** 尝试获取标签页 lease。返回 true 表示获取成功，false 表示被其他 caller 持有。 */
function acquireTabLease(tabId, caller) {
  const existing = tabLeases.get(tabId);
  if (existing && existing.caller !== caller) {
    // 被其他 caller 持有，检查是否超时（5 分钟）
    if (Date.now() - existing.ts < 5 * 60 * 1000) {
      return false;
    }
  }
  tabLeases.set(tabId, { caller, ts: Date.now() });
  return true;
}

/** 释放标签页 lease。 */
function releaseTabLease(tabId, caller) {
  const existing = tabLeases.get(tabId);
  if (existing && existing.caller === caller) {
    tabLeases.delete(tabId);
  }
}

/** 查询某个 tabId 当前的持有者（没有则返回 undefined），供冲突提示使用。 */
function getTabLease(tabId) {
  return tabLeases.get(tabId);
}

module.exports = { acquireTabLease, releaseTabLease, getTabLease };
