#!/usr/bin/env node
/**
 * Agent Browser Bridge —— 本机桥接服务（入口）。
 *
 * 作用：在"浏览器扩展"和"任意本机 agent"之间转发操作请求。
 * 任何本机程序只要会发 HTTP 就能用，不限定具体的 agent 实现。
 *
 * 依赖：仅 Node 原生模块，无需 npm install。
 *
 * 启动：
 *   node server.js            默认端口 18777
 *   node server.js --port 18778
 *
 * HTTP 接口（全部只监听 127.0.0.1）。每个动作的完整入参与返回见 README.md，
 * 这里只列清单，方便定位：
 *
 *   GET  /health  /capabilities   状态、apiVersion、能力清单、在线浏览器
 *   GET  /tabs                    标签页清单（含 discarded / status / favIconUrl）
 *   POST /read   /links   /media          读取类
 *   POST /click  /type    /key   /navigate /eval   交互类
 *   POST /save   /grab    /download   /upload      文件类
 *   POST /session                         站点 Cookie 与存储（需 cookies 可选权限）
 *   POST /screenshot                      截图（走 debugger）
 *   POST /wait   /frames  /diag           同步与诊断
 *   POST /mark   /unmark  /activate /close /reload  标签页与扩展管理
 *   GET  /poll   /result                  扩展专用（长轮询与回传）
 *
 * 路由说明：
 *   请求可带 browser 指定 edge / chrome；未指定时按 edge → chrome 顺序逐个尝试，
 *   命中真正包含目标标签页的那个浏览器。任务只投递给目标浏览器自己的队列。
 *
 * 安全说明：
 *   - 只绑定 127.0.0.1，不对局域网或外网开放。
 *   - 校验 Origin，拒绝来自普通网页的请求，避免恶意页面通过 CSRF 驱动扩展。
 *   - 服务端本身不做任何页面操作，只做转发；是否可操作由浏览器扩展的站点授权决定。
 *
 * 模块划分：
 *   config.js   命令行参数与静态配置
 *   token.js    共享 token 的生成与校验
 *   audit.js    审计日志
 *   leases.js   per-tab 互斥
 *   http.js     请求体读写、CORS、来源校验
 *   queue.js    长轮询连接与任务派发
 *   routes/     一个接口一个函数，路由表在本文件
 *   update.js   更新检查（cli 有自己独立的一份，行为不同：无缓存、每次现查）
 */

'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { PORT, HOST } = require('./config.js');
const { hasValidToken } = require('./token.js');
const { sendJson, isAllowedOrigin, isExtensionOrigin, reportRejectedOrigin } = require('./http.js');
const { checkUpdate } = require('./update.js');
const poll = require('./routes/poll.js');
const read = require('./routes/read.js');
const files = require('./routes/files.js');
const interact = require('./routes/interact.js');

/* ------------------------------------------------------------------ *
 * 路由表
 *
 * 一个路径一行。加接口时改这里，而不是往一个巨大的 if 链里塞——见 docs/ARCHITECTURE.md。
 * ------------------------------------------------------------------ */
const ROUTES = new Map();
for (const [method, paths, handler] of [
  ['GET', ['/health', '/capabilities'], read.routeHealth],
  ['GET', ['/poll'], poll.routePoll],
  ['POST', ['/result'], poll.routeResult],
  ['GET', ['/tabs'], read.routeTabs],
  ['POST', ['/frames'], read.routeFrames],
  ['POST', ['/media'], read.routeMedia],
  ['POST', ['/read'], read.routeRead],
  ['POST', ['/links'], read.routeLinks],
  ['POST', ['/screenshot'], read.routeScreenshot],
  ['POST', ['/eval'], read.routeEval],
  ['POST', ['/session'], read.routeSession],
  ['POST', ['/download'], files.routeDownload],
  ['POST', ['/grab'], files.routeGrab],
  ['POST', ['/save'], files.routeSave],
  ['POST', ['/upload'], files.routeUpload],
  ['POST', ['/click'], interact.routeClick],
  ['POST', ['/type'], interact.routeType],
  ['POST', ['/key'], interact.routeKey],
  ['POST', ['/navigate'], interact.routeNavigate],
  ['POST', ['/wait'], interact.routeWait],
  ['POST', ['/close'], interact.routeClose],
  ['POST', ['/activate'], interact.routeActivate],
  ['POST', ['/diag'], read.routeDiag],
  ['POST', ['/reload'], read.routeReload],
  ['POST', ['/mark', '/unmark'], interact.routeMark],
  ['POST', ['/batch'], interact.routeBatch]
]) {
  for (const p of paths) { ROUTES.set(`${method} ${p}`, handler); }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (!isAllowedOrigin(req)) {
    reportRejectedOrigin(req.headers.origin);
    sendJson(res, 403, {
      ok: false,
      error: 'origin_not_allowed',
      origin: req.headers.origin,
      hint: '只接受本机来源，以及允许列表内扩展的 chrome-extension:// 来源。'
        + '自己加载的扩展可用 --allow-extension <扩展ID> 追加（ID 见 node src/cli.js diag）。'
    }, req);
    return;
  }

  // ---- CORS 预检 ----
  if (req.method === 'OPTIONS') {
    const headers = { 'Content-Length': '0' };
    const origin = req.headers.origin;
    if (isExtensionOrigin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Max-Age'] = '600';
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const route = ROUTES.get(`${req.method} ${path}`);
  if (!route) {
    sendJson(res, 404, { ok: false, error: 'not_found', path }, req);
    return;
  }

  // token 校验：/health 保持开放（用于探测服务在线），其余路由都需要
  if (path !== '/health' && !hasValidToken(req)) {
    sendJson(res, 401, {
      ok: false,
      error: 'token_required',
      hint: '需要 X-ABB-Token 请求头。请从桥接服务配置目录的 token 文件复制到扩展弹窗。'
    }, req);
    return;
  }

  await route(req, res, { url, path });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    sendJson(res, 500, { ok: false, error: 'server_error', message: String(e && e.message ? e.message : e) }, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Browser Bridge 已启动: http://${HOST}:${PORT}`);
  console.log('等待浏览器扩展连接…');
  checkUpdate();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。`);
    // 别建议换端口：扩展里的 BRIDGE_URL 是写死的 127.0.0.1:18777，
    // 换了端口扩展就找不到服务（表现为一直 extension_not_connected）。
    // 占用这个端口的几乎总是上一次没关干净的自己（被 --detach 拉起的那个）。
    console.error('先确认占用者是不是上一轮残留的本服务进程（tasklist / ps 里找 node）。');
    console.error('真要换端口，扩展里的 BRIDGE_URL 必须同步改，否则扩展连不上。');
  } else {
    console.error(`服务启动失败: ${e.message}`);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
});
