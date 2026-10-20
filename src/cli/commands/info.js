/**
 * CLI 查询类命令：browsers / diag / tabs / read / eval / screenshot / session / frames / media / links。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { num, requireTarget } = require('../args.js');
const { compact, printTabs, printRead, printLinks } = require('../output.js');
const { checkUpdate } = require('../update-check.js');

/** browsers 命令。 */
async function cmdBrowsers(args, ctx) {
  const { client, health, timeoutMs } = ctx;
  const list = health.browsers || [];
  if (list.length === 0) {
    console.log('没有已连接扩展的浏览器。');
  } else {
    console.log(`已连接扩展的浏览器：${list.join(', ')}`);
    console.log(`自动选择顺序：${(health.defaultBrowserOrder || list).join(' -> ')}`);
  }
  console.log(`接口版本：${health.apiVersion}`);
}

/** diag 命令。 */
async function cmdDiag(args, ctx) {
  const { client, timeoutMs } = ctx;
  const data = await client.diag({ browser: args.browser, timeoutMs });
  const health = await client.health();
  const allowed = health.allowedExtensionIds || [];
  if (args.json) { console.log(JSON.stringify({ diag: data, allowedExtensionIds: allowed }, null, 2)); return; }

  console.log(`浏览器    : ${data.browser}`);
  console.log(`扩展版本  : ${data.version}`);
  console.log(`扩展 ID   : ${data.extensionId || '（该版本扩展未上报，重载扩展后可见）'}`);
  console.log(`桥接地址  : ${data.bridgeUrl}`);
  console.log(`轮询循环  : ${data.loopRunning ? '运行中' : '未运行'}`);
  if (data.keepaliveAlarm) {
    console.log(`保活闹钟  : 每 ${data.keepaliveAlarm.periodInMinutes} 分钟`);
  }
  if (data.boot) {
    console.log(`SW 启动   : ${data.boot.count} 次（最近 ${new Date(data.boot.lastAt).toLocaleString()}）`);
  }
  console.log(`已标记    : ${(data.markedTabs || []).length} 个标签页`);
  console.log(`错误条数  : ${data.errorCount || 0}`);
  for (const e of (data.errors || []).slice(-5)) {
    console.log(`  [${e.where}] ${compact(e.msg, 160)}`);
  }
  console.log(`服务端允许: ${allowed.join(', ') || '（未上报）'}`);
  if (data.extensionId && allowed.length) {
    console.log(allowed.includes(data.extensionId)
      ? 'ID 校验   : 一致'
      : `ID 校验   : 不一致！服务端不会接受该扩展。用 --allow-extension ${data.extensionId} 启动服务端。`);
  }
  await checkUpdate();
}

/** tabs 命令。 */
async function cmdTabs(args, ctx) {
  const { client, timeoutMs } = ctx;
  const data = await client.tabs({ browser: args.browser, timeoutMs });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  printTabs(data);
}

