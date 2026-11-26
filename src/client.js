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
 *   常见错误码及成因另见 docs/QUICKSTART.md 末尾的排查表。
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { ACTIONS } = require('./actions-registry.js');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18777;
const DEFAULT_TIMEOUT_MS = 30000;

/** HTTP 路径 -> 动作名。重试策略按动作判断，不必给每个具名方法单独传标记。 */
const PATH_TO_ACTION = new Map();
for (const [name, entry] of Object.entries(ACTIONS)) {
  if (entry && entry.path) { PATH_TO_ACTION.set(entry.path, name); }
}

/**
 * 可以安全重试的动作：读类，重复执行不改变页面、不落盘。
 *
 * click / type / key / navigate / upload / save / grab / download / close 以及
 * computer_* 都不在这里。它们的第一次调用可能已经生效、只是结果没回来，
 * 重试就是"点两次""存两份"。桌面动作另有 requestId 幂等，那是另一条路。
 */
const RETRY_SAFE = new Set([
  'tabs', 'read', 'links', 'media', 'frames', 'diag', 'session', 'screenshot',
  'mark', 'unmark', 'activate', 'wait'
]);

/** 值得重试的错误：暂时性的，等一会儿可能就好。业务性失败重试没有意义。 */
const RETRYABLE_ERRORS = new Set([
  'timeout', 'queue_full', 'extension_not_connected', 'tab_unresponsive', 'bridge_unavailable'
]);

/** 睡一会儿。重试间隔用。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

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

/**
 * 读本机 token（服务端与扩展共享的那份）。token 模式下 CLI、MCP、脚本调用的
 * 每个接口都要带 X-ABB-Token，而文件就在同一个配置目录里——自动读省掉
 * 每个调用方手动传一遍；文件不存在（--no-token 模式）就静默不带。
 * createClient({ token }) 可显式覆盖。
 */
function readLocalToken() {
  try {
    const { getConfigDir } = require('./config-dir.js');
    return fs.readFileSync(path.join(getConfigDir(), 'token'), 'utf8').trim();
  } catch (e) {
    return undefined;
  }
}

class BrowserBridgeClient {
  /**
   * @param {object}  [options]
   * @param {string}  [options.host='127.0.0.1']
   * @param {number}  [options.port=18777]
   * @param {number}  [options.timeoutMs=30000] 单次请求默认超时
   * @param {string}  [options.token] 显式指定共享 token；省略时自动读配置目录下的 token 文件
   * @param {string}  [options.agent] 调用方身份（写进 X-ABB-Agent，桌面写锁与审计按它区分）
   * @param {number}  [options.concurrency=0] 同时在飞的请求上限；0 表示不限制。批量作业用它压住尖峰
   * @param {number}  [options.retries=0] 读类动作失败后的重试次数（写类动作永远不自动重试，见 RETRY_SAFE）
   * @param {number}  [options.retryDelayMs=250] 首次重试的间隔，之后按指数退避
   * @param {number}  [options.maxRetryDelayMs=2000] 退避上限
   */
  constructor(options = {}) {
    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.token = options.token !== undefined ? options.token : readLocalToken();
    this.agent = options.agent || '';
    this.concurrency = options.concurrency > 0 ? options.concurrency : 0;
    this.retries = options.retries > 0 ? Math.floor(options.retries) : 0;
    this.retryDelayMs = options.retryDelayMs || 250;
    this.maxRetryDelayMs = options.maxRetryDelayMs || 2000;
    /** 正在飞的请求数，以及排队等名额的调用方。 */
    this._active = 0;
    this._waiters = [];
  }

  /**
   * 取一个并发名额。达到上限就排队，名额由释放方直接转交。
   * 用转交而不是"唤醒后再自己加"，是为了让 _active 永远不超过上限。
   */
  async _acquire() {
    if (!this.concurrency) { return; }
    if (this._active < this.concurrency) { this._active++; return; }
    await new Promise((resolve) => { this._waiters.push(resolve); });
  }

  /** 释放名额：有排队的就把名额直接转交，没有才真正减一。 */
  _release() {
    if (!this.concurrency) { return; }
    const next = this._waiters.shift();
    if (next) { next(); } else { this._active--; }
  }

