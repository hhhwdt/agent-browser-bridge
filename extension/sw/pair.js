/**
 * Agent Browser Bridge —— 自动配对：向本机宿主要 token，用户零输入。
 *
 * 扩展读不了本地文件，token 原来只能靠人手粘贴。对不熟操作的用户这一步几乎必然
 * 卡住：装完看起来全绿，所有动作却报 extension_not_connected。安装器写了
 * native messaging 宿主注册表之后，扩展可以直接向浏览器要 token。
 *
 * 没装宿主时（开发者手动加载扩展）这里静默失败，弹窗里仍然可以手动粘贴，行为与
 * 以前一致。宿主名必须与安装器写入注册表的名字、以及宿主清单的 name 一致。
 */

'use strict';

import { NATIVE_HOST_NAME } from './config.js';

const TOKEN_KEY = 'abb-token';

/** 宿主不该慢：读一个文件。卡住就放弃，别把启动流程拖住。 */
const PAIR_TIMEOUT_MS = 3000;

/** 每个 service worker 生命周期只强制重配一次，避免 401 时无限循环。 */
let forcedThisBoot = false;

/**
 * 向宿主问一次 token。
 * 宿主不存在、超时、返回空，一律返回空字符串——配对失败不能影响正常启动。
 */
function askHost() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) { return; }
      settled = true;
      resolve(value);
    };

    try {
      if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== 'function') {
        finish('');
        return;
      }
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'get-token' }, (resp) => {
        // 必须读 lastError：不读会在控制台留下 "Unchecked runtime.lastError"，
        // 而且宿主没装时这里就是报错路径。
        const err = chrome.runtime.lastError;
        if (err || !resp || !resp.token) { finish(''); return; }
        finish(String(resp.token));
      });
    } catch (e) {
      finish('');
      return;
    }

    setTimeout(() => finish(''), PAIR_TIMEOUT_MS);
  });
}

/** 当前保存的 token（没有则空字符串）。 */
export async function readStoredToken() {
  try {
    const stored = await chrome.storage.local.get(TOKEN_KEY);
    return (stored && stored[TOKEN_KEY]) || '';
  } catch (e) {
    return '';
  }
}

/**
 * 没有 token 就配对一次；返回是否已有可用 token。
 * 启动时调用。已有 token 时不做任何事，所以每次 SW 唤醒的成本只是一次读存储。
 */
export async function pairIfNeeded() {
  const existing = await readStoredToken();
  if (existing) { return true; }
  const token = await askHost();
  if (!token) { return false; }
  try {
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 服务端回了 401：清掉旧 token 再配一次。
 * 每个 SW 生命周期只做一次——如果宿主给的也不对，反复重试只会把日志刷满。
 * 写入新 token 会触发 ws.js 的 storage 监听，通道自动重连，不需要调用方再做别的。
 */
export async function repairAfterRejected() {
  if (forcedThisBoot) { return false; }
  forcedThisBoot = true;
  try {
    await chrome.storage.local.remove(TOKEN_KEY);
  } catch (e) {
    // 存储不可用，继续尝试问宿主
  }
  const token = await askHost();
  if (!token) { return false; }
  try {
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
    return true;
  } catch (e) {
    return false;
  }
}
