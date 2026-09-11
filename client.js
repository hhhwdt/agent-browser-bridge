/**
 * Agent Browser Bridge —— 可复用客户端。
 *
 * 供任意本机 agent / 脚本引用，通过本机桥接服务后台操作已打开的浏览器。
 * 零依赖，只用 Node 原生模块，且强制绕过系统代理（只连 127.0.0.1）。
 *
 * 用法（CommonJS）：
 *   const { createClient } = require('./client.js');
 *   const ab = createClient();
 *
 *   const tabs = await ab.tabs();
 *   const page = await ab.read({ match: 'example.com' });
 *   console.log(page.text);
 *
 *   await ab.click({ match: 'example.com', text: '关联文档' });
 *   await ab.type({ match: 'example.com', value: '正文内容' });
 *
 * 用法（ESM）：
 *   import { createClient } from './client.js';
 *
 * 错误处理：
 *   所有方法在失败时抛出 BridgeError，可通过 err.code 判断原因：
 *     extension_not_connected  扩展未连接
 *     browser_not_connected    指定的浏览器未连接
 *     no_tab_matched           没有匹配的标签页
 *     permission_denied        站点未授权，需在扩展弹窗授权
 *     not_a_link               目标不是链接
 *     not_editable             目标不可编辑
 *     timeout                  扩展未在超时内返回
 *   完整错误码见 README.txt。
 */

'use strict';

