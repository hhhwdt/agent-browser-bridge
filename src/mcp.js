#!/usr/bin/env node
/**
 * Agent Browser Bridge —— MCP 服务。
 *
 * 把桥接的能力暴露成 MCP 工具，任何支持 MCP 的 agent（Claude Code、Cursor、Cline…）
 * 配一行就能用，不需要自己写代码调 client.js。
 *
 * 传输自己实现：MCP 的 stdio 传输就是「JSON-RPC 2.0，一行一条消息」，
 * 工具类服务只需要 initialize / tools/list / tools/call 三个方法，
 * 为此引入 @modelcontextprotocol/sdk 会让本仓库丢掉「零依赖」这个特点。
 *
 * 两条硬约束：
 *   - stdout 只走协议消息。任何日志、警告、堆栈都必须写 stderr，
 *     往 stdout 打一行普通文字就会破坏协议，客户端会直接判定服务异常。
 *   - 每条消息必须单行，不能内嵌换行。
 *
 * 用法：
 *   node src/mcp.js               作为 MCP 服务运行（由客户端拉起）
 *   node src/mcp.js --list-tools  只打印工具清单，便于人工核对
 *
 * 注册到 Claude Code（在仓库根目录执行，路径交给 shell 展开，不必写死）：
 *   claude mcp add -s user browser -- node "$PWD/src/mcp.js"    # macOS / Linux / Git Bash
 *   claude mcp add -s user browser -- node "%CD%\src\mcp.js"    # Windows cmd
 * 或者 npm i -g . 之后直接用 agent-browser-bridge-mcp，完全不涉及路径。
 * 详见 docs/QUICKSTART.md。
 */

'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createClient, BridgeError, BridgeUnavailableError } = require('./client.js');

const SERVER_NAME = 'agent-browser-bridge';
const SERVER_VERSION = require('../package.json').version;

/**
 * 本实现支持的 MCP 协议版本。
 * 客户端请求的版本只要是个字符串就照原样回，因为工具类服务用到的这三个方法
 * （initialize / tools/list / tools/call）在这些版本之间没有差异；
 * 硬性拒绝反而会让新版本客户端连不上。
 */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

/** 截图 base64 超过这个体积就不塞进上下文了，改为提示收窄截取范围。 */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;

const ab = createClient();

function log(...args) {
  process.stderr.write('[abb-mcp] ' + args.map(String).join(' ') + '\n');
}

/* ------------------------------------------------------------------ *
 * 桥接服务的可用性
 * ------------------------------------------------------------------ */

/**
 * 确认桥接服务可用，必要时把它拉起来。
 *
 * 没有这一步，新用户从「装好扩展」到「第一次成功调用」之间会卡在
 * 「桥接服务未启动」上——这是这类工具最常见的第一次失败。
 *
 * 并发调用共享同一个进行中的探测：启动时的预热和第一次工具调用的重试会同时进来，
 * 各自 spawn 一次就会出现两个进程（第二个 EADDRINUSE 直接退出，白拉一次）。
 */
let bridgeInFlight = null;

function ensureBridge() {
  if (bridgeInFlight) { return bridgeInFlight; }
  bridgeInFlight = doEnsureBridge().finally(() => { bridgeInFlight = null; });
  return bridgeInFlight;
}

