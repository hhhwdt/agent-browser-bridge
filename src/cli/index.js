#!/usr/bin/env node
/**
 * Agent Browser Bridge —— 命令行客户端（入口）。
 *
 * 本文件只做参数解析、命令路由与就绪检查；
 * 各命令实现在 src/cli/commands/ 下，输出辅助在 src/cli/output.js。
 * 其他 agent 若要集成，直接引用 client.js 即可，不必调用本文件。
 *
 * 用法见 `node src/cli.js --help`。
 */

'use strict';

const { createClient, BridgeError, BridgeUnavailableError } = require('../client.js');
const { parseArgs } = require('./args.js');
const info = require('./commands/info.js');
const actions = require('./commands/actions.js');
const files = require('./commands/files.js');
const admin = require('./commands/admin.js');

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
 * 命令表
 * ------------------------------------------------------------------ */

const COMMANDS = {
  token: admin.cmdToken,
  log: admin.cmdLog,
  batch: admin.cmdBatch,
  browsers: info.cmdBrowsers,
  diag: info.cmdDiag,
  tabs: info.cmdTabs,
  media: info.cmdMedia,
  grab: files.cmdGrab,
  save: files.cmdSave,
  activate: actions.cmdActivate,
  wait: actions.cmdWait,
  frames: info.cmdFrames,
  read: info.cmdRead,
  eval: info.cmdEval,
  screenshot: info.cmdScreenshot,
  session: info.cmdSession,
  upload: files.cmdUpload,
  download: files.cmdDownload,
  links: info.cmdLinks,
  click: actions.cmdClick,
  type: actions.cmdType,
  key: actions.cmdKey,
  navigate: actions.cmdNavigate,
  mark: actions.cmdMark,
  reload: actions.cmdReload,
  close: actions.cmdClose,
  unmark: actions.cmdUnmark
};

/**
 * 入口：解析参数、确认服务与扩展就绪，然后把命令交给 COMMANDS 里对应的函数。
 *
 * 命令实现都在上面一张表里，一个命令一个函数——以前是一个 600 多行的 switch，
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

main().catch((e) => {
  console.error(`执行失败: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
