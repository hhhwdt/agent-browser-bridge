/**
 * Agent Browser Bridge —— HTTP 工具与请求来源校验。
 */

'use strict';

const { URL } = require('node:url');
const { allowedExtensionIds } = require('./config.js');

/**
 * 判断来源是否为「允许列表里的扩展」。
 * 只认 ID，不认 chrome-extension:// 这个前缀——前缀对用户装的每个扩展都成立。
 */
function isExtensionOrigin(origin) {
  if (typeof origin !== 'string') { return false; }
  const m = /^(?:chrome|moz)-extension:\/\/([^/]+)/i.exec(origin);
  if (!m) { return false; }
  return allowedExtensionIds.has(m[1].toLowerCase());
}

/** 被拒绝的来源只提示一次，避免刷屏。 */
const reportedRejectedOrigins = new Set();
function reportRejectedOrigin(origin) {
  const key = String(origin || '(无 Origin)');
  if (reportedRejectedOrigins.has(key)) { return; }
  reportedRejectedOrigins.add(key);
  const ext = /^(?:chrome|moz)-extension:\/\/([^/]+)/i.exec(key);
  console.warn(ext
    ? `[bridge] 拒绝扩展 ${ext[1]}。若是你自己加载的扩展，用 --allow-extension ${ext[1]} 加入允许列表。`
    : `[bridge] 拒绝来源 ${key}（只接受本机来源与允许列表内的扩展）。`);
}

function sendJson(res, status, payload, req) {
  const body = JSON.stringify(payload ?? {});
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  };

  // 对扩展来源显式回 CORS 头。清单里已授权本机桥接地址，这里是额外保险，
  // 让不同 Chromium 版本下都能正常通信。
  const origin = req && req.headers && req.headers.origin;
  if (isExtensionOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** 读 JSON 请求体。失败时已经回过 400，返回 null，调用方直接 return。 */
async function readJsonBody(req, res, limitBytes) {
  try {
    return await readBody(req, limitBytes);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message }, req);
    return null;
  }
}

/**
 * 校验请求来源。
 * 允许：无 Origin（本机脚本）、扩展页面、本机 http 来源。
 * 拒绝：任何来自普通网站的请求，防止网页发起 CSRF 驱动扩展读取数据。
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) { return true; }
  if (isExtensionOrigin(origin)) { return true; }
  try {
    const u = new URL(origin);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') { return true; }
  } catch (e) { /* 非法 Origin，落到拒绝分支 */ }
  return false;
}

/** 目标定位是否缺失：match / url / tabId 三选一。 */
function targetMissing(body) {
  return !body.match && !body.url && typeof body.tabId !== 'number';
}

function badRequest(res, req, error, hint) {
  sendJson(res, 400, hint ? { ok: false, error, hint } : { ok: false, error }, req);
}

module.exports = {
  isExtensionOrigin,
  reportRejectedOrigin,
  sendJson,
  readBody,
  readJsonBody,
  isAllowedOrigin,
  targetMissing,
  badRequest
};
