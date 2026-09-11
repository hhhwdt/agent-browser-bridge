/**
 * 测试配置加载器。
 *
 * 优先读取本机 test-config.js（已被 .gitignore 忽略），
 * 不存在时回退到 test-config.example.js 并提示用户配置。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCAL = path.join(__dirname, 'test-config.js');
const TEMPLATE = path.join(__dirname, 'test-config.example.js');

/** 载入测试配置；缺少本机配置时给出明确提示。 */
function loadTestConfig() {
  let cfg = null;
  let fromTemplate = false;

  if (fs.existsSync(LOCAL)) {
    cfg = require(LOCAL);
  } else {
    cfg = require(TEMPLATE);
    fromTemplate = true;
  }

  if (!cfg || !cfg.pageUrl) {
    console.error('测试配置缺少 pageUrl。');
    process.exit(1);
  }

  if (fromTemplate || /example\.com/.test(cfg.pageUrl)) {
    console.error('尚未配置测试目标站点。');
    console.error('请先执行:  cp test-config.example.js test-config.js');
    console.error('然后编辑 test-config.js，填入一个已登录、可安全操作的页面地址。');
    console.error('');
    console.error('注意：测试会新建并关闭标签页，还会写入内容，请勿指向生产文档。');
    process.exit(1);
  }

  return cfg;
}

module.exports = { loadTestConfig };
