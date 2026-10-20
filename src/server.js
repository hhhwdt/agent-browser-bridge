#!/usr/bin/env node
/**
 * Agent Browser Bridge —— 桥接服务入口。
 * 实现拆在 src/server/ 下，本文件只保留启动入口，
 * `node src/server.js` 与 package.json 的 scripts 都是这条路径。
 */

'use strict';

require('./server/index.js');
