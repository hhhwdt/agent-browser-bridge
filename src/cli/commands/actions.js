/**
 * CLI 交互类命令：activate / wait / click / type / key / navigate / mark / reload / close / unmark。
 */

'use strict';

const { num, requireTarget } = require('../args.js');
const { printClick, printType } = require('../output.js');

/** activate 命令。 */
async function cmdActivate(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  const data = await client.activate({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log('已激活  : ' + data.title.slice(0, 50));
  console.log('标签页  : ' + data.tabId + (data.wasActive ? '（原本就是激活的）' : '（已从后台切到前台）'));
}

/** wait 命令。 */
async function cmdWait(args, ctx) {
  const { client } = ctx;
  requireTarget(args);
  if (!args.selector && !args.text && !args.url && !args.idle) {
    console.error('需要 --selector、--text、--url 或 --idle 指定等待条件');
    process.exit(1);
  }
  const data = await client.wait({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    selector: args.selector,
    text: args.text,
    count: num(args.count),
    idleMs: num(args.idle),
    state: args.disappear ? 'disappear' : 'appear',
    timeoutMs: num(args.timeout) || 10000,
    browser: args.browser
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`条件已成立（等待 ${data.elapsedMs}ms）`);
  console.log(`标签页: ${data.tabId}  框架: ${data.frameId}  状态: ${data.state}`);
}

/** click 命令。 */
async function cmdClick(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  if (!args.selector && !args.text && !args.href) {
    console.error('需要 --selector、--text 或 --href 之一来定位要点击的元素');
    process.exit(1);
  }
  const data = await client.click({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    selector: args.selector,
    text: args.text,
    href: args.href,
    index: num(args.index),
    allowNonLink: !!args.force,
    dryRun: !!args.dryRun,
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  printClick(data);
}

/** type 命令。 */
async function cmdType(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  const value = args.value !== undefined ? args.value : args._.slice(1).join(' ');
  if (value === undefined || value === '') {
    console.error('需要 --value 指定要输入的文本');
    process.exit(1);
  }
  const data = await client.type({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    selector: args.selector,
    text: args.text,
    value,
    method: args.html ? 'html' : 'text',
    clear: !!args.clear,
    allowNonInput: !!args.force,
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  printType(data);
}

/** key 命令。 */
async function cmdKey(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  if (!args.key) {
    console.error('需要 --key 指定按键，例如 Enter / Tab / Escape');
    process.exit(1);
  }
  const data = await client.key({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    selector: args.selector,
    key: args.key,
    ctrl: !!args.ctrl,
    shift: !!args.shift,
    alt: !!args.alt,
    meta: !!args.meta,
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`已按键  : ${data.key}（keyCode=${data.keyCode}）`);
  console.log(`目标    : <${data.target}>`);
  console.log(`事件未被取消: ${data.notCancelled ? '是' : '否（页面已处理）'}`);
}

/** navigate 命令。 */
async function cmdNavigate(args, ctx) {
  const { client, timeoutMs } = ctx;
  if (!args.url) {
    console.error('需要 --url 指定目标地址');
    process.exit(1);
  }
  const data = await client.navigate({
    url: args.url,
    newTab: !!args.newTab,
    match: args.match,
    tabId: num(args.tabId),
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`已导航  : ${data.url}`);
  const where = data.openedNewTab ? '（后台新建）' : (data.wasActive ? '（当前激活）' : '（后台）');
  console.log(`标签页  : ${data.tabId}${where}`);
}

/** mark 命令。 */
async function cmdMark(args, ctx) {
  const { client, timeoutMs } = ctx;
  const data = await client.mark({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    text: args.text,
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`已标记  : ${data.title}`);
  console.log(`标签页  : ${data.tabId}  浏览器: ${data.browser}`);
  console.log(`页面内提示: ${data.indicatorPlaced ? '已显示' : '未能显示（受限页面）'}`);
}

/** reload 命令。 */
async function cmdReload(args, ctx) {
  const { client } = ctx;
  const data = await client.reload({ browser: args.browser });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  const list = (data && data.reloaded) || [];
  for (const r of list) {
    console.log(r.ok ? `已通知重载: ${r.browser}` : `重载失败: ${r.browser} (${r.error})`);
  }
  console.log('等待重连…');
  const ready = await client.waitUntilReady(25000);
  console.log(ready ? '已重连' : '未在预期时间内重连，请检查扩展状态');
}

/** close 命令。 */
async function cmdClose(args, ctx) {
  const { client, timeoutMs } = ctx;
  const tabId = num(args.tabId);
  if (tabId === undefined) {
    console.error('需要 --tabId 指定要关闭的标签页（不支持按 --match 批量关闭）');
    process.exit(1);
  }
  const data = await client.close({ tabId, browser: args.browser, timeoutMs });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`已关闭  : ${data.closedTitle}`);
  console.log(`原地址  : ${data.closedUrl}`);
}

/** unmark 命令。 */
async function cmdUnmark(args, ctx) {
  const { client, timeoutMs } = ctx;
  const data = await client.unmark({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`已清除标记 ${data.cleared.length} 个标签页：${data.cleared.join(', ') || '（无）'}`);
  // 未指定 --browser 时会逐个在线浏览器都清一遍，这里列出各自结果
  for (const b of (data.browsers || [])) {
    console.log(`  ${b.browser}: ${b.ok ? '已清理 ' + b.cleared.length + ' 个' : '失败（' + b.error + '）'}`);
  }
}

module.exports = {
  cmdActivate, cmdWait, cmdClick, cmdType, cmdKey, cmdNavigate,
  cmdMark, cmdReload, cmdClose, cmdUnmark
};
