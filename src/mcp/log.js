/**
 * MCP 侧共享的小工具：stderr 日志与工具结果包装。
 */

'use strict';

/** 日志只走 stderr——stdout 只能走协议消息，打普通文本会破坏 stdio 协议。 */
function log(...args) {
  process.stderr.write('[abb-mcp] ' + args.map(String).join(' ') + '\n');
}

/** 把一段文字包装成 MCP 工具结果。 */
function text(t) {
  return { content: [{ type: 'text', text: String(t) }] };
}

/** 同 text，但标记 isError，让客户端把它当错误展示。 */
function errorText(t) {
  return { content: [{ type: 'text', text: String(t) }], isError: true };
}

module.exports = { log, text, errorText };
