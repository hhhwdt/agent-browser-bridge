/**
 * Agent Browser Bridge —— 服务端配置。
 *
 * 命令行参数在这里统一解析成常量。被 token / audit / http / queue 等模块引用，
 * 这个模块自身不依赖其他业务模块，是依赖图的叶子。
 */

'use strict';

const path = require('node:path');
const { getConfigDir } = require('../config-dir.js');

const argv = process.argv.slice(2);

/** 取 --flag value 形式的参数值，不存在时用 fallback。 */
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = parseInt(argValue('--port', '18777'), 10);
const HOST = '127.0.0.1';

/** --no-token 时跳过所有 token 校验，仅用于开发调试。 */
const NO_TOKEN = argv.includes('--no-token');

/**
 * 允许驱动桥接的扩展 ID。
 *
 * 扩展 ID 由清单里的 key（公钥）推导，因此从源码加载的每一份安装 ID 都相同。
 * 不固定 ID 的话，用户装的**任何**其他扩展都能调这个桥接：它们会借用桥接自己的
 * cookies 与 debugger 权限，等于绕过浏览器的权限提示拿到这些能力。
 *
 * 另有自己签名的构建、或从商店安装的版本（ID 由商店分配）时，用
 * --allow-extension <id> 追加。扩展 ID 可在扩展弹窗或 `node src/cli.js diag` 里看到。
 */
const DEFAULT_EXTENSION_ID = 'nbopjoejgialcnmjcefaciebicahjhpp';

/** 实际生效的扩展 ID 允许列表：默认 ID + 命令行追加。 */
const allowedExtensionIds = new Set([DEFAULT_EXTENSION_ID.toLowerCase()]);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--allow-extension' && argv[i + 1]) {
    allowedExtensionIds.add(String(argv[i + 1]).trim().toLowerCase());
  }
}

const POLL_HOLD_MS = 25000;      // 扩展长轮询的挂起时长
const READ_TIMEOUT_MS = 30000;   // 单次操作的默认等待上限
const MAX_QUEUE = 100;           // 单浏览器队列上限，防止无扩展连接时无限堆积

/**
 * /result 的请求体上限。不能沿用普通请求的 1MB：
 * download 会把整个文件转成 base64 回传（上限 20MB），screenshot 回传
 * dataUrl，session 会把 localStorage 整个倒出来，都会超过 1MB。
 * 超限时 readBody 会 destroy 连接，扩展侧只看到 ECONNRESET，调用方只能干等到超时。
 */
const RESULT_MAX_BODY = 32 * 1024 * 1024;

/**
 * 对外接口版本。新增能力时递增次版本，破坏性变更时递增主版本。
 * 其他 agent 可先读 /health 的 apiVersion 与 capabilities 再决定调用方式。
 */
const API_VERSION = '1.0';

/** 本服务提供的能力清单，供调用方做特性探测。 */
const CAPABILITIES = [
  'tabs',         // 列出标签页
  'read',         // 读取正文
  'eval',         // 在页面里执行 JS 并取回结果（量 DOM、取计算样式）
  'session',      // 读取标签页登录态（cookies + localStorage/sessionStorage）
  'upload',       // 把本地文件塞进页面 file input（CDP）
  'download',     // 用页面登录态下载文件
  'screenshot',   // 截取当前可见标签页画面
  'links',        // 枚举链接
  'click',        // 点击元素
  'type',         // 输入文本
  'key',          // 派发按键
  'navigate',     // 导航
  'mark',         // 标记标签页
  'unmark',       // 清除标记
  'close',        // 关闭标签页（需显式 tabId）
  'frames',       // 框架诊断
  'wait',         // 等待条件成立
  'diag',         // 扩展运行诊断
  'activate',     // 激活标签页（唤醒冻结标签页）
  'save',         // 保存文件到磁盘（浏览器下载栈）
  'media',        // 枚举页面媒体候选
  'grab',         // 抓取受防盗链/CORS 保护的媒体
  'reload',       // 重新加载扩展自身（开发用）
  'multiBrowser'  // 多浏览器隔离与路由
];

module.exports = {
  argv,
  argValue,
  PORT,
  HOST,
  NO_TOKEN,
  DEFAULT_EXTENSION_ID,
  allowedExtensionIds,
  POLL_HOLD_MS,
  READ_TIMEOUT_MS,
  MAX_QUEUE,
  RESULT_MAX_BODY,
  API_VERSION,
  CAPABILITIES,
  getConfigDir
};
