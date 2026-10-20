#!/usr/bin/env node
/**
 * Agent Browser Bridge —— 命令行客户端入口。
 * 实现拆在 src/cli/ 下，本文件只保留入口，
 * `node src/cli.js` 与 package.json 的 bin 都是这条路径。
 */

'use strict';

require('./cli/index.js');
