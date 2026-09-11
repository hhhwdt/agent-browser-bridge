#!/usr/bin/env node
/**
 * Agent Browser Bridge —— 命令行客户端。
 *
 * 本文件是 client.js 的命令行包装，自身不含通信逻辑；
 * 其他 agent 若要集成，直接引用 client.js 即可，不必调用本文件。
 *
 * 用法见 `node read.js --help`。
 */

'use strict';

const { createClient, BridgeError, BridgeUnavailableError } = require('./client.js');

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };

  // 需要取值的选项；其余 --xxx 视为布尔开关
  const VALUE_OPTS = new Set([
    'match', 'url', 'tabId', 'frameId', 'browser', 'selector', 'text', 'href',
    'value', 'key', 'index', 'port', 'timeout', 'host'
  ]);

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (VALUE_OPTS.has(key)) {
      out[key] = argv[++i];
    } else {
      out[key] = true;
    }
  }
  return out;
}

function usage() {
  console.log(`Agent Browser Bridge 命令行客户端

用法:
  node read.js browsers
  node read.js tabs [--browser edge|chrome]

  node read.js read --match "<URL子串>" [--selector CSS] [--links] [--html] [--out 文件] [--json]

    --html  额外返回元素 outerHTML 与可编辑区域清单，用于定位选择器

  node read.js links --match "<URL子串>" [--text 关键字] [--selector CSS]

  node read.js click --match "<URL子串>" (--text "<文字>" | --href "<地址片段>" | --selector CSS) [--index N] [--force] [--dryRun]

  node read.js type --match "<URL子串>" --value "<文本>" [--selector CSS | --text "<字段名>"] [--clear] [--html] [--force]

  node read.js key --match "<URL子串>" --key Enter [--selector CSS] [--ctrl] [--shift]

  node read.js navigate --url "https://..." [--newTab] [--match "<URL子串>" | --tabId N]

  node read.js mark   --match "<URL子串>" [--text "标记说明"]
  node read.js unmark [--match "<URL子串>" | --tabId N]   # 不指定则清除全部
  node read.js close  --tabId N                           # 必须显式指定 tabId
  node read.js reload                                     # 改动扩展代码后重载扩展

  node read.js frames --match "<URL子串>"                 # 诊断框架（编辑器在哪个 iframe）
  node read.js wait   --match "<URL子串>" --selector "#id" [--disappear] [--timeout 10000]

公共选项:
  --browser <s>    指定浏览器（edge / chrome）；省略时自动选择
  --frameId <n>    指定框架 id；富文本编辑器常在 iframe 内，用 frames 查出后指定
  --port <n>       桥接服务端口，默认 18777
  --timeout <ms>   等待超时，默认 30000
  --json           输出完整 JSON

框架诊断:
  node read.js frames --match "<URL子串>"
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
      console.error('请先运行 start-server.ps1 启动服务。');
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

  try {
    switch (cmd) {
      case 'browsers': {
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

      case 'tabs': {
        const data = await client.tabs({ browser: args.browser, timeoutMs });
        if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
        printTabs(data);
        return;
      }

      case 'activate': {
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

      case 'wait': {
        requireTarget(args);
        if (!args.selector && !args.text) {
          console.error('需要 --selector 或 --text 指定等待条件');
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
          state: args.disappear ? 'disappear' : 'appear',
          timeoutMs: num(args.timeout) || 10000,
          browser: args.browser
        });
        if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
        console.log(`条件已成立（等待 ${data.elapsedMs}ms）`);
        console.log(`标签页: ${data.tabId}  框架: ${data.frameId}  状态: ${data.state}`);
        return;
      }

      case 'frames': {
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

      case 'read': {
        requireTarget(args);
        const data = await client.read({
          match: args.match,
          url: args.url,
          tabId: num(args.tabId),
          frameId: num(args.frameId),
          selector: args.selector,
          includeLinks: !!args.links,
          returnHtml: !!args.html,
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

      case 'links': {
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

      case 'click': {
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

      case 'type': {
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

      case 'key': {
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

      case 'navigate': {
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

      case 'mark': {
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

      case 'reload': {
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

      case 'close': {
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

      case 'unmark': {
        const data = await client.unmark({
          match: args.match,
          url: args.url,
          tabId: num(args.tabId),
          browser: args.browser,
          timeoutMs
        });
        if (args.json) { console.log(JSON.stringify(data, null, 2)); return; }
        console.log(`已清除标记 ${data.cleared.length} 个标签页：${data.cleared.join(', ') || '（无）'}`);
        return;
      }

      default:
        console.error(`未知命令: ${cmd}`);
        usage();
        process.exit(1);
    }
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
