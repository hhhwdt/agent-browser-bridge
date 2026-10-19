#!/usr/bin/env node
/**
 * Agent Browser Bridge —— 命令行客户端。
 *
 * 本文件是 client.js 的命令行包装，自身不含通信逻辑；
 * 其他 agent 若要集成，直接引用 client.js 即可，不必调用本文件。
 *
 * 用法见 `node src/cli.js --help`。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClient, BridgeError, BridgeUnavailableError } = require('./client.js');

/** 每用户配置目录，与 server.js 保持一致。 */
function getConfigDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(base, 'agent-browser-bridge');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'agent-browser-bridge');
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };

  // 需要取值的选项；其余 --xxx 视为布尔开关
  const VALUE_OPTS = new Set([
    'match', 'url', 'tabId', 'frameId', 'browser', 'selector', 'text', 'href',
    'value', 'key', 'index', 'port', 'timeout', 'host', 'idle', 'count', 'tail',
    // eval / screenshot / session / upload / download / save 用
    'code', 'file', 'out', 'format', 'name', 'key', 'header', 'filename'
  ]);

  // 可重复的选项，重复出现时累加为数组：
  //   --file   upload 传多个文件
  //   --header download 追加多个请求头
  const REPEATABLE_OPTS = new Set(['file', 'header']);

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (VALUE_OPTS.has(key)) {
      if (REPEATABLE_OPTS.has(key)) {
        (out[key] = out[key] || []).push(argv[++i]);
      } else {
        out[key] = argv[++i];
      }
    } else {
      out[key] = true;
    }
  }
  return out;
}