const http = require('node:http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18777;
const DEFAULT_TIMEOUT_MS = 30000;

/** 桥接服务返回的业务错误。 */
class BridgeError extends Error {
  constructor(payload, httpStatus) {
    const code = (payload && payload.error) || 'unknown_error';
    const hint = payload && payload.hint ? ` — ${payload.hint}` : '';
    super(`${code}${hint}`);
    this.name = 'BridgeError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = payload || {};
  }
}

/** 无法连接桥接服务（服务未启动）。 */
class BridgeUnavailableError extends Error {
  constructor(port, cause) {
    super(`无法连接桥接服务 http://${DEFAULT_HOST}:${port}${cause ? ` — ${cause}` : ''}`);
    this.name = 'BridgeUnavailableError';
    this.code = 'bridge_unavailable';
    this.port = port;
  }
}

function normalizeBrowserName(name) {
  const v = String(name || '').trim().toLowerCase();
  if (v.includes('edg')) { return 'edge'; }
  if (v.includes('chrome')) { return 'chrome'; }
  if (v.includes('firefox')) { return 'firefox'; }
  return v;
}

class BrowserBridgeClient {
  /**
   * @param {object}  [options]
   * @param {string}  [options.host='127.0.0.1']
   * @param {number}  [options.port=18777]
   * @param {number}  [options.timeoutMs=30000] 单次请求默认超时
   */
  constructor(options = {}) {
    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  /** 低层请求。返回 { status, data }。 */
  request(method, urlPath, body, timeoutMs) {
    const wait = timeoutMs || this.timeoutMs;

    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

      const req = http.request({
        host: this.host,
        port: this.port,
        method,
        path: urlPath,
        // agent 环境常带系统代理，这里必须显式声明不走代理
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {}
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          if (raw) {
            try { data = JSON.parse(raw); } catch (e) { data = { ok: false, error: 'invalid_json', raw }; }
          }
          resolve({ status: res.statusCode, data });
        });
      });

      req.setTimeout(wait, () => {
        req.destroy(new Error(`请求超时（${wait}ms）`));
      });

      req.on('error', (e) => reject(new BridgeUnavailableError(this.port, e.message)));
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  /** 发请求并解包：成功返回 data，失败抛 BridgeError。 */
  async call(method, urlPath, body, timeoutMs) {
    const res = await this.request(method, urlPath, body, timeoutMs);
    const payload = res.data;

    if (!payload || payload.ok !== true) {
      throw new BridgeError(payload, res.status);
    }
    // 无 data 字段的接口（如 /health）直接返回整个响应
    return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  }

  // ---- 服务与能力 ----

  /** 服务状态与能力清单。 */
  health() {
    return this.call('GET', '/health');
  }

  /** 当前是否可用（服务在线且有扩展连接）。不抛错。 */
  async isReady() {
    try {
      const h = await this.health();
      return !!h.extensionConnected;
    } catch (e) {
      return false;
    }
  }

  /** 等待服务与扩展就绪。 */
  async waitUntilReady(timeoutMs = 15000, intervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.isReady()) { return true; }
      if (Date.now() >= deadline) { return false; }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** 已连接扩展的浏览器列表。 */
  async browsers() {
    const h = await this.health();
    return h.browsers || [];
  }

  // ---- 标签页 ----

  /** 列出标签页。 */
  tabs(options = {}) {
    const qs = options.browser ? `?browser=${encodeURIComponent(normalizeBrowserName(options.browser))}` : '';
    return this.call('GET', `/tabs${qs}`, undefined, options.timeoutMs);
  }

  // ---- 读取类 ----

  /**
   * 读取正文。
   * 传 returnHtml 时额外返回元素 outerHTML、可编辑区域清单等结构信息，
   * 用于定位选择器（例如找 Confluence 编辑器）。
   */
  read(options = {}) {
    return this.call('POST', '/read', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      selector: options.selector,
      includeLinks: !!options.includeLinks,
      returnHtml: !!options.returnHtml,
      browser: options.browser
    }, options.timeoutMs);
  }

  /**
   * 等待条件成立，用于自动化流程中等待异步 UI。
   * state='appear'（默认）等元素/文字出现，'disappear' 等其消失。
   */
  wait(options = {}) {
    return this.call('POST', '/wait', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      selector: options.selector,
      text: options.text,
      state: options.state === 'disappear' ? 'disappear' : 'appear',
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      browser: options.browser
    }, (options.timeoutMs || 10000) + 5000);
  }

  /** 扩展自身的运行诊断：版本、连接、错误日志。 */
  diag(options = {}) {
    return this.call('POST', '/diag', { browser: options.browser }, options.timeoutMs || 10000);
  }

  /** 诊断标签页内所有框架的状态（排查编辑器在哪、如何可编辑）。 */
  frames(options = {}) {
    return this.call('POST', '/frames', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      browser: options.browser
    }, options.timeoutMs);
  }

  /** 枚举链接。 */
  links(options = {}) {
    return this.call('POST', '/links', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      selector: options.selector,
      text: options.text,
      browser: options.browser
    }, options.timeoutMs);
  }

  // ---- 写入类 ----

  /**
   * 点击元素。
   * 默认只允许点击链接；点击按钮等需显式 allowNonLink=true。
   */
  click(options = {}) {
    return this.call('POST', '/click', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      selector: options.selector,
      text: options.text,
      href: options.href,
      index: options.index,
      allowNonLink: !!options.allowNonLink,
      dryRun: !!options.dryRun,
      browser: options.browser
    }, options.timeoutMs);
  }

  /**
   * 输入文本。
   * 写入 contenteditable（如 Confluence 编辑器）时内部走 execCommand，
   * 编辑器才能正确同步内容；method='html' 可插入结构化内容。
   */
  type(options = {}) {
    return this.call('POST', '/type', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      selector: options.selector,
      text: options.text,
      value: options.value == null ? '' : String(options.value),
      method: options.method === 'html' ? 'html' : 'text',
      clear: !!options.clear,
      allowNonInput: !!options.allowNonInput,
      browser: options.browser
    }, options.timeoutMs);
  }

  /** 派发按键。派发的是合成事件，不产生文本输入。 */
  key(options = {}) {
    return this.call('POST', '/key', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      selector: options.selector,
      key: options.key,
      ctrl: !!options.ctrl,
      shift: !!options.shift,
      alt: !!options.alt,
      meta: !!options.meta,
      browser: options.browser
    }, options.timeoutMs);
  }

  /**
   * 导航。未指定 tabId/match 时默认后台新建标签页。
   * 服务端会等到地址真正变更后才返回，因此 navigate 之后可直接 read。
   */
  navigate(options = {}) {
    return this.call('POST', '/navigate', {
      url: options.url,
      newTab: !!options.newTab,
      active: !!options.active,
      match: options.match,
      tabId: options.tabId,
      frameId: options.frameId,
      waitMs: options.waitMs,
      browser: options.browser
    }, options.timeoutMs);
  }

  // ---- 标记 ----

  /** 标记标签页，便于用户看到哪些页面被操作过。 */
  mark(options = {}) {
    return this.call('POST', '/mark', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      text: options.text,
      ttlMs: options.ttlMs,
      browser: options.browser
    }, options.timeoutMs);
  }

  /** 清除标记。不指定目标时清除全部。 */
  unmark(options = {}) {
    return this.call('POST', '/unmark', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      all: options.all !== false,
      browser: options.browser
    }, options.timeoutMs);
  }

  /**
   * 重新加载浏览器扩展自身（开发用）。
   * 改动扩展代码后调用，无需用户手动到扩展管理页点"重新加载"。
   * 调用后扩展会在约 1.2 秒后重载，稍等即可用 waitUntilReady 等待重连。
   */
  reload(options = {}) {
    // 多浏览器时服务端会依次通知，超时需放宽
    return this.call('POST', '/reload', {
      browser: options.browser
    }, options.timeoutMs || 25000);
  }

  /**
   * 关闭标签页。
   * 必须显式指定 tabId；不提供按 match 批量关闭，避免误关用户正在看的页面。
   */
  close(options = {}) {
    if (typeof options.tabId !== 'number') {
      return Promise.reject(new BridgeError({
        error: 'missing_tab_id',
        hint: 'close 必须显式提供 tabId'
      }, 400));
    }
    return this.call('POST', '/close', {
      tabId: options.tabId,
      frameId: options.frameId,
      browser: options.browser
    }, options.timeoutMs);
  }
}

/** 创建一个客户端。 */
function createClient(options) {
  return new BrowserBridgeClient(options);
}

module.exports = {
  BrowserBridgeClient,
  BridgeError,
  BridgeUnavailableError,
  createClient,
  DEFAULT_PORT,
  DEFAULT_HOST
};