  /**
   * 带并发闸门的请求。
   * 不限并发时直接走原路径，不多绕一层 promise——默认行为和以前完全一致。
   */
  _requestInSlot(method, urlPath, body, timeoutMs) {
    if (!this.concurrency) {
      return this.request(method, urlPath, body, timeoutMs);
    }
    return (async () => {
      await this._acquire();
      try {
        return await this.request(method, urlPath, body, timeoutMs);
      } finally {
        this._release();
      }
    })();
  }

  /** 低层请求。返回 { status, data }。 */
  request(method, urlPath, body, timeoutMs) {
    const wait = timeoutMs || this.timeoutMs;

    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

      const headers = {};
      if (this.token) { headers['X-ABB-Token'] = this.token; }
      if (this.agent) { headers['X-ABB-Agent'] = this.agent; }
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }

      const req = http.request({
        host: this.host,
        port: this.port,
        method,
        path: urlPath,
        // agent 环境常带系统代理，这里必须显式声明不走代理
        headers
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

      let timedOut = false;
      req.setTimeout(wait, () => {
        timedOut = true;
        req.destroy(new Error(`请求超时（${wait}ms）`));
      });

      req.on('error', (e) => {
        // 超时不能报成"服务未启动"：两者的排查方向完全相反
        if (timedOut) {
          reject(new BridgeError({
            error: 'timeout',
            hint: `桥接服务在 ${wait}ms 内没有返回结果，可能扩展离线或标签页无响应`
          }, 0));
          return;
        }
        reject(new BridgeUnavailableError(this.port, e.message));
      });
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  /**
   * 发请求并解包：成功返回 data，失败抛 BridgeError。
   *
   * 重试只发生在两类条件同时成立时：调用方开了 retries，且这个动作在 RETRY_SAFE
   * 里（读类）。写类动作一次都不重试——它们的第一次调用可能已经生效，重试等于
   * 重复操作。退避是指数式的，带一点抖动，避免批量作业同时重试。
   */
  async call(method, urlPath, body, timeoutMs) {
    const action = PATH_TO_ACTION.get(urlPath);
    const maxAttempts = this.retries > 0 && RETRY_SAFE.has(action) ? this.retries + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this._requestInSlot(method, urlPath, body, timeoutMs);
        const payload = res.data;
        if (!payload || payload.ok !== true) {
          throw new BridgeError(payload, res.status);
        }
        // 无 data 字段的接口（如 /health）直接返回整个响应
        return Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
      } catch (e) {
        const retryable = e instanceof BridgeError && RETRYABLE_ERRORS.has(e.code);
        if (!retryable || attempt >= maxAttempts) { throw e; }

        const base = Math.min(this.retryDelayMs * Math.pow(2, attempt - 1), this.maxRetryDelayMs);
        await sleep(Math.round(base * (0.8 + Math.random() * 0.4)));
      }
    }
  }

  /**
   * 逃生口：按注册表里的动作名直接调用（参数原样作为请求体下发）。
   *
   * 具名方法（read/click/grab…）仍是首选——它们带类型化参数提示。这个口子
   * 服务于两个场景：发行 npm 包落后于新动作的那段空窗；以及脚本拿动作名
   * 直接派发而不必为每个参数挑方法。路径、请求体与请求超时全部按
   * src/actions-registry.js 的登记计算，动作名不在注册表时抛错。
   *
   *   const ab = createClient();
   *   await ab.action('navigate', { url: 'https://example.com', newTab: true });
   */
  action(name, params = {}) {
    const entry = ACTIONS[name];
    if (!entry) {
      throw new Error(`注册表里没有这个动作: ${name}（browser_list_tabs 等文档见 README）`);
    }
    let requestTimeout;
    if (entry.timeout === 'wait') {
      requestTimeout = (params.timeoutMs || 10000) + 5000;
    } else if (typeof entry.timeout === 'number') {
      // 留 20 秒网络余量：请求超时必须长于服务端派发超时，否则本地先断
      requestTimeout = entry.timeout + 20000;
    }
    if (entry.target === 'query') {
      const qs = params.browser ? `?browser=${encodeURIComponent(normalizeBrowserName(params.browser))}` : '';
      return this.call('GET', entry.path + qs, undefined, requestTimeout);
    }
    return this.call('POST', entry.path, params, requestTimeout);
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
   * 在目标标签页里执行一段 JS 并取回结果（量 DOM、读计算样式等自动化验证用）。
   * 代码在页面主世界执行，用 return 返回结果；DOM 节点会被转成
   * {node, id, className, text, html}，超长内容截断，整体超过 200KB 时置 truncated=true。
   */
  evalPage(options = {}) {
    return this.call('POST', '/eval', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      code: options.code,
      browser: options.browser
    }, options.timeoutMs);
  }

