#!/usr/bin/env node
/**
 * Agent Browser Bridge —— MCP 服务入口。
 * 实现拆在 src/mcp/ 下，本文件只保留入口，
 * `node src/mcp.js` 与 package.json 的 bin 都是这条路径。
 */

'use strict';

require('./mcp/index.js');