function usage() {
  console.log(`Agent Browser Bridge 命令行客户端

用法:
  node src/cli.js browsers
  node src/cli.js tabs [--browser edge|chrome]
  node src/cli.js diag [--browser edge|chrome]

    扩展自身的运行诊断：版本、扩展 ID、连接状态、SW 启动次数、最近错误。
    并会拿扩展 ID 与服务端的允许列表比对——ID 不一致时直接给出该用的 --allow-extension 参数。

  node src/cli.js read --match "<URL子串>" [--selector CSS] [--links] [--html] [--out 文件] [--json]

    --html  额外返回元素 outerHTML 与可编辑区域清单，用于定位选择器

  node src/cli.js eval --match "<URL子串>" (--code "<JS>" | --file 文件) [--frameId N] [--json]

    在页面主世界执行 JS，适合量 DOM、读计算样式，例如：
    --code "const t=document.querySelector('.el-table'); return t && Math.round(t.getBoundingClientRect().width)"
    代码只执行一次：整段是一个表达式时直接取它的值（--code "document.title"），
    多行语句请在最后用 return 返回结果。
    返回的 DOM 节点会转成 {node,id,className,text,html}；整体超过 200KB 时截断并给出 json 片段。

  node src/cli.js screenshot --match "<URL子串>" [--out 文件] [--format png|jpeg] [--selector CSS] [--full]

    默认走 CDP 截屏：后台标签页也能截，支持 --selector 只截某个元素、--full 截整页；
    CDP 不可用时（如该标签页开着 DevTools）退避为扩展自带截屏（仅当前激活标签页）。
    默认保存为 screenshot.png。

  node src/cli.js session --match "<URL子串>" [--name cookie名] [--key 存储键] [--local] [--session] [--storage false] [--json]

    读取该标签页的登录态：cookies（含 httpOnly）+ localStorage / sessionStorage。
    默认两处存储都读、值按 4000 字符截断；--name/--key 可只取指定项。

  node src/cli.js upload --match "<URL子串>" --file <绝对路径> [--file ...] [--selector CSS]

    把本地文件塞进页面 file input（走 CDP，默认选择器 input[type=file]）。--file 可重复。

  node src/cli.js download --match "<URL子串>" --url <地址> [--out 文件] [--maxBytes N] [--header "名字: 值"]

    用该标签页的登录态请求地址（同源自动带 cookie，可用 --header 追加 token 之类的头）并落盘；
    默认上限 20MB，超限报 too_large。

  node src/cli.js links --match "<URL子串>" [--text 关键字] [--selector CSS]

  node src/cli.js click --match "<URL子串>" (--text "<文字>" | --href "<地址片段>" | --selector CSS) [--index N] [--force] [--dryRun]

  node src/cli.js type --match "<URL子串>" --value "<文本>" [--selector CSS | --text "<字段名>"] [--clear] [--html] [--force]

  node src/cli.js key --match "<URL子串>" --key Enter [--selector CSS] [--ctrl] [--shift]

  node src/cli.js navigate --url "https://..." [--newTab] [--match "<URL子串>" | --tabId N]

  node src/cli.js mark   --match "<URL子串>" [--text "标记说明"]
  node src/cli.js unmark [--match "<URL子串>" | --tabId N]   # 不指定则清除全部
  node src/cli.js close  --tabId N                           # 必须显式指定 tabId
  node src/cli.js reload                                     # 改动扩展代码后重载扩展

  node src/cli.js frames --match "<URL子串>"                 # 诊断框架（编辑器在哪个 iframe）
  node src/cli.js wait   --match "<URL子串>" --selector "#id" [--disappear] [--timeout 10000]
                           [--idle <ms>] [--url <子串>] [--count <n>]

公共选项:
  --browser <s>    指定浏览器（edge / chrome）；省略时自动选择
  --frameId <n>    指定框架 id；富文本编辑器常在 iframe 内，用 frames 查出后指定
  --port <n>       桥接服务端口，默认 18777
  --timeout <ms>   等待超时，默认 30000
  --json           输出完整 JSON

框架诊断:
  node src/cli.js frames --match "<URL子串>"
    列出标签页内所有框架、各自是否可编辑、正文长度、子框架数。
    读不到正文或写不进编辑器时先用它确认目标框架的 frameId。

定位标签页（三选一）:
  --match <s>      URL 子串，优先命中当前激活标签页
  --url <s>        精确或前缀匹配的 URL
  --tabId <n>      标签页 id

定位元素（click / type）:
  --selector <css> CSS 选择器
  --text <s>       按文字定位链接，或按字段名/占位符定位输入框
  --href <s>       按地址片段定位链接
  --index <n>      多个匹配时取第几个，默认 0

安全约束:
  click 默认只点击链接（<a href>）。点击按钮等非链接元素必须加 --force。
  type  默认只写入输入框、文本域和可编辑区域；写入其他元素需加 --force。
  提交、发布、删除等不可逆操作，以及写入共享文档前，应先向用户确认。
  key   派发的是合成事件，只触发页面内 JS 处理器，不影响浏览器快捷键。`);
}

/* ------------------------------------------------------------------ *
 * 输出辅助
 * ------------------------------------------------------------------ */

const compact = (s, n = 60) => {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
};

function printTabs(data) {
  console.log(`共 ${data.tabs.length} 个标签页：`);
  for (const t of data.tabs) {
    console.log(`${t.active ? '*' : ' '} [${t.id}] ${t.title}`);
    console.log(`      ${t.url}`);
  }
}