  /**
   * 截取目标标签页当前可见画面，返回 {dataUrl, format, width, height}。
   * 注意：扩展 API 只能截「当前激活」的标签页，后台标签页会返回 tab_not_active。
   */
  screenshot(options = {}) {
    return this.call('POST', '/screenshot', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      format: options.format,
      selector: options.selector,
      full: !!options.full,
      browser: options.browser
    }, (options.timeoutMs || 20000) + 10000);
  }

  /**
   * 读取目标标签页的登录态：cookies（含 httpOnly）+ localStorage / sessionStorage。
   * 只传 name 时只取该 cookie；传 key 时只取该存储键；storage=false 时只取 cookie。
   */
  session(options = {}) {
    return this.call('POST', '/session', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      name: options.name,
      key: options.key,
      local: options.local,
      session: options.session,
      storage: options.storage,
      browser: options.browser
    }, options.timeoutMs);
  }

  /** 把本地文件塞进页面的 file input（files 传绝对路径数组）。 */
  upload(options = {}) {
    return this.call('POST', '/upload', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      selector: options.selector,
      files: options.files,
      browser: options.browser
    }, (options.timeoutMs || 30000) + 10000);
  }

  /** 用目标标签页的登录态下载：在页面里带 cookie 请求 url，返回 base64 等信息。 */
  download(options = {}) {
    return this.call('POST', '/download', {
      match: options.match,
      tabId: options.tabId,
      url: options.url,
      maxBytes: options.maxBytes,
      headers: options.headers,
      browser: options.browser
    }, (options.timeoutMs || 60000) + 10000);
  }

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
      format: options.format,
      autoActivate: !!options.autoActivate,
      lease: !!options.lease,
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
      url: options.url,
      count: options.count,
      idleMs: options.idleMs,
      state: options.state === 'disappear' ? 'disappear' : 'appear',
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      browser: options.browser
    }, (options.timeoutMs || 10000) + 5000);
  }

  /**
   * 枚举页面里的媒体候选（视频/播放清单/图片/音频），供挑选后再下载。
   */
  media(options = {}) {
    return this.call('POST', '/media', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      frameId: options.frameId,
      minImageSize: options.minImageSize,
      maxScanChars: options.maxScanChars,
      browser: options.browser
    }, options.timeoutMs || 45000);
  }

  /**
   * 抓取受防盗链/CORS 保护的媒体（签名地址 + 拒绝跨域读取的 CDN）。
   * 通过 CDP 给跨域响应补上 CORS 头，让页面内 fetch 能读到字节，
   * 再由页面触发浏览器下载。需要指定在哪个标签页内取流（match 或 tabId），
   * 且该标签页不能开着 DevTools。
   */
  grab(options = {}) {
    return this.call('POST', '/grab', {
      match: options.match,
      tabId: options.tabId,
      url: options.url,
      filename: options.filename,
      timeoutMs: options.timeoutMs,
      waitMs: options.waitMs,
      browser: options.browser
    }, (options.timeoutMs || 180000) + 20000);
  }

  /**
   * 用浏览器自己的下载栈把 URL 保存到磁盘。
   * 不受 CORS 与 20MB 限制，字节直接写盘；文件落在浏览器下载目录，
   * filename 只能指定其下的相对路径。不支持 blob: 地址。
   */
  save(options = {}) {
    return this.call('POST', '/save', {
      match: options.match,
      tabId: options.tabId,
      url: options.url,
      filename: options.filename,
      saveAs: !!options.saveAs,
      overwrite: !!options.overwrite,
      waitMs: options.waitMs,
      browser: options.browser
    }, options.timeoutMs || 90000);
  }

  /**
   * 激活标签页并聚焦其窗口。
   * 长期未访问的标签页会被浏览器冻结，注入无响应，需先唤醒。
   * 注意：会切换用户当前视图。
   */
  activate(options = {}) {
    return this.call('POST', '/activate', {
      match: options.match,
      url: options.url,
      tabId: options.tabId,
      browser: options.browser
    }, options.timeoutMs);
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

  /**
   * 批量执行动作：按顺序执行，每步独立返回结果，第一步失败时停止。
   * steps: 动作对象数组，每个对象至少包含 action 字段。
   */
  batch(steps, options = {}) {
    return this.call('POST', '/batch', {
      steps,
      continueOnError: !!options.continueOnError
    }, options.timeoutMs || 60000);
  }

  // ---- computer 桌面控制（仅 Windows 本机执行，不经扩展）----
  // 方法名与注册表动作一一对应，参数原样转交，缺省超时来自注册表 timeout。

  /** 截取整个桌面，或按区域/窗口截取。 */
  computerScreen(options = {}) {
    return this.action('computerScreen', options);
  }

  /** 识别桌面/窗口里的文字，返回文字与屏幕坐标。 */
  computerOcr(options = {}) {
    return this.action('computerOcr', options);
  }

  /** 列出可见顶层窗口。 */
  computerWindows(options = {}) {
    return this.action('computerWindows', options);
  }

  /** 窗口动作：activate / minimize / maximize / close（close 需 force）。 */
  computerWindow(options = {}) {
    return this.action('computerWindow', options);
  }

  /** 鼠标点击屏幕坐标。 */
  computerClick(options = {}) {
    return this.action('computerClick', options);
  }

  /** 鼠标移动（不点击）。 */
  computerMove(options = {}) {
    return this.action('computerMove', options);
  }

  /** 按住左键从起点拖到终点。 */
  computerDrag(options = {}) {
    return this.action('computerDrag', options);
  }

  /** 滚轮滚动。 */
  computerScroll(options = {}) {
    return this.action('computerScroll', options);
  }

  /** 向焦点窗口键入文本。 */
  computerType(options = {}) {
    return this.action('computerType', options);
  }

  /** 向焦点窗口派发按键/组合键。 */
  computerKey(options = {}) {
    return this.action('computerKey', options);
  }

  /** 读取（默认）或写入剪贴板。 */
  computerClipboard(options = {}) {
    return this.action('computerClipboard', options);
  }

  /** 执行 PowerShell 命令（白名单外需 force）。 */
  computerShell(options = {}) {
    return this.action('computerShell', options);
  }

  /** 列出进程（list，默认）或按 pid 终止（kill 需 force）。 */
  computerProcess(options = {}) {
    return this.action('computerProcess', options);
  }

  /** 弹 Windows 通知。 */
  computerNotify(options = {}) {
    return this.action('computerNotify', options);
  }

  /** 音量读取/设置与媒体键。 */
  computerMedia(options = {}) {
    return this.action('computerMedia', options);
  }

  /** 读取窗口的 UIA 控件树。 */
  computerTree(options = {}) {
    return this.action('computerTree', options);
  }

  /** 按控件属性查找（name / automationId / controlType / className）。 */
  computerFind(options = {}) {
    return this.action('computerFind', options);
  }

  /** 对控件执行 UIA 动作（invoke / setValue / getValue / click 等）。 */
  computerAct(options = {}) {
    return this.action('computerAct', options);
  }

  /** 等控件出现、消失、可用或文本变成期望值。 */
  computerWaitFor(options = {}) {
    return this.action('computerWaitFor', options);
  }

  /**
   * 批量执行桌面动作，共享一次桌面写锁。
   *
   * @param {object} options
   * @param {Array<{action: string, params?: object}>} options.ops 动作列表
   * @param {number} [options.waitMs] 桌面被占用时排队毫秒数
   * @param {boolean} [options.stopOnError=true] 某步失败后是否停止
   */
  computerBatch(options = {}) {
    return this.action('computerBatch', options);
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
