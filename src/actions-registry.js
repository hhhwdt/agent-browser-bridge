/**
 * Agent Browser Bridge —— 动作注册表（单一事实来源）。
 *
 * 一个动作的"名字、HTTP 路径、参数与类型、校验规则、默认超时、MCP 工具名与 schema"
 * 此前散在四处（server 路由、mcp/tools.js、cli 参数表、扩展端动作函数），改一处漏四处。
 * 本文件把前三个收拢到一起；扩展端是浏览器 ESM，无法共享 CJS 文件，动作名靠
 * test/test-registry.js 与这里对齐——漂移会在离线测试里炸，而不是上线后炸。
 *
 * 消费方：
 *   - src/server/routes/generic.js  校验与任务组装按 ACTIONS 的规则执行
 *   - src/mcp/tools.js              工具 schema 从 ACTIONS 生成
 *   - src/cli/args.js               取值选项白名单从 CLI_VALUE_OPTS 取并集
 *   - test/test-registry.js         注册表 ↔ 扩展动作函数 ↔ 路由表 三方一致性
 *
 * 纯数据 + 纯函数：不依赖任何 server / client 模块，保证被任何一侧 require 都安全。
 */

'use strict';

/* ------------------------------------------------------------------ *
 * MCP schema 的目标定位字段（工具描述共用这几段文案）。
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 参数形态的简写与说明
 * ------------------------------------------------------------------ *
 * 任务字段从请求体里怎么取（generic.js 执行）：
 *   'raw'    原样传入
 *   'bool'   !!value
 *   'number' 仅接受数值，否则不给任务带这个键
 *   { values: [...], default } 枚举：不在清单里时用默认值
 *   { waitBudget: N }  clampTimeout(body.timeoutMs, N)——wait 的等待预算，
 *                      它同时也是派发超时的基准，所以作为独立形态标注
 */

const R = 'raw';
const B = 'bool';
const N = 'number';

/* 校验规则的公共写法：target = match/url/tabId 三选一，缺失报 missing_target。 */
const TARGET = { target: true };

/* ------------------------------------------------------------------ *
 * 动作表
 * ------------------------------------------------------------------ *
 * 每个条目：
 *   path       HTTP 路径
 *   target     任务的目标定位字段：'page'（browser/match/url/tabId）、
 *              'close'（browser/tabId）、'mark'（match/url/tabId，browser 由路由补）、
 *              'diag'（仅 browser）、'query'（GET，browser 从 query 取）
 *   body       'json'（默认，readJsonBody）| 'raw'（readBody 失败按 {} 论）| 'none'（GET）
 *   offline    是否先查扩展在线（少数路由历史上不查，靠 dispatch 兜底回错，保持原语义）
 *   params     目标之外的参数：{ 键: 取值形态 }
 *   checks     校验规则数组，按序执行，任一命中即回 400
 *   timeout    null  clampTimeout(body.timeoutMs)（默认上限）
 *              数字  clampTimeout(body.timeoutMs, 数字, maxTimeout)
 *              'wait' 特例：任务里的 timeoutMs 是等待预算，派发超时 = 预算 + 5000
 *              'once' /tabs 用的固定 READ_TIMEOUT_MS
 *   maxTimeout 派发超时的独立上限（省略 120 秒）。标称默认值超过默认上限的
 *              长动作必须登记，否则默认值会被默认上限悄悄截断（见 grab）
 *   mcp        对应的 MCP 工具名（省略 = 无工具）
 *   mcpTarget / mcpParams / mcpRequired / mcpSchema / mcpDescription
 *              schema 生成用的元数据，文案与原来逐字一致
 *   bespoke    路由是手写的（generic.js 只生成直排动作），仅登记元数据
 */
