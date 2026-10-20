/**
 * MCP 服务的客户端实例。ensure 与 handlers 共用同一个 ab。
 */

'use strict';

const { createClient } = require('../client.js');

const ab = createClient();

module.exports = { ab };
