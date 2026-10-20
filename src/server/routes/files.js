/**
 * Agent Browser Bridge —— 路由：文件类（下载、抓取、保存、上传）。
 *
 * 四个动作都是直排的（校验 + 组装任务 + 派发），全部由动作注册表驱动。
 */

'use strict';

const { makeRoute } = require('./generic.js');

const routeDownload = makeRoute('download');
const routeGrab = makeRoute('grab');
const routeSave = makeRoute('save');
const routeUpload = makeRoute('upload');

module.exports = { routeDownload, routeGrab, routeSave, routeUpload };
