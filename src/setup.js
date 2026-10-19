#!/usr/bin/env node
/**
 * 一条命令看清还差哪一步。
 *
 *   node setup.js            逐层自检，缺什么说什么，可在任何时候重复运行
 *   node setup.js --install  同上，并替你注册 MCP 服务（写进你自己的客户端配置）
 *   node setup.js --json     机读输出
 *
 * 默认只读不写：打印该执行的命令，不动任何配置。加了 --install 才会替你注册 MCP 服务，
 * 而那只写进你自己的客户端配置（可以 claude mcp remove 撤掉），不动这个仓库。
 *
 * 为什么要有它：这个工具的安装天然跨了四层（Node → 桥接服务 → 浏览器扩展 → 站点授权），
 * 每层失败时的表现都是"工具不工作"——用户看到的只是一句 extension_not_connected 或
 * permission_denied，不知道该去哪一层动手。这里把四层逐个查一遍，并给出下一步的具体动作。
 *
 * 最后一层会真的开一个后台标签页读写一遍再关掉，用它证明"确实通了"——
 * 这一步用的是桥接自己的地址，不需要任何站点授权，所以新装完就能跑。
 *
 * 只依赖 Node 原生模块，Windows / macOS / Linux 通用（仓库里的 .ps1 只管 Windows）。
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { createClient, BridgeError, BridgeUnavailableError } = require('./client.js');

const ARGS = process.argv.slice(2);
const AS_JSON = ARGS.includes('--json');
const INSTALL = ARGS.includes('--install');   // 替用户注册 MCP（写进他自己的客户端配置）

const EXT_DIR = path.join(__dirname, '..', 'extension');
const MCP_JS = path.join(__dirname, 'mcp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ab = createClient();

/** 各层的检查结果，最后统一汇总。 */
const layers = [];
function layer(name, state, detail, next) {
  layers.push({ name, state, detail: detail || '', next: next || '' });
  if (!AS_JSON) {
    const mark = state === 'ok' ? 'ok  ' : state === 'todo' ? '待办' : 'FAIL';
    console.log(`  ${mark}  ${name.padEnd(22)} ${detail || ''}`);
    if (next && state !== 'ok') { console.log(`        -> ${next}`); }
  }
}

/* ------------------------------------------------------------------ *
 * 1. Node 版本
 * ------------------------------------------------------------------ */
function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) {
    layer('Node 版本', 'ok', `v${process.versions.node}`);
    return true;
  }
  layer('Node 版本', 'fail', `v${process.versions.node}（需要 18 或更高）`,
    '到 https://nodejs.org 装一个 LTS 版本，装完重开终端');
  return false;
}

/* ------------------------------------------------------------------ *
 * 2. 桥接服务
 * ------------------------------------------------------------------ */
