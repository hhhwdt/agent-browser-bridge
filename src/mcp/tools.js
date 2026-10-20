/**
 * 工具定义：入参 schema、目标定位与 initialize 说明。
 */

'use strict';

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

module.exports = {
  TAB_TARGET, PAGE_TARGET, TARGET_NOTE, tabTarget, pageTarget, TOOLS, INSTRUCTIONS
};
