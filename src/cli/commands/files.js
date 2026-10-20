/**
 * CLI 文件类命令：grab / save / upload / download。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { num, requireTarget } = require('../args.js');

/** grab 命令。 */
async function cmdGrab(args, ctx) {
  const { client } = ctx;
  requireTarget(args);
  if (!args.url) {
    console.error('需要 --url 指定媒体地址');
    process.exit(1);
  }
  const body = {
    url: args.url,
    filename: args.filename,
    browser: args.browser
  };
  if (args.match) { body.match = args.match; }
  if (args.tabId !== undefined) { body.tabId = num(args.tabId); }

  const data = await client.grab({ ...body, timeoutMs: num(args.timeout) || 180000 });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log('地址    : ' + data.url);
  console.log('页面取流: ' + (data.fetchedBytes ? (data.fetchedBytes / 1024 / 1024).toFixed(2) + ' MB' : '未知'));
  console.log('状态    : ' + (data.done ? '已完成' : data.state));
  if (data.filename) { console.log('落盘路径: ' + data.filename); }
}

/** save 命令。 */
async function cmdSave(args, ctx) {
  const { client } = ctx;
  if (!args.url) {
    console.error('需要 --url 指定要保存的地址（可用相对地址，配合 --match 按页面解析）');
    process.exit(1);
  }
  const body = {
    url: args.url,
    filename: args.filename,
    saveAs: !!args.saveAs,
    overwrite: !!args.overwrite,
    browser: args.browser
  };
  if (args.match) { body.match = args.match; }
  if (args.tabId !== undefined) { body.tabId = num(args.tabId); }
  if (args.timeout !== undefined) { body.waitMs = num(args.timeout); }

  const data = await client.save({ ...body, timeoutMs: ((num(args.timeout) || 30000) + 30000) });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log('地址    : ' + data.url);
  if (data.pageUrl) { console.log('来源页  : ' + data.pageUrl.slice(0, 70)); }
  console.log('状态    : ' + (data.done ? '已完成' : data.state || '未知'));
  if (data.filename) { console.log('落盘路径: ' + data.filename); }
  if (data.bytes) {
    const kb = data.bytes / 1024;
    console.log('大小    : ' + (kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB'));
  }
}

/** upload 命令。 */
async function cmdUpload(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  const files = args.file || [];
  if (files.length === 0) {
    console.error('缺少文件：用 --file <绝对路径> 指定，可重复多次');
    process.exitCode = 1;
    return;
  }
  const data = await client.upload({
    match: args.match,
    url: args.url,
    tabId: num(args.tabId),
    selector: args.selector,
    files,
    browser: args.browser,
    timeoutMs
  });
  console.log('已选择文件: ' + (data.files || []).join(', ') + '  →  ' + data.selector);
}

/** download 命令。 */
async function cmdDownload(args, ctx) {
  const { client, timeoutMs } = ctx;
  requireTarget(args);
  if (!args.url) {
    console.error('缺少下载地址：用 --url <地址> 指定（建议同源地址，会自动带上登录态）');
    process.exitCode = 1;
    return;
  }
  const headerList = args.header || [];
  const headers = {};
  for (const h of headerList) {
    const i = String(h).indexOf(':');
    if (i > 0) { headers[String(h).slice(0, i).trim()] = String(h).slice(i + 1).trim(); }
  }
  const data = await client.download({
    match: args.match,
    tabId: num(args.tabId),
    url: args.url,
    maxBytes: num(args.maxBytes),
    headers: Object.keys(headers).length ? headers : undefined,
    browser: args.browser,
    timeoutMs
  });
  const out = args.out || data.filename || 'download.bin';
  const dir = path.dirname(out);
  if (dir && !fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(out, Buffer.from(data.base64, 'base64'));
  console.log('已保存: ' + out + '  (' + data.bytes + ' 字节, ' + (data.contentType || '未知类型') + ')');
}

module.exports = { cmdGrab, cmdSave, cmdUpload, cmdDownload };