async function checkBridge() {
  try {
    const h = await ab.health();
    layer('桥接服务', 'ok', `127.0.0.1:${ab.port}（已在运行）`);
    return h;
  } catch (e) {
    if (!(e instanceof BridgeUnavailableError)) { throw e; }
  }

  // 端口上没有服务，拉一个起来。脱离本进程存活：扩展要一直有地方轮询。
  const serverPath = path.join(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 8000;
  for (;;) {
    await sleep(250);
    try {
      const h = await ab.health();
      layer('桥接服务', 'ok', `127.0.0.1:${ab.port}（本轮自行启动，pid ${child.pid}）`);
      return h;
    } catch (e) {
      if (Date.now() >= deadline) {
        layer('桥接服务', 'fail', '启动后 8 秒内没有响应',
          `手动运行 node ${serverPath} 看具体报错`);
        return null;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 3. 共享 token
 * ------------------------------------------------------------------ */
function checkToken() {
  // 与 server.js 相同的配置目录逻辑
  const configDir = (() => {
    if (process.platform === 'win32') {
      const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
      return path.join(base, 'agent-browser-bridge');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'agent-browser-bridge');
  })();

  const tokenFile = path.join(configDir, 'token');
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (token) {
      layer('共享 token', 'ok', tokenFile);
      return token;
    }
  } catch (e) {
    // 文件不存在
  }

  layer('共享 token', 'todo', '未找到 token 文件',
    `桥接服务首次启动时会生成 token。请运行 node src/server.js 启动服务，然后把 token 粘贴到扩展弹窗。`);
  return null;
}

/* ------------------------------------------------------------------ *
 * 4. 浏览器扩展
 * ------------------------------------------------------------------ */
async function checkExtension(health) {
  if (!health) {
    layer('浏览器扩展', 'fail', '桥接服务不可用，无法检查', '先修好上一层');
    return null;
  }
  if (!health.extensionConnected) {
    layer('浏览器扩展', 'fail', '没有扩展连上来',
      '在浏览器里加载扩展：打开 edge://extensions 或 chrome://extensions');
    if (!AS_JSON) {
      console.log('');
      console.log('     具体操作：');
      console.log('       1) 打开 edge://extensions 或 chrome://extensions');
      console.log('       2) 打开右上角的「开发者模式」');
      console.log('       3) 点「加载已解压的扩展程序」，选这个目录：');
      console.log(`          ${EXT_DIR}`);
      console.log('     加载完再运行一次 node setup.js。');
    }
    return null;
  }

  // 每个在线浏览器各问一遍，顺便拿到版本、扩展 ID 和站点授权
  const infos = [];
  for (const b of health.browsers) {
    try {
      const d = await ab.diag({ browser: b });
      infos.push({ browser: b, ...d });
    } catch (e) {
      infos.push({ browser: b, error: e.code || e.message });
    }
  }

  const ok = infos.filter((i) => !i.error);
  if (ok.length === 0) {
    layer('浏览器扩展', 'fail', '扩展在线但诊断请求失败',
      '打开扩展图标看弹窗状态，或运行 node src/cli.js diag');
    return null;
  }

  layer('浏览器扩展', 'ok',
    ok.map((i) => `${i.browser} v${i.version}`).join('、'));

  // ID 与服务端允许列表是否一致。真扩展的请求不带 Origin，所以对不上不会立刻报错，
  // 但一旦对不上，说明"服务端以为在放行谁"和"扩展实际是谁"已经脱节了。
  const allowed = health.allowedExtensionIds || [];
  const mismatched = ok.filter((i) => i.extensionId && allowed.length && !allowed.includes(i.extensionId));
  if (mismatched.length) {
    layer('扩展 ID', 'fail',
      `${mismatched[0].extensionId} 不在服务端允许列表里`,
      `用 --allow-extension ${mismatched[0].extensionId} 启动桥接服务`);
  } else {
    layer('扩展 ID', 'ok', ok[0].extensionId ? `与服务端一致（${ok[0].extensionId}）` : '（该版本未上报 ID）');
  }

  return ok[0];
}

/* ------------------------------------------------------------------ *
 * 4. 站点授权
 * ------------------------------------------------------------------ */
function checkGrants(info) {
  if (!info) {
    layer('站点授权', 'todo', '扩展不可用，无法检查', '先修好上一层');
    return false;
  }
  const origins = info.grantedOrigins || [];
  if (info.allSitesGranted) {
    layer('站点授权', 'ok', `已授权所有站点`);
  } else if (origins.length > 0) {
    layer('站点授权', 'ok', `已授权 ${origins.length} 个站点：${origins.slice(0, 3).join('、')}${origins.length > 3 ? ' 等' : ''}`);
  } else {
    layer('站点授权', 'todo', '还没有授权任何站点，agent 现在读不了任何页面',
      '点浏览器工具栏上的扩展图标 → 填主机名 → 授权（或点「授权所有站点」）');
    return false;
  }
  if (!AS_JSON) {
    console.log(`        （cookies 权限：${info.cookiesGranted ? '已授予，session 可用' : '未授予，只有 session 需要它'}）`);
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 5. 端到端冒烟：真的开一个后台标签页读写一遍
 * ------------------------------------------------------------------ */
async function smokeTest(info) {
  if (!info) {
    layer('端到端冒烟', 'todo', '扩展不可用，跳过', '先修好上一层');
    return false;
  }
  let tabId = null;
  try {
    // 用桥接自己的地址：它在清单的必需 host_permissions 里，天然已授权，
    // 所以这一步不依赖用户授过任何站点，新装完就能验。
    const nav = await ab.navigate({ url: `http://127.0.0.1:${ab.port}/health`, newTab: true });
    tabId = nav.tabId;
    const rd = await ab.read({ tabId });
    if (!rd || typeof rd.text !== 'string' || rd.charCount <= 0) {
      layer('端到端冒烟', 'fail', '能开标签页但读不到内容', '运行 node test-live.js 看是哪一步断的');
      return false;
    }
    layer('端到端冒烟', 'ok', `开了后台标签页、读到 ${rd.charCount} 字、已关闭（标签页 ${tabId}）`);
    return true;
  } catch (e) {
    const code = e instanceof BridgeError ? e.code : (e && e.message) || String(e);
    layer('端到端冒烟', 'fail', `失败：${code}`, '运行 node test-live.js 进一步定位');
    return false;
  } finally {
    if (tabId !== null) {
      try { await ab.unmark({ tabId }); } catch (e) { /* 忽略 */ }
      try { await ab.close({ tabId }); } catch (e) { /* 忽略 */ }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 6. MCP 注册
 *
 * 这里只打印怎么注册，不改任何客户端配置。
 *
 * 两个原因：
 *   - 各人机器上 `claude` 的形态不同（有的是 PATH 上的可执行文件，有的只是 shell 函数，
 *     实测本机就是 bash 函数，子进程调不到），靠它自动注册并不可靠；
 *   - 客户端的配置文件里还存着别的状态，替用户改它风险大于收益。
 * 所以只给现成的命令，由用户自己执行——那一步本来就该由他决定。
 * ------------------------------------------------------------------ */
function checkMcp() {
  // 项目里已经有一份 .mcp.json 且指向本仓库，就认为配过了
  const localCfg = path.join(__dirname, '..', '.mcp.json');
  let configured = false;
  try {
    if (fs.existsSync(localCfg)) {
      configured = fs.readFileSync(localCfg, 'utf8').includes('mcp.js');
    }
  } catch (e) { /* 读不到就当没配 */ }

  if (configured) {
    layer('MCP 注册', 'ok', '项目里的 .mcp.json 已指向 mcp.js');
    return true;
  }

  const q = (p) => (process.platform === 'win32' ? `"${p}"` : p);
  const cmd = `claude mcp add -s user browser -- node ${q(MCP_JS)}`;

  // --install：替用户执行注册。写的是他自己的客户端配置（可以 claude mcp remove 撤掉），
  // 不是这个仓库；不带这个参数时只打印命令，绝不改动任何配置。
  if (INSTALL) {
    if (spawnSync('claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0) {
      const r = spawnSync('claude',
        ['mcp', 'add', '-s', 'user', 'browser', '--', 'node', MCP_JS],
        { encoding: 'utf8', shell: process.platform === 'win32' });
      if (r.status === 0) {
        layer('MCP 注册', 'ok', '已注册到 user scope，重开 agent 会话后生效');
        return true;
      }
      layer('MCP 注册', 'fail', `注册命令返回 ${r.status}`,
        String(r.stderr || r.stdout || '').trim().split('\n')[0] || cmd);
      return false;
    }
    layer('MCP 注册', 'todo', 'PATH 上找不到 claude 命令，请手动执行', cmd);
    return false;
  }

  layer('MCP 注册', 'todo', '把浏览器能力给 agent 需要注册一次（写进你自己的客户端配置）', cmd);

  if (!AS_JSON) {
    console.log('');
    console.log('     Claude Code 用上面那条命令；其他 MCP 客户端在它的配置里加：');
    console.log('       {');
    console.log('         "mcpServers": {');
    console.log('           "browser": {');
    console.log(`             "command": "node",`);
    console.log(`             "args": ["${MCP_JS.replace(/\\/g, '\\\\')}"]`);
    console.log('           }');
    console.log('         }');
    console.log('       }');
    console.log('     注册后让 agent 调一次 browser_status 确认通了。');
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
(async () => {
  if (!AS_JSON) {
    console.log('\nAgent Browser Bridge 自检\n');
    console.log(`  仓库位置  ${path.join(__dirname, '..')}`);
    console.log('');
  }

  const nodeOk = checkNode();
  let health = null;
  let info = null;
  let smokeOk = false;

  if (nodeOk) {
    health = await checkBridge();
    checkToken();
    info = await checkExtension(health);
  }

  const granted = checkGrants(info);
  if (info) { smokeOk = await smokeTest(info); }
  else { layer('端到端冒烟', 'todo', '扩展未连接，跳过', '先加载扩展，再运行 node setup.js'); }

  checkMcp();

  const failed = layers.filter((l) => l.state === 'fail');
  const todo = layers.filter((l) => l.state === 'todo');

  if (AS_JSON) {
    console.log(JSON.stringify({ layers, ok: failed.length === 0 }, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
  }

  console.log('');
  if (failed.length) {
    console.log(`结论：还有 ${failed.length} 层不通（${failed.map((l) => l.name).join('、')}），先按上面的提示处理。`);
  } else if (todo.length) {
    console.log('结论：工具本身已经通了，还差下面这些交给你的部分。');
  } else {
    console.log('结论：全部就绪。');
  }

  if (!granted && !failed.length) {
    console.log('');
    console.log('  别忘了站点授权——没有它 agent 读不到任何页面。');
  }
  if (!smokeOk && !failed.length) {
    console.log('  端到端冒烟没跑成，说明读写链路还有问题，运行 node test-live.js 定位。');
  }
  console.log('');

  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  if (AS_JSON) {
    console.log(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  } else {
    console.error(`自检本身出错：${e && e.message ? e.message : e}`);
  }
  process.exit(1);
});