/** media 命令。 */
async function cmdMedia(args, ctx) {
  const { client } = ctx;
  requireTarget(args);
  const data = await client.media({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    browser: args.browser
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  const c = data.counts || {};
  console.log('页面  : ' + (data.title || '').slice(0, 60));
  console.log('URL   : ' + (data.url || '').slice(0, 80));
  console.log('统计  : 视频元素 ' + (c.videos || 0) + '  播放清单 ' + (c.streams || 0) + '  图片 ' + (c.images || 0) + '  音频 ' + (c.audios || 0));
  const show = (label, arr, n) => {
    if (!arr || !arr.length) { return; }
    console.log('--- ' + label + ' ---');
    arr.slice(0, n || 8).forEach((x, i) => console.log('  [' + i + '] ' + String(x.src).slice(0, 110)));
  };
  show('视频元素', data.videos, 6);
  show('播放清单/直链（页面数据）', data.streams, 8);
  show('图片', data.images, 6);
}

/** read 命令。 */
async function cmdRead(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  const data = await client.read({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    selector: args.selector,
    includeLinks: !!args.links,
    returnHtml: !!args.html,
    format: args.format,
    autoActivate: !!args.autoActivate,
    lease: !!args.lease,
    browser: args.browser,
    timeoutMs
  });

  if (args.out) {
    const dir = path.dirname(args.out);
    if (dir && !fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(args.out, data.text, 'utf8');
  }

  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }

  if (args.html) {
    console.log(`标题  : ${data.title}`);
    console.log(`URL   : ${data.url}`);
    console.log(`字符数: ${data.charCount}`);
    if (data.contentEditables && data.contentEditables.length) {
      console.log(`\n可编辑区域 ${data.contentEditables.length} 个：`);
      for (const c of data.contentEditables) {
        const parts = [`[${c.index}] <${c.tag}>`];
        if (c.id) { parts.push(`#${c.id}`); }
        if (c.className) { parts.push(`.${c.className.split(/\s+/).join('.')}`); }
        if (c.ariaLabel) { parts.push(`aria-label="${c.ariaLabel}"`); }
        if (c.dataTestId) { parts.push(`data-testid="${c.dataTestId}"`); }
        parts.push(c.visible ? '可见' : '隐藏');
        parts.push(`${c.textLength} 字`);
        console.log('  ' + parts.join('  '));
      }
    } else {
      console.log('\n未发现可编辑区域（当前可能处于查看态）');
    }
    if (data.html) {
      console.log(`\n--- HTML${data.htmlTruncated ? '（已截断）' : ''} ---`);
      console.log(data.html);
    }
    return;
  }

  printRead(data, args.out);
  if (args.links && data.links && data.links.length) {
    console.log('\n--- 链接 ---');
    for (const l of data.links) { console.log(`${compact(l.text, 60)}\t${l.href}`); }
  }
}

/** eval 命令。 */
async function cmdEval(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  let code = args.code;
  if (!code && args.file) {
    code = fs.readFileSync(args.file[0], 'utf8');
  }
  if (!code) {
    console.error('缺少要执行的代码：用 --code "<JS>" 或 --file <文件>');
    process.exitCode = 1;
    return;
  }

  const data = await client.evalPage({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    code,
    browser: args.browser,
    timeoutMs
  });

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.truncated) {
    console.log('结果过大已截断（仅返回前 200KB 的 JSON）：');
    console.log(data.json);
    return;
  }
  console.log(typeof data.value === 'string' ? data.value : JSON.stringify(data.value, null, 2));
}

/** screenshot 命令。 */
async function cmdScreenshot(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  const data = await client.screenshot({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    format: args.format,
    selector: args.selector,
    full: !!args.full,
    browser: args.browser,
    timeoutMs
  });

  const out = args.out || 'screenshot.png';
  const base64 = String(data.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  const dir = path.dirname(out);
  if (dir && !fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(out, buf);
  console.log(`已保存截图: ${out}  (${data.width}x${data.height} ${data.format}, ${(buf.length / 1024).toFixed(0)} KB)`);
}

/** session 命令。 */
async function cmdSession(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  const data = await client.session({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    name: args.name,
    key: args.key,
    local: args.local,
    session: args.session,
    storage: args.storage,
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  if (data.cookies) {
    console.log('--- cookies（' + data.cookies.length + ' 个）---');
    for (const c of data.cookies) {
      console.log('  ' + c.name + ' = ' + compact(c.value, 120)
        + (c.httpOnly ? '  [httpOnly]' : '') + (c.domain ? '  @' + c.domain : ''));
    }
  }
  for (const storeName of ['localStorage', 'sessionStorage']) {
    const store = data.storage && data.storage[storeName];
    if (!store) { continue; }
    console.log('--- ' + storeName + '（' + Object.keys(store).length + ' 项）---');
    for (const k of Object.keys(store)) {
      console.log('  ' + k + ' = ' + compact(String(store[k]), 120));
    }
  }
  if (data.cookiesError) { console.log('cookies 读取失败: ' + data.cookiesError); }
  if (data.storageError) { console.log('本地存储读取失败: ' + data.storageError); }
}

/** frames 命令。 */
async function cmdFrames(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  const data = await client.frames({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(`标题  : ${data.title}`);
  console.log(`URL   : ${data.url}`);
  console.log(`框架数: ${data.frameCount}`);
  console.log('---');
  for (const f of data.frames) {
    if (!f.info) {
      console.log(`[frameId=${f.frameId}] 注入失败：${f.error}`);
      continue;
    }
    const i = f.info;
    console.log(`[frameId=${f.frameId}] ${i.isMainFrame ? '主框架' : '子框架'}  ${i.title}`);
    console.log(`    URL        : ${i.href}`);
    console.log(`    designMode : ${i.designMode}`);
    console.log(`    body可编辑 : ${i.bodyIsContentEditable}${i.bodyEditableByDesignMode ? '（designMode）' : ''}`);
    console.log(`    contenteditable 元素: ${i.editableAttrCount}    role=textbox: ${i.textboxRoleCount}    输入框: ${i.inputCount}`);
    console.log(`    正文长度   : ${i.bodyTextLength}    子框架数: ${i.iframeCount}`);
  }
}

/** links 命令。 */
async function cmdLinks(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  const data = await client.links({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    frameId: num(args.frameId),
    selector: args.selector,
    text: args.text,
    browser: args.browser,
    timeoutMs
  });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  printLinks(data);
}

module.exports = {
  cmdBrowsers, cmdDiag, cmdTabs, cmdMedia, cmdRead, cmdEval,
  cmdScreenshot, cmdSession, cmdFrames, cmdLinks
};