const ACTIONS = {
  read: {
    path: '/read',
    target: 'page',
    offline: true,
    params: { frameId: N, selector: R, includeLinks: B, returnHtml: B, format: R, autoActivate: B, lease: B },
    checks: [TARGET],
    mcp: 'browser_read_page',
    mcpTarget: 'page',
    mcpParams: {
      selector: { type: 'string', description: '只读这个 CSS 选择器命中的元素，省略则自动挑正文容器。' },
      includeLinks: { type: 'boolean', description: '同时返回正文里的链接列表。' },
      returnHtml: { type: 'boolean', description: '额外返回 outerHTML 与可编辑区域清单，用于定位选择器。' },
      format: { type: 'string', enum: ['text', 'markdown'], description: '默认 text；markdown 返回 Markdown 格式正文。' },
      autoActivate: { type: 'boolean', description: '遇到冻结标签页时先 activate 唤醒再重试一次。' },
      lease: { type: 'boolean', description: '获取标签页独占锁，防止其他 caller 同时操作同一标签页。' }
    },
    mcpDescription: '读取标签页的正文文字。后台标签页也能读，不会切换标签、不抢焦点。'
      + '返回里带 usedSelector 说明正文是从哪个容器取的；读不到内容时用 returnHtml=true '
      + '拿到结构信息再决定 selector。'
  },

  links: {
    path: '/links',
    target: 'page',
    offline: true,
    params: { frameId: N, selector: R, text: R },
    checks: [TARGET],
    mcp: 'browser_get_links',
    mcpTarget: 'page',
    mcpParams: {
      text: { type: 'string', description: '只返回文字里包含该子串的链接。' },
      selector: { type: 'string', description: '限定在某个容器内枚举。' }
    },
    mcpDescription: '枚举页面里的链接（文字 + 绝对地址 + 是否可见）。'
      + '需要点进某个关联页面时先用它拿到链接，再交给用户或 browser_click。'
  },

  screenshot: {
    path: '/screenshot',
    target: 'page',
    offline: true,
    params: { frameId: N, format: R, selector: R, full: B },
    checks: [TARGET],
    timeout: 30000,
    mcp: 'browser_screenshot',
    mcpTarget: 'page',
    mcpParams: {
      selector: { type: 'string', description: '只截这个元素。' },
      full: { type: 'boolean', description: '截整页（含滚动区域）。' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: '默认 png。' }
    },
    mcpDescription: '截取标签页画面并直接返回图片。后台标签页也能截，不切标签。'
      + '按 selector 只截某个元素、full=true 截整页。页面很长时优先用 selector，'
      + '整页截图过大时不会返回图片，只给尺寸和提示。'
  },

  eval: {
    path: '/eval',
    target: 'page',
    offline: true,
    params: { frameId: N, code: R },
    checks: [
      TARGET,
      {
        nonEmptyStr: 'code',
        error: 'missing_code',
        hint: '需要提供要执行的 JS 代码，用 return 返回结果，例如 --code "return document.title"'
      }
    ],
    mcp: 'browser_eval',
    mcpTarget: 'page',
    mcpParams: { code: { type: 'string', description: '要执行的 JS。用 return 返回结果。' } },
    mcpRequired: ['code'],
    mcpDescription: '在页面主世界执行一段 JS 并取回结果，用于量尺寸、读计算样式、'
      + '或从页面数据里取现成工具拿不到的东西。代码只执行一次。'
      + '用 return 返回结果（例如 "return document.title"），也支持直接写表达式。'
      + '这是强原语：不要用它绕过上面这些工具的安全限制去改页面状态。'
  },

  session: {
    path: '/session',
    target: 'page',
    offline: true,
    params: { name: R, key: R, local: R, session: R, storage: R },
    checks: [TARGET],
    timeout: 15000,
    mcp: 'browser_session',
    mcpTarget: 'tab',
    mcpParams: {
      name: { type: 'string', description: '只取这个名称的 Cookie。' },
      key: { type: 'string', description: '只取这个存储键。' },
      storage: { type: 'boolean', description: 'false 表示只取 Cookie，不读本地存储。' }
    },
    mcpDescription: '读取该标签页的登录态：Cookie（含 httpOnly）与 localStorage / sessionStorage。'
      + '需要用户先在扩展弹窗里授予可选的 cookies 权限，否则返回 permission_not_granted。'
      + '只在任务确实需要时调用，不要把结果直接贴给用户之外的任何地方。'
  },

  frames: {
    path: '/frames',
    target: 'page',
    params: {},
    checks: [],
    mcp: 'browser_frames',
    mcpTarget: 'tab',
    mcpDescription: '列出标签页内所有框架及其状态（是否可编辑、正文长度、designMode）。'
      + '读不到正文、或写不进富文本编辑器时，用它找出目标在哪个 frameId。'
  },

  media: {
    path: '/media',
    target: 'page',
    params: { frameId: R, minImageSize: R, maxScanChars: R },
    checks: [TARGET],
    timeout: 45000
  },

  tabs: {
    path: '/tabs',
    method: 'GET',
    target: 'query',
    body: 'none',
    checks: [],
    timeout: 'once',
    mcp: 'browser_list_tabs',
    mcpSchema: {
      type: 'object',
      properties: { browser: TAB_TARGET.browser },
      additionalProperties: false
    },
    mcpDescription: '列出浏览器当前打开的所有标签页（id、标题、URL、是否后台、是否已休眠）。'
      + '开始任何操作前先调它，拿到 tabId 和 URL，不要凭猜测去 match。'
  },

  download: {
    path: '/download',
    target: 'page',
    offline: true,
    params: { maxBytes: R, headers: R },
    checks: [TARGET, { truthy: 'url', error: 'missing_url', hint: '用 --url 指定要下载的地址' }],
    timeout: 60000
  },

  grab: {
    path: '/grab',
    target: 'page',
    params: { filename: R, timeoutMs: N, waitMs: N },
    checks: [
      { truthy: 'url', error: 'missing_url', hint: '需要提供 url' },
      // 与其他动作不同：grab 的"标签页定位"只认 match 或 tabId（在哪个标签页内取流）
      { grabTarget: '需要提供 match 或 tabId，用于指定在哪个标签页内取流' }
    ],
    timeout: 190000,
    // 标称默认预算超过 120 秒默认上限的动作，必须显式声明自己的上限，否则
    // clampTimeout 会把 190000 截成 120000——调用方先收到 timeout，扩展还在抓，
    // 又是"干完了却报超时"。上限取标称值向上留一档：单调用最长等 5 分钟。
    maxTimeout: 300000
  },

  save: {
    path: '/save',
    target: 'page',
    params: { filename: R, saveAs: B, overwrite: B, waitMs: N },
    checks: [{ truthy: 'url', error: 'missing_url', hint: '需要提供 url' }],
    timeout: 60000,
    mcp: 'browser_save_file',
    mcpTarget: 'tab',
    mcpParams: {
      url: { type: 'string', description: '要保存的地址，支持相对地址（按标签页 URL 解析）。' },
      filename: { type: 'string', description: '文件名或下载目录下的相对路径。' },
      overwrite: { type: 'boolean', description: '同名时覆盖，默认自动改名。' },
      waitMs: { type: 'number', description: '等待落盘的最长时间，默认 30000。' }
    },
    mcpRequired: ['url'],
    mcpDescription: '用浏览器自己的下载栈把一个地址存到磁盘（不受 CORS 限制，也能用上登录态）。'
      + '落点是浏览器的下载目录，filename 只能是其下的相对路径。返回真实落盘路径。'
  },

  upload: {
    path: '/upload',
    target: 'page',
    offline: true,
    params: { selector: R, files: R },
    checks: [TARGET],
    timeout: 30000,
    mcp: 'browser_upload_file',
    mcpTarget: 'tab',
    mcpParams: {
      files: { type: 'array', items: { type: 'string' }, description: '本地文件的绝对路径。' },
      selector: { type: 'string', description: 'file input 的选择器，默认 input[type=file]。' }
    },
    mcpRequired: ['files'],
    mcpDescription: '把本地文件塞进页面的文件选择框（走浏览器调试协议）。'
      + '目标标签页不能开着 DevTools。用完后浏览器顶部会出现过的调试提示条会自动消失。'
  },

  click: {
    path: '/click',
    target: 'page',
    offline: true,
    params: {
      frameId: N, selector: R, text: R, href: R, index: R,
      allowNonLink: B, dryRun: B
    },
    checks: [
      TARGET,
      {
        any: ['selector', 'text', 'href'],
        error: 'missing_click_target',
        hint: '需要提供 selector、text 或 href 之一来定位要点击的元素'
      }
    ],
    // 点击可能触发页面跳转，给稍长的等待时间
    timeout: 45000,
    mcp: 'browser_click',
    mcpTarget: 'page',
    mcpParams: {
      selector: { type: 'string', description: 'CSS 选择器。' },
      text: { type: 'string', description: '按可见文字定位（优先命中链接，其次文字最短的元素）。' },
      href: { type: 'string', description: '按 href 片段定位链接。' },
      index: { type: 'number', description: '多个匹配时取第几个，从 0 开始。先用 dryRun 看清匹配数。' },
      force: { type: 'boolean', description: '允许点击非链接元素、以及绕过破坏性文案拦截。谨慎使用。' },
      dryRun: { type: 'boolean', description: '只回报会点到什么，不执行。' }
    },
    mcpDescription: '点击元素。默认只允许点击链接；按钮等非链接元素会按文案风险分级——'
      + '「编辑/插入/取消」这类直接放行，「删除/提交/发布/保存」这类会被拦下，'
      + '需要 force=true 才执行。force 只在该具体动作已获得用户确认时才传。'
      + '不确定会点到什么就先 dryRun=true，它只回报判定结果，不真的点。'
  },

  type: {
    path: '/type',
    target: 'page',
    offline: true,
    params: {
      frameId: N, selector: R, value: R,
      // 富文本编辑器可按 html 写入，会先清洗危险内容
      method: { values: ['html', 'text'], default: 'text' },
      clear: B,
      allowNonInput: B
    },
    checks: [
      TARGET,
      { str: 'value', error: 'missing_value', hint: '需要提供 value（要输入的文本）' }
    ],
    mcp: 'browser_type',
    mcpTarget: 'page',
    mcpParams: {
      value: { type: 'string', description: '要写入的文字。' },
      selector: { type: 'string', description: '目标 CSS 选择器。' },
      text: { type: 'string', description: '按字段名/占位符/aria-label 定位输入框。' },
      clear: { type: 'boolean', description: '先清空原有内容。清空富文本编辑器正文属高风险，确认后再用。' },
      method: { type: 'string', enum: ['text', 'html'], description: 'html 会先清洗掉 script/iframe/on* 事件。' },
      force: { type: 'boolean', description: '允许写入非可编辑元素。谨慎使用。' }
    },
    mcpRequired: ['value'],
    mcpDescription: '向输入框、文本域或可编辑区域写入文字。富文本编辑器（Confluence 等）内部走 execCommand，'
      + '编辑器能正确同步。默认只写可编辑元素，写其他元素需要 force=true。'
      + '只把内容放进编辑器，不会提交——提交要另外调 browser_click。'
  },

  key: {
    path: '/key',
    target: 'page',
    offline: true,
    params: { frameId: N, key: R, selector: R, ctrl: B, shift: B, alt: B, meta: B },
    checks: [TARGET, { truthy: 'key', error: 'missing_key' }],
    mcp: 'browser_press_key',
    mcpTarget: 'page',
    mcpParams: {
      key: { type: 'string', description: '键名，如 Enter / Tab / Escape / ArrowDown。' },
      selector: { type: 'string', description: '按键前先聚焦的元素。' },
      ctrl: { type: 'boolean' },
      shift: { type: 'boolean' },
      alt: { type: 'boolean' },
      meta: { type: 'boolean' }
    },
    mcpRequired: ['key'],
    mcpDescription: '派发按键（Enter / Tab / Escape / 方向键等）。派发的是合成事件，'
      + '只触发页面内的 JS 处理器，不产生文本、也不会触发浏览器级快捷键。要输入文字用 browser_type。'
  },

  navigate: {
    path: '/navigate',
    target: 'page',
    offline: true,
    params: { frameId: N, newTab: B, active: B, waitMs: N },
    checks: [{ truthy: 'url', error: 'missing_url' }],
    mcp: 'browser_navigate',
    mcpTarget: 'tab',
    mcpParams: {
      url: { type: 'string', description: '目标地址（必填，只支持 http/https）。' },
      newTab: { type: 'boolean', description: '强制新建标签页。' },
      active: { type: 'boolean', description: '新建时是否置于前台。默认 false，不要随便开启。' },
      waitMs: { type: 'number', description: '等待地址真正变更的最长时间，默认 10000。' }
    },
    mcpRequired: ['url'],
    mcpDescription: '导航到某个地址。默认后台新建标签页，不影响用户当前视图。'
      + '不指定 match/tabId 时会新建标签页。要复用已有标签页就传 match 或 tabId。'
  },

  wait: {
    path: '/wait',
    target: 'page',
    offline: true,
    params: {
      frameId: N, selector: R, text: R, count: N, idleMs: N,
      state: { values: ['disappear', 'appear'], default: 'appear' },
      // 任务里的 timeoutMs 是等待预算，派发超时再在它之上加 5 秒余量
      timeoutMs: { waitBudget: 10000 },
      pollMs: R
    },
    checks: [
      TARGET,
      {
        any: ['selector', 'text', 'url', 'idleMs'],
        error: 'missing_condition',
        hint: '需要提供 selector、text、url 或 idleMs 作为等待条件'
      }
    ],
    timeout: 'wait',
    mcp: 'browser_wait_for',
    mcpTarget: 'page',
    // 模式里 url 的身份是等待条件，覆盖 target 字段那份描述
    mcpParams: {
      selector: { type: 'string', description: '等待这个选择器命中的元素出现/消失。' },
      text: { type: 'string', description: '等待正文里出现这段文字。' },
      url: { type: 'string', description: '等待 location.href 包含这个子串（SPA 路由变化）。' },
      count: { type: 'number', description: '等待 selector 命中的元素数量达到 n（需同时提供 selector）。' },
      idleMs: { type: 'number', description: '等待网络空闲：资源请求数在 N 毫秒内不再增长。' },
      state: { type: 'string', enum: ['appear', 'disappear'], description: '默认 appear。' },
      timeoutMs: { type: 'number', description: '超时毫秒数，默认 10000。' }
    },
    mcpDescription: '等某个元素出现或消失、等某段文字出现、等 URL 包含某子串、等元素数量达标、或等网络空闲。'
      + '页面异步刷新（对话框、列表、编辑器加载）之后必须用它，否则下一步会随机失败。'
      + 'state=disappear 用于等加载动画消失。'
  },

  close: {
    path: '/close',
    target: 'close',
    checks: [{
      number: 'tabId',
      error: 'missing_tab_id',
      hint: '关闭标签页必须显式提供 tabId，不支持按 match 批量关闭'
    }],
    mcp: 'browser_close_tab',
    mcpParams: { tabId: { type: 'number', description: '要关闭的标签页 id。' } },
    mcpRequired: ['tabId'],
    mcpDescription: '关闭标签页。必须给 tabId——不支持按 match 批量关闭，避免误关用户正在看的页面。'
      + '只关你自己开的标签页；用户自己打开的页面除非他明确要求，不要动。'
  },

  activate: {
    path: '/activate',
    target: 'page',
    body: 'raw',
    checks: []
  },

  mark: {
    path: '/mark',
    target: 'mark',
    params: { frameId: N, text: R, color: R, ttlMs: N, all: B },
    checks: [],
    bespoke: true
  },

  unmark: {
    path: '/unmark',
    target: 'mark',
    params: { frameId: N, text: R, color: R, ttlMs: N, all: B },
    checks: [],
    bespoke: true,
    mcp: 'browser_clear_marks',
    mcpSchema: { type: 'object', properties: {}, additionalProperties: false },
    mcpDescription: '清除所有浏览器里所有标签页的操作标记（标题前缀 🤖、图标圆点、徽标）。'
      + '任务收尾时调用——标记是给用户看"这些页面被 agent 动过"的，用完不清会一直留着。'
  },

  batch: {
    path: '/batch',
    bespoke: true,
    mcp: 'browser_batch',
    mcpSchema: {
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
    },
    mcpDescription: '批量执行多个动作，按顺序执行，每步独立返回结果。'
      + '第一步失败时停止（除非 continueOnError=true）。'
      + '每个步骤保持自己的语义：破坏性 click 仍需 force，type 仍不提交。'
  },

  diag: {
    path: '/diag',
    target: 'diag',
    body: 'raw',
    checks: [],
    timeout: 10000
  },

  reload: {
    path: '/reload',
    bespoke: true
  },

  health: {
    path: '/health',
    method: 'GET',
    bespoke: true,
    mcp: 'browser_status',
    mcpSchema: { type: 'object', properties: {}, additionalProperties: false },
    mcpDescription: '桥接与扩展的运行状态：在线浏览器、扩展版本与 id、最近错误。'
      + '任何工具报扩展未连接时先调它。'
  },

  /* ---------------------------------------------------------------- *
   * computer 动作族（Windows 桌面控制，本地执行，不经扩展）。
   * 路由在 src/server/routes/computer.js，执行在 src/computer/。
   * 门禁：shell 白名单外 / window close / process kill / clipboard write
   * 需要 force=true，其余放行（见 computer/index.js 的 gateDeny）。
   * 无 maxTimeout 时标称超时必须 ≤ 120000（见 test-registry [8]）。
   * ---------------------------------------------------------------- */
  computerScreen: {
    path: '/computer/screen',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_screen',
    mcpParams: {
      windowTitle: { type: 'string', description: '只截标题包含该子串的窗口（PrintWindow，后台窗口也能截）。' },
      hwnd: { type: 'number', description: '按句柄截窗口，比标题稳定；来自 computer_windows 的 hwnd。' },
      region: {
        type: 'object',
        description: '只截虚拟桌面上的一个矩形区域。',
        properties: {
          x: { type: 'number', description: '左上角 x' },
          y: { type: 'number', description: '左上角 y' },
          w: { type: 'number', description: '宽' },
          h: { type: 'number', description: '高' }
        },
        additionalProperties: false
      }
    },
    mcpDescription: '截取整个桌面画面并直接返回图片（多显示器覆盖整个虚拟桌面）。'
      + '给窗口Title时只截该窗口（后台窗口也能截）。动手点击前先用它看清楚屏幕。'
  },

  computerWindows: {
    path: '/computer/windows',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_windows',
    mcpParams: {},
    mcpDescription: '列出所有可见顶层窗口：标题、进程名、pid、位置尺寸、最小化/最大化状态。'
      + '先列清单再决定操作哪个窗口；返回里的 index 可直接给 computer_window / 点击定位。'
  },

  computerWindow: {
    path: '/computer/window',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_window',
    mcpParams: {
      action: { type: 'string', enum: ['activate', 'minimize', 'maximize', 'close'], description: 'activate 抬到前台，close 关闭（需 force）。' },
      title: { type: 'string', description: '按标题子串匹配窗口。' },
      pid: { type: 'number', description: '按进程 id 匹配窗口。' },
      force: { type: 'boolean', description: 'close 需要 true；只有用户确认后才能传。' }
    },
    mcpRequired: ['action'],
    mcpDescription: '对一个已存在的窗口做动作：activate 抬到前台、minimize/maximize、close 关闭。'
      + '键入与按键之前先 activate 目标窗口，否则键盘输入会落到当前焦点程序。'
      + 'close 会丢失窗口里未保存的工作，只有在用户确认后才能传 force=true。'
  },

  computerClick: {
    path: '/computer/click',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_click',
    mcpParams: {
      x: { type: 'number', description: '屏幕坐标 x（虚拟桌面像素坐标，多显示器可为负）。' },
      y: { type: 'number', description: '屏幕坐标 y。' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left。' },
      double: { type: 'boolean', description: '双击。' }
    },
    mcpRequired: ['x', 'y'],
    mcpDescription: '在屏幕坐标上点击鼠标。先 computer_screen 看清目标再给坐标，'
      + '这一下点的是用户真实桌面：点错就点到别的程序上了，无法撤销。'
  },

  computerMove: {
    path: '/computer/move',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_move',
    mcpParams: {
      x: { type: 'number', description: '屏幕坐标 x。' },
      y: { type: 'number', description: '屏幕坐标 y。' }
    },
    mcpRequired: ['x', 'y'],
    mcpDescription: '移动鼠标指针到指定坐标（不点击）。常用于观察悬停反应或为拖拽做准备。'
  },

  computerDrag: {
    path: '/computer/drag',
    bespoke: true,
    timeout: 60000,
    mcp: 'computer_drag',
    mcpParams: {
      x1: { type: 'number', description: '起点 x。' },
      y1: { type: 'number', description: '起点 y。' },
      x2: { type: 'number', description: '终点 x。' },
      y2: { type: 'number', description: '终点 y。' },
      steps: { type: 'number', description: '分几步移动（默认 24），越大越平滑。' },
      stepMs: { type: 'number', description: '每步间隔毫秒（默认 12）。' }
    },
    mcpRequired: ['x1', 'y1', 'x2', 'y2'],
    mcpDescription: '按住鼠标左键从起点拖到终点（分步移动模拟人手）。'
      + '用于拖动窗口、滑块和文件；目标应用完全不受控时会拖脏桌面界面。'
  },

  computerScroll: {
    path: '/computer/scroll',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_scroll',
    mcpParams: {
      amount: { type: 'number', description: '滚轮格数，负值向下（默认 -3）。' },
      x: { type: 'number', description: '先移动到此坐标再滚（省略则在当前位置滚）。' },
      y: { type: 'number', description: '同上。' }
    },
    mcpDescription: '滚动鼠标滚轮。滚的是当前鼠标位置下的窗口。'
  },

  computerType: {
    path: '/computer/type',
    bespoke: true,
    timeout: 60000,
    mcp: 'computer_type',
    mcpParams: {
      text: { type: 'string', description: '要键入的文本（Unicode 逐字注入，支持中文与换行）。' }
    },
    mcpRequired: ['text'],
    mcpDescription: '向当前焦点窗口键入文本（Unicode 注入，不用剪贴板）。'
      + '先确认焦点在正确的窗口：键盘输入落错地方就是给别的程序按键。'
      + '文本里的换行符会作为 Enter 发出；只输入内容，不负责提交。'
  },

  computerKey: {
    path: '/computer/key',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_key',
    mcpParams: {
      key: { type: 'string', description: '键名或组合键：Enter / Tab / Escape / 方向键 / F1-24，'
        + '或 "ctrl+c"、"win+d"、"ctrl+shift+esc" 这类加号组合。' }
    },
    mcpRequired: ['key'],
    mcpDescription: '向当前焦点窗口派发按键或组合键（Ctrl/Shift/Alt/Win 修饰）。'
      + '闭源应用的原生快捷键也能触发。按 Enter/删除类键之前先想清焦点在哪。'
  },

  computerClipboard: {
    path: '/computer/clipboard',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_clipboard',
    mcpParams: {
      action: { type: 'string', enum: ['read', 'write'], description: '默认 read。' },
      text: { type: 'string', description: '写入的文本（action=write 时必填，需 force）。' },
      force: { type: 'boolean', description: 'write 需要 true；只有用户确认后才能传。' }
    },
    mcpDescription: '读取或写入当前剪贴板（纯文本，支持中文）。'
      + 'write 会覆盖用户正复制着的内容，需要 force=true——只有用户确认后才传。'
  },

  computerShell: {
    path: '/computer/shell',
    bespoke: true,
    timeout: 300000,
    maxTimeout: 300000,
    mcp: 'computer_shell',
    mcpParams: {
      command: { type: 'string', description: '一条 PowerShell 命令。' },
      timeoutMs: { type: 'number', description: '超时毫秒（默认 120000，上限 300000），超时进程被终止。' },
      force: { type: 'boolean', description: '白名单外的命令需要 true；只有用户确认后才能传。' }
    },
    mcpRequired: ['command'],
    mcpDescription: '执行一条 PowerShell 命令并取回合并输出（stdout+stderr、退出码）。'
      + '命令在后台静默运行，不弹窗口。只读动词（Get-*/Test-*/Measure-*/dir/tasklist/ipconfig 等）'
      + '免确认；列表外或含管道/重定向/子表达式的命令需要 force=true。超时的命令会被终止。'
  },

  computerProcess: {
    path: '/computer/process',
    bespoke: true,
    timeout: 45000,
    maxTimeout: 45000,
    mcp: 'computer_process',
    mcpParams: {
      mode: { type: 'string', enum: ['list', 'kill'], description: '默认 list。' },
      pid: { type: 'number', description: '要杀的进程 id（mode=kill 时填，需 force）。' },
      force: { type: 'boolean', description: 'kill 需要 true；只有用户确认后才能传。' }
    },
    mcpDescription: '列出本机进程（pid、名称、内存）或终止一个进程。'
      + '杀进程可能丢数据，kill 需要 force=true——只有用户确认后才传。'
  },

  computerNotify: {
    path: '/computer/notify',
    bespoke: true,
    timeout: 20000,
    mcp: 'computer_notify',
    mcpParams: {
      title: { type: 'string', description: '通知标题（省略时用 "Agent Browser Bridge"）。' },
      message: { type: 'string', description: '通知正文。' }
    },
    mcpDescription: '弹一条 Windows 通知中心 toast（走 PowerShell 内置 AppId，不需要注册）。'
      + '长任务收尾时提醒用户用。'
  },

  computerMedia: {
    path: '/computer/media',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_media',
    mcpParams: {
      op: { type: 'string', enum: ['get', 'volume', 'play', 'pause', 'toggle', 'next', 'prev', 'stop', 'volup', 'voldown', 'mute', 'unmute'], description: 'get 读状态；volume 设置音量（给 volume 0-100）；其余为媒体键。' },
      volume: { type: 'number', description: '目标音量 0-100（op=volume 时）。' }
    },
    mcpDescription: '读取/设置系统主音量、静音，及播放/暂停/下一首等媒体键。'
      + '返回里带 volumePercent 与 muted 状态。'
  },

  computerTree: {
    path: '/computer/tree',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_tree',
    mcpParams: {
      windowTitle: { type: 'string', description: '窗口标题子串；与 hwnd/pid 三选一。' },
      hwnd: { type: 'number', description: '窗口句柄，优先于标题。' },
      pid: { type: 'number', description: '按进程 id 找窗口。' },
      depth: { type: 'number', description: '树深度，默认 6，最大 12。' },
      maxNodes: { type: 'number', description: '最多返回节点数，默认 400，最大 2000。' },
      includeOffscreen: { type: 'boolean', description: '是否包含屏幕外元素，默认 true。' },
      patterns: { type: 'boolean', description: '附带每个元素支持的 UIA 模式，会慢一些。' }
    },
    mcpDescription: '读取窗口的 UI Automation 控件树（control view）。每个节点带 ref、角色、名称、'
      + 'automationId、类名、坐标和启用状态。ref 交给 computer_act 用；控件重建或宿主重启后'
      + '会失效（element_stale），重新 tree/find 即可。'
  },

  computerFind: {
    path: '/computer/find',
    bespoke: true,
    timeout: 35000,
    mcp: 'computer_find',
    mcpParams: {
      windowTitle: { type: 'string', description: '窗口标题子串；与 hwnd/pid 三选一。' },
      hwnd: { type: 'number', description: '窗口句柄。' },
      pid: { type: 'number', description: '按进程 id 找窗口。' },
      name: { type: 'string', description: '控件名称，默认子串匹配（不区分大小写）。' },
      nameExact: { type: 'boolean', description: 'name 改成精确匹配。' },
      automationId: { type: 'string', description: 'AutomationId，精确匹配。' },
      controlType: { type: 'string', description: '控件类型，如 Button / Edit / MenuItem / Window。' },
      className: { type: 'string', description: '类名，子串匹配。' },
      maxResults: { type: 'number', description: '最多返回几个匹配，默认 20，最大 200。' },
      depth: { type: 'number', description: '搜索深度，默认 12。' },
      includeOffscreen: { type: 'boolean', description: '是否包含屏幕外元素，默认 true。' },
      patterns: { type: 'boolean', description: '附带匹配元素支持的 UIA 模式。' }
    },
    mcpDescription: '按 name / automationId / controlType / className 在窗口里查找控件，返回 ref 与坐标。'
      + '至少给一个过滤条件。比遍历整棵树快，适合“找到某个按钮再点”。'
  },

  computerAct: {
    path: '/computer/act',
    bespoke: true,
    timeout: 30000,
    mcp: 'computer_act',
    mcpParams: {
      ref: { type: 'string', description: 'computer_tree/find 返回的 ref，如 e12。' },
      action: { type: 'string', enum: ['invoke', 'toggle', 'setValue', 'getValue', 'select', 'expand', 'collapse', 'focus', 'scrollIntoView', 'click'], description: '要执行的动作。' },
      text: { type: 'string', description: 'action=setValue 时要写入的文本。' },
      windowTitle: { type: 'string', description: '窗口标题子串（用选择器定位控件时需要）。' },
      hwnd: { type: 'number', description: '窗口句柄（用选择器定位控件时需要）。' },
      name: { type: 'string', description: '控件名称（没有 ref 时用）。' },
      automationId: { type: 'string', description: 'AutomationId（没有 ref 时用）。' },
      controlType: { type: 'string', description: '控件类型（没有 ref 时用）。' },
      className: { type: 'string', description: '类名（没有 ref 时用）。' },
      requestId: { type: 'string', description: '幂等 id（1-64 位字母数字/_:-.）：重试同一逻辑请求时保持不变，服务端只执行一次。' }
    },
    mcpRequired: ['action'],
    mcpDescription: '对控件执行 UIA 动作：invoke / toggle / setValue / getValue / select / expand / '
      + 'collapse / focus / scrollIntoView / click。优先用 tree/find 的 ref；ref 失效且同时给了窗口和'
      + '选择器时会自动重新定位。setValue 只写内容不提交。getValue 返回控件文本，注意脱敏。'
  },

  computerWaitFor: {
    path: '/computer/wait',
    bespoke: true,
    timeout: 65000,
    maxTimeout: 70000,
    mcp: 'computer_wait_for',
    mcpParams: {
      ref: { type: 'string', description: '要等待的控件 ref。' },
      condition: { type: 'string', enum: ['exists', 'gone', 'enabled', 'value'], description: '默认 exists；gone 等消失，enabled 等可用，value 等文本相等。' },
      value: { type: 'string', description: 'condition=value 时的期望文本。' },
      windowTitle: { type: 'string', description: '窗口标题子串。' },
      hwnd: { type: 'number', description: '窗口句柄。' },
      name: { type: 'string', description: '控件名称。' },
      automationId: { type: 'string', description: 'AutomationId。' },
      controlType: { type: 'string', description: '控件类型。' },
      className: { type: 'string', description: '类名。' },
      timeoutMs: { type: 'number', description: '最多等多久，默认 10000，最大 60000。' },
      intervalMs: { type: 'number', description: '轮询间隔，默认 200。' }
    },
    mcpDescription: '等控件出现/消失/可用/文本变成期望值。窗口异步刷新后先用它，不要固定 sleep。'
      + '超时返回 wait_timeout。'
  },

  computerBatch: {
    path: '/computer/batch',
    bespoke: true,
    timeout: 300000,
    maxTimeout: 300000,
    mcp: 'computer_batch',
    mcpSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: '按顺序执行的动作列表，每项 { action, params }。',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: '动作键，如 computerClick、computerKey。' },
              params: { type: 'object', description: '该动作的参数，与单独调用时一致。' }
            },
            required: ['action'],
            additionalProperties: false
          }
        },
        waitMs: { type: 'number', description: '桌面被占用时最多排队毫秒（默认 0，立即返回 desktop_busy）。' },
        stopOnError: { type: 'boolean', description: '默认 true：某步失败后其余标记 skipped。' },
        requestId: { type: 'string', description: '幂等 id（1-64 位字母数字/_:-.）：整批重试时保持不变，服务端只执行一次。' }
      },
      required: ['ops'],
      additionalProperties: false
    },
    mcpDescription: '一次请求执行多个桌面动作，共享一次桌面写锁，省掉每步的 HTTP 往返。'
      + 'ops 每项 { action, params }，action 用动作键（如 computerClick）。'
      + '默认某步失败后其余标记 skipped；最多 50 步。'
  }
};

