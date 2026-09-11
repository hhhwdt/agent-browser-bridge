/**
 * 测试用：从 extension/sw/ 的模块里取出真实的函数源码。
 *
 * 服务脚本拆分之后，函数分散在多个模块里。测试不该写死"某函数在某个文件"——
 * 那样下次重构会让测试静默失效（找不到就跳过，看起来还是绿的）。这里按名字在
 * 所有模块里找，找不到就明确报错。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SW_DIR = path.join(__dirname, '..', 'extension', 'sw');

/** 所有服务脚本模块的源码。 */
function swSources() {
  return fs.readdirSync(SW_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(SW_DIR, f), 'utf8') }));
}

/**
 * 取出某个顶层函数的源码（含 export 前缀已剥离，可直接当表达式求值）。
 *
 * 与 Chrome 注入页面时看到的一致：executeScript 序列化的是函数自身的源码，
 * export 关键字不在其中（V8 的 Function.prototype.toString 不返回它）。
 * 这里主动剥掉，让测试里的 new Function 更贴近真实注入。
 */
function extractFunction(name) {
  for (const { file, src } of swSources()) {
    const m = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function ${name}\\(`, 'm').exec(src);
    if (!m) { continue; }
    const start = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') { depth++; }
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) {
          return { src: src.slice(m.index, j + 1).replace(/^export\s+/, ''), file };
        }
      }
    }
  }
  return null;
}

module.exports = { extractFunction, swSources, SW_DIR };
