/**
 * 工具定义：initialize 说明与工具表。
 *
 * 每个工具的 schema（目标定位字段、参数、required）与描述文案都来自
 * src/actions-registry.js 的动作表——一处修改前台后台同时生效。
 * 这里只剩三件事：工具的对外顺序（MCP_ORDER）、initialize 说明、
 * 以及 handlers.js 用的参数提取辅助。
 */

'use strict';

const { MCP_ORDER, TAB_TARGET, PAGE_TARGET, TARGET_NOTE, toolFor } = require('../actions-registry.js');

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

const TOOLS = MCP_ORDER.map((toolName) => toolFor(toolName));

/** initialize 回给客户端的服务级说明，模型会读到。 */
const INSTRUCTIONS = [
  '这个服务让 agent 操作用户**已经打开并已登录**的浏览器，全程后台运行，不切换标签、不抢焦点。',
  '',
  '工作纪律：',
  '1. 先 browser_list_tabs 看现状，拿到 tabId 和 URL，不要凭猜测去 match。',
  '2. 站点访问默认是拒绝的，需要用户在扩展弹窗里逐站授权。遇到 permission_denied 时把原文告诉用户，不要反复重试。',
  '3. 需要新页面时用 browser_navigate（默认后台新建），用完 browser_close_tab 关掉；不要动用户自己的标签页。',
  '4. 操作会在页面上留下可见标记。任务收尾时调 browser_clear_marks，除非用户还要继续看。',
  '5. 不可逆动作（提交、发布、发送、删除、审批、付款）一律先用 browser_click 的 dryRun 看清会点到什么，'
    + '并让用户确认；只有确认过才传 force=true。',
  '6. browser_type 只写内容不提交，提交必须单独一个 browser_click——这让用户有机会在提交前看一眼。',
  '7. 页面异步刷新后先 browser_wait_for，否则下一步会随机失败。',
  '8. 写共享文档、生产系统，或任何有真实的人在另一头看到的系统之前，先向用户确认。',
  '',
  '桌面控制（computer_*，仅 Windows 本机执行，不经浏览器）：',
  '1. 点击/键入前先 computer_screen 看屏幕、computer_windows 拿窗口坐标，不凭记忆给坐标。',
  '2. computer_type / computer_key 发给"当前焦点窗口"，会落到用户正在用的程序上；'
    + '先 computer_window activate 目标窗口再输入。',
  '3. UAC 弹窗、锁屏、Windows Hello 一律点不了，别尝试；DirectInput 游戏不响应注入。',
  '4. computer_shell 白名单外、computer_window action=close、computer_process mode=kill、'
    + 'computer_clipboard action=write 都需要 force=true，一律先向用户确认再传。',
  '5. 截图是桌面图像，里面可能有用户正在看的内容；给用户的回复里注意脱敏。',
  '6. 多步连续操作（点一下、等一下、再输入）用 computer_batch 一次下发：整批只取一次桌面写锁，'
    + '不会中途被其他 agent 插入。',
  '7. 另一个 agent 正在操作桌面时会收到 desktop_busy；等对方结束或传 waitMs 排队，不要反复重试。'
].join('\n');

module.exports = {
  TAB_TARGET, PAGE_TARGET, TARGET_NOTE, tabTarget, pageTarget, TOOLS, INSTRUCTIONS
};