/** MCP 工具的对外顺序（tools.js 按它生成 TOOLS）。 */
const MCP_ORDER = [
  'browser_list_tabs', 'browser_read_page', 'browser_get_links', 'browser_navigate',
  'browser_batch', 'browser_click', 'browser_type', 'browser_press_key', 'browser_wait_for',
  'browser_screenshot', 'browser_eval', 'browser_frames', 'browser_save_file',
  'browser_upload_file', 'browser_session', 'browser_close_tab', 'browser_clear_marks',
  'browser_status',
  /* computer 桌面控制（Windows） */
  'computer_screen', 'computer_windows', 'computer_window',
  'computer_click', 'computer_move', 'computer_drag', 'computer_scroll',
  'computer_type', 'computer_key', 'computer_clipboard',
  'computer_shell', 'computer_process', 'computer_notify', 'computer_media',
  'computer_tree', 'computer_find', 'computer_act', 'computer_wait_for',
  'computer_batch'
];

/**
 * CLI 取值选项按动作参数登记（布尔开关不占值，解析器自动处理，不在此列）。
 * 值为字符串时表示 CLI 旗标与参数键不同名（--idle 对应 idleMs）。
 * CLI 级常驻选项（port/timeout/host/out/tail/file/header）不属于任何动作，留在 args.js。
 */