async function doEnsureBridge() {
  try {
    const h = await ab.health();
    if (h && h.extensionConnected) { return; }
    throw new Error('桥接服务在运行，但没有浏览器扩展连上来。'
      + '请确认已在浏览器里加载并启用 Agent Browser Bridge 扩展（edge://extensions 或 chrome://extensions）。');
  } catch (e) {
    if (!(e instanceof BridgeUnavailableError)) { throw e; }
  }

  // 端口上没有服务：自己起一个。detached + unref 让它脱离本进程存活，
  // 因为扩展要一直有地方轮询，本进程被客户端关掉不该把桥接一起带走。
  const serverPath = path.join(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'ignore' });
  child.unref();
  log(`桥接服务未在运行，已在后台启动（pid ${child.pid}）`);

  const deadline = Date.now() + 8000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const h = await ab.health();
      if (h) { return; }
    } catch (e) {
      if (Date.now() >= deadline) {
        throw new Error('已尝试启动桥接服务，但 8 秒内没有响应。'
          + `请手动运行 node ${serverPath} 查看原因。`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

/** 指明"操作哪个标签页"：三选一，都不给会由桥接报 missing_target。 */
const TAB_TARGET = {
  match: {
    type: 'string',
    description: 'URL 子串，命中当前激活的标签页优先。最常用的定位方式。'
  },
  tabId: {
    type: 'number',
    description: '标签页 id，由 browser_list_tabs 得到。要精确操作某个后台标签页时用它。'
  },
  browser: {
    type: 'string',
    enum: ['edge', 'chrome'],
    description: '同机开了多个浏览器时指定用哪个；省略则自动挑包含目标标签页的那个。'
  }
};

/** 页面类动作的目标：额外支持按 URL 定位。 */
const PAGE_TARGET = Object.assign({}, TAB_TARGET, {
  url: {
    type: 'string',
    description: '按 URL 精确或前缀匹配定位标签页。与 match 二选一即可。'
  },
  frameId: {
    type: 'number',
    description: '框架 id。富文本编辑器常在 iframe 内，先用 browser_frames 查出再指定。'
  }
});

const TARGET_NOTE = '定位标签页：match / url / tabId 至少给一个。';

const TOOLS = [
  {
    name: 'browser_list_tabs',
    description: '列出浏览器当前打开的所有标签页（id、标题、URL、是否后台、是否已休眠）。'
      + '开始任何操作前先调它，拿到 tabId 和 URL，不要凭猜测去 match。',
    inputSchema: {
      type: 'object',
      properties: { browser: TAB_TARGET.browser },
      additionalProperties: false
    }
  },
  {
    name: 'browser_read_page',
    description: '读取标签页的正文文字。后台标签页也能读，不会切换标签、不抢焦点。'
      + '返回里带 usedSelector 说明正文是从哪个容器取的；读不到内容时用 returnHtml=true '
      + '拿到结构信息再决定 selector。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PAGE_TARGET, {
        selector: { type: 'string', description: '只读这个 CSS 选择器命中的元素，省略则自动挑正文容器。' },
        includeLinks: { type: 'boolean', description: '同时返回正文里的链接列表。' },
        returnHtml: { type: 'boolean', description: '额外返回 outerHTML 与可编辑区域清单，用于定位选择器。' },
        format: { type: 'string', enum: ['text', 'markdown'], description: '默认 text；markdown 返回 Markdown 格式正文。' },
        autoActivate: { type: 'boolean', description: '遇到冻结标签页时先 activate 唤醒再重试一次。' },
        lease: { type: 'boolean', description: '获取标签页独占锁，防止其他 caller 同时操作同一标签页。' }
      }),
      additionalProperties: false
    }
  },
  {
    name: 'browser_get_links',
    description: '枚举页面里的链接（文字 + 绝对地址 + 是否可见）。'
      + '需要点进某个关联页面时先用它拿到链接，再交给用户或 browser_click。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PAGE_TARGET, {
        text: { type: 'string', description: '只返回文字里包含该子串的链接。' },
        selector: { type: 'string', description: '限定在某个容器内枚举。' }
      }),
      additionalProperties: false
    }
  },
  {
    name: 'browser_navigate',
    description: '导航到某个地址。默认后台新建标签页，不影响用户当前视图。'
      + '不指定 match/tabId 时会新建标签页。要复用已有标签页就传 match 或 tabId。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, TAB_TARGET, {
        url: { type: 'string', description: '目标地址（必填，只支持 http/https）。' },
        newTab: { type: 'boolean', description: '强制新建标签页。' },
        active: { type: 'boolean', description: '新建时是否置于前台。默认 false，不要随便开启。' },
        waitMs: { type: 'number', description: '等待地址真正变更的最长时间，默认 10000。' }
      }),
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_batch',
    description: '批量执行多个动作，按顺序执行，每步独立返回结果。'
      + '第一步失败时停止（除非 continueOnError=true）。'
      + '每个步骤保持自己的语义：破坏性 click 仍需 force，type 仍不提交。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '动作对象数组，每个对象至少包含 action 字段。',
          items: { type: 'object' }
        },
        continueOnError: { type: 'boolean', description: '第一步失败后是否继续执行后续步骤。' }
      },
      required: ['steps'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_click',
    description: '点击元素。默认只允许点击链接；按钮等非链接元素会按文案风险分级——'
      + '「编辑/插入/取消」这类直接放行，「删除/提交/发布/保存」这类会被拦下，'
      + '需要 force=true 才执行。force 只在该具体动作已获得用户确认时才传。'
      + '不确定会点到什么就先 dryRun=true，它只回报判定结果，不真的点。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PAGE_TARGET, {
        selector: { type: 'string', description: 'CSS 选择器。' },
        text: { type: 'string', description: '按可见文字定位（优先命中链接，其次文字最短的元素）。' },
        href: { type: 'string', description: '按 href 片段定位链接。' },
        index: { type: 'number', description: '多个匹配时取第几个，从 0 开始。先用 dryRun 看清匹配数。' },
        force: { type: 'boolean', description: '允许点击非链接元素、以及绕过破坏性文案拦截。谨慎使用。' },
        dryRun: { type: 'boolean', description: '只回报会点到什么，不执行。' }
      }),
      additionalProperties: false
    }
  },
  {
    name: 'browser_type',
    description: '向输入框、文本域或可编辑区域写入文字。富文本编辑器（Confluence 等）内部走 execCommand，'
      + '编辑器能正确同步。默认只写可编辑元素，写其他元素需要 force=true。'
      + '只把内容放进编辑器，不会提交——提交要另外调 browser_click。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PAGE_TARGET, {
        value: { type: 'string', description: '要写入的文字。' },
        selector: { type: 'string', description: '目标 CSS 选择器。' },
        text: { type: 'string', description: '按字段名/占位符/aria-label 定位输入框。' },
        clear: { type: 'boolean', description: '先清空原有内容。清空富文本编辑器正文属高风险，确认后再用。' },
        method: { type: 'string', enum: ['text', 'html'], description: 'html 会先清洗掉 script/iframe/on* 事件。' },
        force: { type: 'boolean', description: '允许写入非可编辑元素。谨慎使用。' }
      }),
      required: ['value'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_press_key',
    description: '派发按键（Enter / Tab / Escape / 方向键等）。派发的是合成事件，'
      + '只触发页面内的 JS 处理器，不产生文本、也不会触发浏览器级快捷键。要输入文字用 browser_type。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PAGE_TARGET, {
        key: { type: 'string', description: '键名，如 Enter / Tab / Escape / ArrowDown。' },
        selector: { type: 'string', description: '按键前先聚焦的元素。' },
        ctrl: { type: 'boolean' },
        shift: { type: 'boolean' },
        alt: { type: 'boolean' },
        meta: { type: 'boolean' }
      }),
      required: ['key'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_wait_for',
    description: '等某个元素出现或消失、等某段文字出现、等 URL 包含某子串、等元素数量达标、或等网络空闲。'
      + '页面异步刷新（对话框、列表、编辑器加载）之后必须用它，否则下一步会随机失败。'
      + 'state=disappear 用于等加载动画消失。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PAGE_TARGET, {
        selector: { type: 'string', description: '等待这个选择器命中的元素出现/消失。' },
        text: { type: 'string', description: '等待正文里出现这段文字。' },
        url: { type: 'string', description: '等待 location.href 包含这个子串（SPA 路由变化）。' },
        count: { type: 'number', description: '等待 selector 命中的元素数量达到 n（需同时提供 selector）。' },
        idleMs: { type: 'number', description: '等待网络空闲：资源请求数在 N 毫秒内不再增长。' },
        state: { type: 'string', enum: ['appear', 'disappear'], description: '默认 appear。' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 10000。' }
      }),
      additionalProperties: false
    }
  },
  {
    name: 'browser_screenshot',
    description: '截取标签页画面并直接返回图片。后台标签页也能截，不切标签。'
      + '按 selector 只截某个元素、full=true 截整页。页面很长时优先用 selector，'
      + '整页截图过大时不会返回图片，只给尺寸和提示。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PAGE_TARGET, {
        selector: { type: 'string', description: '只截这个元素。' },
        full: { type: 'boolean', description: '截整页（含滚动区域）。' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '默认 png。' }
      }),
      additionalProperties: false
    }
  },
  {
    name: 'browser_eval',
    description: '在页面主世界执行一段 JS 并取回结果，用于量尺寸、读计算样式、'
      + '或从页面数据里取现成工具拿不到的东西。代码只执行一次。'
      + '用 return 返回结果（例如 "return document.title"），也支持直接写表达式。'
      + '这是强原语：不要用它绕过上面这些工具的安全限制去改页面状态。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, PAGE_TARGET, {
        code: { type: 'string', description: '要执行的 JS。用 return 返回结果。' }
      }),
      required: ['code'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_frames',
    description: '列出标签页内所有框架及其状态（是否可编辑、正文长度、designMode）。'
      + '读不到正文、或写不进富文本编辑器时，用它找出目标在哪个 frameId。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, TAB_TARGET),
      additionalProperties: false
    }
  },
  {
    name: 'browser_save_file',
    description: '用浏览器自己的下载栈把一个地址存到磁盘（不受 CORS 限制，也能用上登录态）。'
      + '落点是浏览器的下载目录，filename 只能是其下的相对路径。返回真实落盘路径。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, TAB_TARGET, {
        url: { type: 'string', description: '要保存的地址，支持相对地址（按标签页 URL 解析）。' },
        filename: { type: 'string', description: '文件名或下载目录下的相对路径。' },
        overwrite: { type: 'boolean', description: '同名时覆盖，默认自动改名。' },
        waitMs: { type: 'number', description: '等待落盘的最长时间，默认 30000。' }
      }),
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_upload_file',
    description: '把本地文件塞进页面的文件选择框（走浏览器调试协议）。'
      + '目标标签页不能开着 DevTools。用完后浏览器顶部会出现过的调试提示条会自动消失。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, TAB_TARGET, {
        files: { type: 'array', items: { type: 'string' }, description: '本地文件的绝对路径。' },
        selector: { type: 'string', description: 'file input 的选择器，默认 input[type=file]。' }
      }),
      required: ['files'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_session',
    description: '读取该标签页的登录态：Cookie（含 httpOnly）与 localStorage / sessionStorage。'
      + '需要用户先在扩展弹窗里授予可选的 cookies 权限，否则返回 permission_not_granted。'
      + '只在任务确实需要时调用，不要把结果直接贴给用户之外的任何地方。',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, TAB_TARGET, {
        name: { type: 'string', description: '只取这个名称的 Cookie。' },
        key: { type: 'string', description: '只取这个存储键。' },
        storage: { type: 'boolean', description: 'false 表示只取 Cookie，不读本地存储。' }
      }),
      additionalProperties: false
    }
  },
  {
    name: 'browser_close_tab',
    description: '关闭标签页。必须给 tabId——不支持按 match 批量关闭，避免误关用户正在看的页面。'
      + '只关你自己开的标签页；用户自己打开的页面除非他明确要求，不要动。',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number', description: '要关闭的标签页 id。' } },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_clear_marks',
    description: '清除所有浏览器里所有标签页的操作标记（标题前缀 🤖、图标圆点、徽标）。'
      + '任务收尾时调用——标记是给用户看"这些页面被 agent 动过"的，用完不清会一直留着。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_status',
    description: '桥接与扩展的运行状态：在线浏览器、扩展版本与 id、最近错误。'
      + '任何工具报扩展未连接时先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

/** initialize 回给客户端的服务级说明，模型会读到。 */
const INSTRUCTIONS = [
  '这个服务让 agent 操作用户**已经打开并已登录**的浏览器，全程后台运行，不切换标签、不抢焦点。',
  '',
  '工作纪律：',
  '1. 先 browser_list_tabs 看现状，拿到 tabId / URL 再动手，不要凭猜测去 match。',
  '2. 站点访问默认是拒绝的，需要用户在扩展弹窗里逐站授权。遇到 permission_denied 时把原文告诉用户，不要反复重试。',
  '3. 需要新页面时用 browser_navigate（默认后台新建），用完 browser_close_tab 关掉；不要动用户自己的标签页。',
  '4. 操作会在页面上留下可见标记。任务收尾时调 browser_clear_marks，除非用户还要继续看。',
  '5. 不可逆动作（提交、发布、发送、删除、审批、付款）一律先用 browser_click 的 dryRun 看清会点到什么，'
    + '并让用户确认；只有确认过才传 force=true。',
  '6. browser_type 只写内容不提交，提交必须单独一个 browser_click——这让用户有机会在提交前看一眼。',
  '7. 页面异步刷新后先 browser_wait_for，否则下一步会随机失败。',
  '8. 写共享文档、生产系统，或任何有真实的人在另一头看到的系统之前，先向用户确认。'
].join('\n');

/* ------------------------------------------------------------------ *
 * 工具执行
 * ------------------------------------------------------------------ */

/** 只取目标定位字段（match / tabId / browser）。 */
function tabTarget(a) {
  const out = {};
  if (typeof a.match === 'string' && a.match) { out.match = a.match; }
  if (typeof a.tabId === 'number') { out.tabId = a.tabId; }
  if (typeof a.browser === 'string' && a.browser) { out.browser = a.browser; }
  return out;
}

/** 目标定位字段 + frameId（页面类动作）。 */
function pageTarget(a) {
  const out = tabTarget(a);
  if (typeof a.url === 'string' && a.url) { out.url = a.url; }
  if (typeof a.frameId === 'number') { out.frameId = a.frameId; }
  return out;
}

/** 把工具名映射到一次桥接调用。返回值直接作为工具结果。 */
const HANDLERS = {
  async browser_list_tabs(a) {
    const d = await ab.tabs({ browser: a.browser });
    return text(`${d.tabs.length} 个标签页：\n` + d.tabs.map((t) => {
      const flags = [t.active ? '激活' : '后台', t.discarded ? '已休眠' : null].filter(Boolean).join('/');
      return `[${t.id}] (${flags}) ${t.title}\n      ${t.url}`;
    }).join('\n'));
  },

  async browser_read_page(a) {
    const d = await ab.read({
      ...pageTarget(a),
      selector: a.selector,
      includeLinks: !!a.includeLinks,
      returnHtml: !!a.returnHtml,
      format: a.format,
      autoActivate: !!a.autoActivate,
      lease: !!a.lease
    });
    const head = `标题: ${d.title}\nURL: ${d.url}\n标签页: ${d.tabId}${d.wasActive ? '（激活）' : '（后台）'}`
      + `  框架: ${d.frameId}  正文容器: ${d.usedSelector}  字符数: ${d.charCount}`;
    const parts = [head, '---', d.text || '(空)'];
    if (Array.isArray(d.links) && d.links.length) {
      parts.push('--- 链接 ---', d.links.map((l) => `${l.text}  ->  ${l.href}`).join('\n'));
    }
    if (d.html) {
      parts.push(`--- HTML${d.htmlTruncated ? '（已截断）' : ''} ---`, d.html);
    }
    if (Array.isArray(d.contentEditables) && d.contentEditables.length) {
      parts.push('--- 可编辑区域 ---', d.contentEditables.map((c) => {
        const sel = [c.tag, c.id ? '#' + c.id : '', c.className ? '.' + c.className.split(/\s+/).join('.') : '']
          .join('').slice(0, 160);
        return `[${c.index}] ${sel}  ${c.ariaLabel || ''}  ${c.visible ? '可见' : '隐藏'}  ${c.textLength} 字`
          + `${c.designMode ? '  (designMode)' : ''}`;
      }).join('\n'));
    }
    return text(parts.join('\n'));
  },

  async browser_get_links(a) {
    const d = await ab.links({
      ...pageTarget(a),
      selector: a.selector,
      text: a.text
    });
    if (!d.links.length) { return text(`没有链接（容器: ${d.usedSelector}）。`); }
    return text(`${d.links.length} 个链接：\n` + d.links.map((l) =>
      `[${l.index}] ${l.visible ? ' ' : '隐'} ${l.text.slice(0, 120)}\n      ${l.href}`).join('\n'));
  },

  async browser_navigate(a) {
    const d = await ab.navigate({
      ...tabTarget(a),
      url: a.url,
      newTab: !!a.newTab,
      active: !!a.active,
      waitMs: a.waitMs
    });
    return text(`已导航: ${d.url}\n标签页: ${d.tabId}`
      + `${d.openedNewTab ? '（后台新建）' : d.wasActive ? '（当前激活）' : '（后台）'}`
      + `${d.redirected ? '\n（发生了重定向，上面是最终地址）' : ''}`
      + `${d.waitTimedOut ? '\n（等待地址变更超时，页面可能仍在加载）' : ''}`);
  },

  async browser_batch(a) {
    if (!Array.isArray(a.steps) || a.steps.length === 0) {
      return errorText('需要 steps 数组。');
    }
    const d = await ab.batch(a.steps, { continueOnError: a.continueOnError });
    const lines = (d.results || []).map((r) => {
      const mark = r.ok ? 'ok  ' : 'FAIL';
      return `  ${mark}  步骤 ${r.step}  ${r.action}  ${r.ok ? '' : r.error || ''}`;
    });
    return text(`批量执行完成（${(d.results || []).length} 步）:\n` + lines.join('\n'));
  },

  async browser_click(a) {
    const d = await ab.click({
      ...pageTarget(a),
      selector: a.selector,
      text: a.text,
      href: a.href,
      index: typeof a.index === 'number' ? a.index : 0,
      allowNonLink: !!a.force,
      dryRun: !!a.dryRun
    });
    if (d.dryRun) {
      const w = d.wouldClick || {};
      return text(`试运行（未点击）：匹配 ${d.matched} 个元素。\n`
        + `会点到: <${w.tag}> ${JSON.stringify(w.text || '')}`
        + `${w.href ? '\n链接: ' + w.href : ''}\n`
        + `是否链接: ${w.isLink}  按钮类: ${w.isButtonLike}  破坏性文案: ${w.destructive}\n`
        + `${w.blocked ? '不传 force 会被拦下。' : '不传 force 也会执行。'}`);
    }
    return text(`已点击: ${d.clicked.text}\n`
      + `${d.clicked.href ? '链接: ' + d.clicked.href + '\n' : ''}`
      + `标签页: ${d.tabId}${d.wasActive ? '（激活）' : '（后台）'}  框架: ${d.frameId}\n`
      + `跳转: ${d.navigated ? '是' : '否'}${d.urlAfter ? '  当前: ' + d.urlAfter : ''}`
      + `${d.openedTabs && d.openedTabs.length ? '\n新开标签页: ' + d.openedTabs.map((t) => `[${t.id}] ${t.url}`).join(' ') : ''}`);
  },

  async browser_type(a) {
    const d = await ab.type({
      ...pageTarget(a),
      selector: a.selector,
      text: a.text,
      value: a.value,
      method: a.method === 'html' ? 'html' : 'text',
      clear: !!a.clear,
      allowNonInput: !!a.force
    });
    return text(`已写入 <${d.tag}>（定位方式 ${d.how}，框架 ${d.frameId}）\n`
      + `字符数 ${d.beforeLength} -> ${d.afterLength}，execCommand: ${d.usedExecCommand ? '是' : '否'}\n`
      + `预览: ${d.preview}\n`
      + `注意：只写入了内容，没有提交。`);
  },

  async browser_press_key(a) {
    const d = await ab.key({
      ...pageTarget(a),
      key: a.key,
      selector: a.selector,
      ctrl: !!a.ctrl,
      shift: !!a.shift,
      alt: !!a.alt,
      meta: !!a.meta
    });
    return text(`已派发 ${d.key}（keyCode ${d.keyCode}）到 <${d.target}>，框架 ${d.frameId}。\n`
      + `页面是否取消该事件: ${d.notCancelled ? '否' : '是'}`);
  },

  async browser_wait_for(a) {
    if (!a.selector && !a.text && !a.url && !a.idleMs) {
      return errorText('需要 selector、text、url 或 idleMs 之一作为等待条件。');
    }
    const d = await ab.wait({
      ...pageTarget(a),
      selector: a.selector,
      text: a.text,
      url: a.url,
      count: a.count,
      idleMs: a.idleMs,
      state: a.state === 'disappear' ? 'disappear' : 'appear',
      timeoutMs: a.timeoutMs
    });
    return text(`条件已成立（等待 ${d.elapsedMs}ms，标签页 ${d.tabId}，框架 ${d.frameId}）。`);
  },

  async browser_screenshot(a) {
    const d = await ab.screenshot({
      ...pageTarget(a),
      selector: a.selector,
      full: !!a.full,
      format: a.format
    });
    const meta = `标签页 ${d.tabId}  ${d.width || '?'}x${d.height || '?'}  ${d.format}  方式 ${d.via}`
      + `${d.selector ? '  元素 ' + d.selector : ''}${d.fullPage ? '  整页' : ''}`;
    const base64 = String(d.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    if (!base64) { return text(meta + '\n（没有拿到图像数据）'); }
    if (base64.length > IMAGE_MAX_BYTES) {
      return text(`${meta}\n图像约 ${(base64.length / 1024 / 1024).toFixed(1)}MB，太大，未返回。`
        + '请改用 selector 只截需要的元素，或 full=false 只截可视区域。');
    }
    return {
      content: [
        { type: 'text', text: meta },
        { type: 'image', data: base64, mimeType: d.format === 'jpeg' ? 'image/jpeg' : 'image/png' }
      ]
    };
  },

  async browser_eval(a) {
    const d = await ab.evalPage({ ...pageTarget(a), code: a.code });
    if (d.truncated) {
      return text(`结果过大已截断（框架 ${d.frameId}）：\n${d.json}`);
    }
    const v = d.value;
    return text(`框架 ${d.frameId}  标签页 ${d.tabId}:\n`
      + (typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
  },

  async browser_frames(a) {
    const d = await ab.frames({ ...tabTarget(a) });
    if (!d.frames.length) { return text('没有取到任何框架。'); }
    return text(`${d.title}\n${d.url}\n共 ${d.frameCount} 个框架：\n` + d.frames.map((f) => {
      if (!f.info) { return `[frameId=${f.frameId}] 注入失败: ${f.error}`; }
      const i = f.info;
      return `[frameId=${f.frameId}] ${i.isMainFrame ? '主框架' : '子框架'}  ${i.title}\n`
        + `    ${i.href}\n`
        + `    designMode=${i.designMode}  body可编辑=${i.bodyIsContentEditable}`
        + `${i.bodyEditableByDesignMode ? '（designMode）' : ''}`
        + `  contenteditable元素=${i.editableAttrCount}  role=textbox=${i.textboxRoleCount}  输入框=${i.inputCount}\n`
        + `    正文长度=${i.bodyTextLength}  子框架=${i.iframeCount}`;
    }).join('\n'));
  },

  async browser_save_file(a) {
    // 下载被中断时桥接返回 ok:false + error:interrupted，会由 callTool 的
    // BridgeError 分支统一翻译，这里只处理成功的返回。
    const d = await ab.save({
      ...tabTarget(a),
      url: a.url,
      filename: a.filename,
      overwrite: !!a.overwrite,
      waitMs: a.waitMs
    });
    return text(`已保存: ${d.filename || '(等待中)'}\n`
      + `来源: ${d.url}\n状态: ${d.done ? '已完成' : d.state}`
      + `${d.bytes ? `  大小 ${(d.bytes / 1024).toFixed(1)} KB` : ''}`);
  },

  async browser_upload_file(a) {
    const d = await ab.upload({
      ...tabTarget(a),
      selector: a.selector,
      files: a.files
    });
    return text(`已选择文件: ${(d.files || []).join(', ')}\n填入 ${d.selector}（标签页 ${d.tabId}）\n`
      + `注意：只是选择了文件，提交表单仍需另外点击。`);
  },

  async browser_session(a) {
    const d = await ab.session({
      ...tabTarget(a),
      name: a.name,
      key: a.key,
      storage: a.storage
    });
    const parts = [`标签页 ${d.tabId}  ${d.url}`];
    if (d.cookies) {
      parts.push(`--- Cookie（${d.cookies.length} 个）---`);
      parts.push(d.cookies.map((c) => `${c.name} = ${c.value}${c.httpOnly ? '  [httpOnly]' : ''}`
        + `${c.domain ? '  @' + c.domain : ''}`).join('\n'));
    }
    if (d.storage) {
      for (const name of ['localStorage', 'sessionStorage']) {
        const store = d.storage[name];
        if (!store) { continue; }
        const keys = Object.keys(store);
        parts.push(`--- ${name}（${keys.length} 项）---`);
        parts.push(keys.map((k) => `${k} = ${String(store[k]).slice(0, 300)}`).join('\n'));
      }
    }
    if (d.cookiesError) { parts.push(`Cookie 读取失败: ${d.cookiesError}`); }
    if (d.storageError) { parts.push(`本地存储读取失败: ${d.storageError}`); }
    return text(parts.join('\n'));
  },

  async browser_close_tab(a) {
    const d = await ab.close({ tabId: a.tabId });
    return text(`已关闭: ${d.closedTitle}\n原地址: ${d.closedUrl}`);
  },

  async browser_clear_marks() {
    const d = await ab.unmark({});
    const per = (d.browsers || []).map((b) => `${b.browser}: ${b.ok ? '已清理 ' + b.cleared.length + ' 个' : '失败 ' + b.error}`);
    return text(`已清除标记 ${d.cleared.length} 个标签页: ${d.cleared.join(', ') || '（无）'}`
      + (per.length ? '\n' + per.join('\n') : ''));
  },

  async browser_status() {
    const h = await ab.health();
    const lines = [
      `桥接服务: 在线（apiVersion ${h.apiVersion}）`,
      `在线的浏览器: ${(h.browsers || []).join(', ') || '（无）'}`,
      `扩展连接: ${h.extensionConnected ? '是' : '否'}`,
      `待下发任务: ${h.pendingTasks}   队列: ${h.queuedTasks}`,
      `允许的扩展 id: ${(h.allowedExtensionIds || []).join(', ') || '（未上报）'}`
    ];
    try {
      const d = await ab.diag({});
      lines.push(`扩展版本: ${d.version}   扩展 id: ${d.extensionId || '（未上报）'}`);
      lines.push(`轮询循环: ${d.loopRunning ? '运行中' : '未运行'}`);
      lines.push(`已标记标签页: ${(d.markedTabs || []).length} 个`);
      lines.push(`错误条数: ${d.errorCount || 0}`);
      for (const e of (d.errors || []).slice(-5)) {
        lines.push(`  [${e.where}] ${String(e.msg).slice(0, 200)}`);
      }
    } catch (e) {
      lines.push(`扩展诊断读取失败: ${e.code || e.message}`);
    }
    return text(lines.join('\n'));
  }
};

function text(t) {
  return { content: [{ type: 'text', text: String(t) }] };
}

function errorText(t) {
  return { content: [{ type: 'text', text: String(t) }], isError: true };
}

/** 调用工具，把桥接的错误码翻译成模型能照着做的提示。 */
async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) { return errorText(`未知工具: ${name}`); }

  try {
    return await handler(args || {});
  } catch (e) {
    if (e instanceof BridgeError) {
      return errorText(`${e.code}${e.detail && e.detail.hint ? ': ' + e.detail.hint : ''}\n`
        + JSON.stringify(e.detail, null, 2).slice(0, 1500));
    }
    if (e instanceof BridgeUnavailableError) {
      // 桥接可能在会话中途被关掉，这里给它一次重新起来的机会
      try {
        await ensureBridge();
        return await handler(args || {});
      } catch (e2) {
        return errorText(`桥接服务不可用: ${e2.message}`);
      }
    }
    return errorText(`执行失败: ${e && e.message ? e.message : String(e)}`);
  }
}

/* ------------------------------------------------------------------ *
 * MCP stdio 传输
 * ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  // 通知（没有 id）不需要回应
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id');

  if (msg.method === 'initialize') {
    const asked = msg.params && msg.params.protocolVersion;
    sendResult(msg.id, {
      protocolVersion: typeof asked === 'string' && asked ? asked : FALLBACK_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS
    });
    return;
  }

  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
    return;
  }

  if (msg.method === 'ping') {
    if (isRequest) { sendResult(msg.id, {}); }
    return;
  }

  if (msg.method === 'tools/list') {
    sendResult(msg.id, { tools: TOOLS });
    return;
  }

  if (msg.method === 'tools/call') {
    const p = msg.params || {};
    if (!p.name) {
      sendError(msg.id, -32602, '缺少 params.name');
      return;
    }
    const result = await callTool(p.name, p.arguments);
    sendResult(msg.id, result);
    return;
  }

  if (isRequest) {
    sendError(msg.id, -32601, `不支持的方法: ${msg.method}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list-tools')) {
    console.log(`${TOOLS.length} 个工具：`);
    for (const t of TOOLS) {
      const req = (t.inputSchema.required || []).join(', ');
      console.log(`  ${t.name}${req ? '  (必填: ' + req + ')' : ''}`);
      console.log(`      ${t.description.split('\n')[0].slice(0, 140)}`);
    }
    return;
  }

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) { continue; }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        sendError(null, -32700, 'JSON 解析失败');
        continue;
      }
      handleMessage(msg).catch((e) => {
        log('处理消息出错', e && e.stack ? e.stack : e);
        if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
          sendError(msg.id, -32603, String(e && e.message ? e.message : e));
        }
      });
    }
  });

  process.stdin.on('end', () => process.exit(0));

  // 未处理的异常不能让进程带着半截协议状态死掉，记到 stderr 供排查
  process.on('unhandledRejection', (e) => log('未处理的拒绝', e && e.stack ? e.stack : e));
  process.on('uncaughtException', (e) => log('未捕获异常', e && e.stack ? e.stack : e));

  // 启动时就把桥接准备好，别让第一次工具调用承担这个延迟
  ensureBridge().catch((e) => {
    log('桥接服务不可用：' + (e && e.message ? e.message : e));
    log('工具仍会列出，但调用会返回明确错误。');
  });

  log(`已启动（v${SERVER_VERSION}，${TOOLS.length} 个工具）`);
}

main();
