/**
 * Agent Browser Bridge —— 动作实现的总入口（re-export）。
 *
 * 原来所有动作都写在这一个文件里，现在按主题拆开：
 *   actions-tabs.js        标签页元信息、等待、激活、框架诊断
 *   actions-read.js        正文 / eval / 媒体候选 / 链接
 *   actions-screenshot.js  截图
 *   actions-session.js     登录态
 *   actions-files.js       上传 / 抓取 / 保存 / 下载
 *   actions-interact.js    点击 / 导航 / 输入 / 按键
 * 这里用 re-export 保住 background.js 与测试的导入路径。
 */

export * from './actions-tabs.js';
export * from './actions-read.js';
export * from './actions-screenshot.js';
export * from './actions-session.js';
export * from './actions-files.js';
export * from './actions-interact.js';