const CLI_VALUE_OPTS = {
  match: true, url: true, tabId: true, frameId: true, browser: true,
  selector: true, text: true, href: true, index: true,
  value: true, key: true, format: true, code: true, name: true,
  filename: true, maxBytes: true, count: true,
  idleMs: 'idle'
};

/** 从动作表生成一个 MCP 工具定义。 */
function toolFor(mcpName) {
  const entry = Object.values(ACTIONS).find((e) => e.mcp === mcpName);
  if (!entry) { throw new Error('注册表里没有这个 MCP 工具：' + mcpName); }
  if (entry.mcpSchema) {
    return { name: mcpName, description: entry.mcpDescription, inputSchema: entry.mcpSchema };
  }
  const properties = {};
  if (entry.mcpTarget === 'page') { Object.assign(properties, PAGE_TARGET); }
  else if (entry.mcpTarget === 'tab') { Object.assign(properties, TAB_TARGET); }
  Object.assign(properties, entry.mcpParams);
  const schema = { type: 'object', properties, additionalProperties: false };
  if (entry.mcpRequired) { schema.required = entry.mcpRequired; }
  return { name: mcpName, description: entry.mcpDescription, inputSchema: schema };
}

module.exports = { TAB_TARGET, PAGE_TARGET, TARGET_NOTE, ACTIONS, MCP_ORDER, CLI_VALUE_OPTS, toolFor };