function printRead(info, outPath) {
  if (outPath) {
    console.log(`标题    : ${info.title}`);
    console.log(`URL     : ${info.url}`);
    console.log(`浏览器  : ${info.browser || '未知'}`);
    console.log(`标签页  : ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
    console.log(`选择器  : ${info.usedSelector}`);
    console.log(`字符数  : ${info.charCount}`);
    console.log(`已写入  : ${outPath}`);
    return;
  }
  console.log(`标题  : ${info.title}`);
  console.log(`URL   : ${info.url}`);
  console.log(`浏览器: ${info.browser || '未知'}`);
  console.log(`标签页: ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
  console.log(`字符数: ${info.charCount}`);
  console.log('---');
  console.log(info.text);
}

function printLinks(info) {
  console.log(`页面  : ${info.title}`);
  console.log(`URL   : ${info.url}`);
  console.log(`链接数: ${info.links.length}`);
  console.log('---');
  for (const l of info.links) {
    console.log(`[${l.index}] ${l.visible ? ' ' : '隐'} ${compact(l.text, 80)}`);
    console.log(`      ${l.href}`);
  }
}

function printClick(info) {
  // 试运行返回的是 wouldClick，没有 clicked。原来这里直接读 clicked.text，
  // 于是 --dryRun 一跑就崩——而 README 里恰恰宣传了这个用法。
  if (info.dryRun) {
    const w = info.wouldClick || {};
    console.log(`试运行（未点击）: 匹配 ${info.matched} 个元素`);
    console.log(`会点到  : <${w.tag}> ${compact(w.text, 80)}`);
    if (w.href) { console.log(`链接地址: ${w.href}`); }
    console.log(`是否链接: ${w.isLink}   按钮类: ${w.isButtonLike}   破坏性文案: ${w.destructive}`);
    console.log(`不传 --force: ${w.blocked ? '会被拦下' : '也会执行'}`);
    console.log(`标签页  : ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
    return;
  }
  console.log(`点击元素: ${compact(info.clicked.text, 80)}`);
  if (info.clicked.href) { console.log(`链接地址: ${info.clicked.href}`); }
  console.log(`浏览器  : ${info.browser || '未知'}`);
  console.log(`标签页  : ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
  console.log(`跳转    : ${info.navigated ? '是' : '否'}`);
  if (info.urlAfter) { console.log(`当前URL : ${info.urlAfter}`); }
  if (info.openedTabs && info.openedTabs.length) {
    console.log(`新开标签页 ${info.openedTabs.length} 个：`);
    for (const t of info.openedTabs) {
      console.log(`  [${t.id}] ${t.title}`);
      console.log(`        ${t.url}`);
    }
  }
}

function printType(info) {
  console.log(`标签页  : ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
  console.log(`目标    : <${info.tag}>  定位=${info.how}  可编辑区=${info.editable}`);
  console.log(`方式    : ${info.method}${info.cleared ? ' + 先清空' : ''}`);
  console.log(`输入字符: ${info.insertedChars}（长度 ${info.beforeLength} -> ${info.afterLength}）`);
  console.log(`execCommand: ${info.usedExecCommand ? '是' : '否（已用 Range 兜底）'}`);
  console.log(`内容预览: ${compact(info.preview, 200)}`);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

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
        return;
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
        return;
}

/** tabs 命令。 */
async function cmdTabs(args, ctx) {
  const { client, health, timeoutMs } = ctx;
        const data = await client.tabs({ browser: args.browser, timeoutMs });
        if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
        printTabs(data);
        return;
}

/** media 命令。 */
async function cmdMedia(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** grab 命令。 */
async function cmdGrab(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** save 命令。 */
async function cmdSave(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** activate 命令。 */
async function cmdActivate(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** wait 命令。 */
async function cmdWait(args, ctx) {
  const { client, health, timeoutMs } = ctx;
        requireTarget(args);
        if (!args.selector && !args.text && !args.url && !args.idle) {
          console.error('需要 --selector、--text、--url 或 --idle 指定等待条件');
          process.exit(1);
        }
        const t0 = Date.now();
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
        return;
}

/** frames 命令。 */
async function cmdFrames(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** read 命令。 */
async function cmdRead(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
          const fs = require('node:fs');
          const path = require('node:path');
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
        return;
}

/** eval 命令。 */
async function cmdEval(args, ctx) {
  const { client, health, timeoutMs } = ctx;
        requireTarget(args);
        let code = args.code;
        if (!code && args.file) {
          const fs = require('node:fs');
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
        return;
}

/** screenshot 命令。 */
async function cmdScreenshot(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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

        const fs = require('node:fs');
        const path = require('node:path');
        const out = args.out || 'screenshot.png';
        const base64 = String(data.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        const dir = path.dirname(out);
        if (dir && !fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(out, buf);
        console.log(`已保存截图: ${out}  (${data.width}x${data.height} ${data.format}, ${(buf.length / 1024).toFixed(0)} KB)`);
        return;
}

/** session 命令。 */
async function cmdSession(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** upload 命令。 */
async function cmdUpload(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** download 命令。 */
async function cmdDownload(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        const fsMod = require('node:fs');
        const pathMod = require('node:path');
        const out = args.out || data.filename || 'download.bin';
        const dir = pathMod.dirname(out);
        if (dir && !fsMod.existsSync(dir)) { fsMod.mkdirSync(dir, { recursive: true }); }
        fsMod.writeFileSync(out, Buffer.from(data.base64, 'base64'));
        console.log('已保存: ' + out + '  (' + data.bytes + ' 字节, ' + (data.contentType || '未知类型') + ')');
        return;
}

/** links 命令。 */
async function cmdLinks(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** click 命令。 */
async function cmdClick(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** type 命令。 */
async function cmdType(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** key 命令。 */
async function cmdKey(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** navigate 命令。 */
async function cmdNavigate(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** mark 命令。 */
async function cmdMark(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** reload 命令。 */
async function cmdReload(args, ctx) {
  const { client, health, timeoutMs } = ctx;
        const data = await client.reload({ browser: args.browser });
        if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
        const list = (data && data.reloaded) || [];
        for (const r of list) {
          console.log(r.ok ? `已通知重载: ${r.browser}` : `重载失败: ${r.browser} (${r.error})`);
        }
        console.log('等待重连…');
        const ready = await client.waitUntilReady(25000);
        console.log(ready ? '已重连' : '未在预期时间内重连，请检查扩展状态');
        return;
}

/** close 命令。 */
async function cmdClose(args, ctx) {
  const { client, health, timeoutMs } = ctx;
        const tabId = num(args.tabId);
        if (tabId === undefined) {
          console.error('需要 --tabId 指定要关闭的标签页（不支持按 --match 批量关闭）');
          process.exit(1);
        }
        const data = await client.close({ tabId, browser: args.browser, timeoutMs });
        if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
        console.log(`已关闭  : ${data.closedTitle}`);
        console.log(`原地址  : ${data.closedUrl}`);
        return;
}

/** unmark 命令。 */
async function cmdUnmark(args, ctx) {
  const { client, health, timeoutMs } = ctx;
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
        return;
}

/** 比较两个 semver 版本，返回 true 如果 a > b。 */
function isNewerVersion(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) { return true; }
    if (na < nb) { return false; }
  }
  return false;
}

/** 检查 npm registry 上是否有新版本，有新版本时打印一行提示。 */
async function checkUpdate() {
  try {
    const res = await fetch('https://registry.npmjs.org/agent-browser-bridge/latest', {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) { return; }
    const data = await res.json();
    const latest = data.version;
    const current = require('./package.json').version;
    if (isNewerVersion(latest, current)) {
      console.log(`[update] 新版本可用: ${latest}（当前 ${current}）`);
    }
  } catch (e) {
    // 离线或网络错误，静默失败
  }
}

/** token 命令：显示 token 文件路径和内容。 */
async function cmdToken(args) {
  const tokenFile = path.join(getConfigDir(), 'token');

  if (args.show) {
    try {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      console.log(token);
    } catch (e) {
      console.error(`无法读取 token 文件: ${tokenFile}`);
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  console.log(`Token 文件: ${tokenFile}`);
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    console.log(`Token 长度: ${token.length} 字符`);
    console.log('把 token 粘贴到扩展弹窗的输入框里');
  } catch (e) {
    console.error('Token 文件不存在。请先启动桥接服务生成 token。');
  }
}

/** log 命令：读取审计日志。 */
async function cmdLog(args) {
  const logFile = args._[1] || path.join(getConfigDir(), 'audit.jsonl');

  let content;
  try {
    content = fs.readFileSync(logFile, 'utf8');
  } catch (e) {
    console.error(`无法读取日志文件: ${logFile}`);
    console.error(e.message);
    process.exit(1);
  }

  const lines = content.split('\n').filter((l) => l.trim());
  const tail = args.tail ? parseInt(args.tail, 10) : 50;
  const tailLines = lines.slice(-tail);

  if (args.json) {
    const entries = tailLines.map((l) => JSON.parse(l));
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  for (const line of tailLines) {
    const entry = JSON.parse(line);
    const target = entry.target || {};
    const targetStr = target.tabId ? `tab=${target.tabId}` : (target.match || target.host || '-');
    console.log(`${entry.timestamp}  ${entry.action}  ${entry.outcome}  ${entry.duration}ms  ${targetStr}`);
  }
}

/** batch 命令：从 JSON 文件读步骤列表，批量执行。 */
async function cmdBatch(args, ctx) {
  const { client, timeoutMs } = ctx;
  const file = args._[1];
  if (!file) {
    console.error('用法: node src/cli.js batch <steps.json>');
    process.exit(1);
  }

  let steps;
  try {
    steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`无法读取步骤文件: ${file}`);
    console.error(e.message);
    process.exit(1);
  }

  if (!Array.isArray(steps)) {
    console.error('步骤文件必须是 JSON 数组');
    process.exit(1);
  }

  const data = await client.batch(steps, { timeoutMs });
  if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }

  for (const r of (data.results || [])) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    console.log(`  ${mark}  步骤 ${r.step}  ${r.action}  ${r.ok ? '' : r.error || ''}`);
  }
}

const COMMANDS = {
  token: cmdToken,
  log: cmdLog,
  batch: cmdBatch,
  browsers: cmdBrowsers,
  diag: cmdDiag,
  tabs: cmdTabs,
  media: cmdMedia,
  grab: cmdGrab,
  save: cmdSave,
  activate: cmdActivate,
  wait: cmdWait,
  frames: cmdFrames,
  read: cmdRead,
  eval: cmdEval,
  screenshot: cmdScreenshot,
  session: cmdSession,
  upload: cmdUpload,
  download: cmdDownload,
  links: cmdLinks,
  click: cmdClick,
  type: cmdType,
  key: cmdKey,
  navigate: cmdNavigate,
  mark: cmdMark,
  reload: cmdReload,
  close: cmdClose,
  unmark: cmdUnmark
};

/**
 * 入口：解析参数、确认服务与扩展就绪，然后把命令交给 COMMANDS 里对应的函数。
 *
 * 命令实现都在下面一张表里，一个命令一个函数——以前是一个 600 多行的 switch，
 * 想改某个命令的输出得先翻到它在哪一段。
 */
async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];

  if (!cmd || args.help) { usage(); return; }

  const client = createClient({
    port: parseInt(args.port, 10) || undefined,
    host: args.host || undefined,
    timeoutMs: parseInt(args.timeout, 10) || undefined
  });

  // 先确认服务与扩展就绪，给出比超时更明确的提示
  let health;
  try {
    health = await client.health();
  } catch (e) {
    if (e instanceof BridgeUnavailableError) {
      console.error(`无法连接桥接服务 http://127.0.0.1:${client.port}`);
      console.error('请先运行 scripts/start-server.ps1 启动服务。');
      process.exit(2);
    }
    throw e;
  }

  if (!health.extensionConnected) {
    console.error('桥接服务在线，但浏览器扩展未连接。');
    console.error('请确认浏览器已加载并启用 Agent Browser Bridge 扩展。');
    process.exit(3);
  }

  const timeoutMs = parseInt(args.timeout, 10) || undefined;
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`未知命令: ${cmd}`);
    usage();
    process.exit(1);
  }

  try {
    await handler(args, { client, health, timeoutMs });
  } catch (e) {
    if (e instanceof BridgeError) {
      console.error(JSON.stringify(e.detail, null, 2));
      process.exit(5);
    }
    if (e instanceof BridgeUnavailableError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
}

function num(v) {
  if (v === undefined || v === null || v === '') { return undefined; }
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function requireTarget(args) {
  if (!args.match && !args.url && args.tabId === undefined) {
    console.error('需要 --match、--url 或 --tabId 之一来定位标签页');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`执行失败: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
