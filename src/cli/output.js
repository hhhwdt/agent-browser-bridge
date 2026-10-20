/**
 * CLI 输出辅助：人类可读的结果打印。
 */

'use strict';

const compact = (s, n = 60) => {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
};

function printTabs(data) {
  console.log(`共 ${data.tabs.length} 个标签页：`);
  for (const t of data.tabs) {
    console.log(`${t.active ? '*' : ' '} [${t.id}] ${t.title}`);
    console.log(`      ${t.url}`);
  }
}

function printRead(info, outPath) {
  if (outPath) {
    console.log(`标题    : ${info.title}`);
    console.log(`URL     : ${info.url}`);
    console.log(`浏览器  : ${info.browser || '未知'}`);
    console.log(`标签页  : ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
    console.log(`选择器  : ${info.usedSelector}`);
    console.log(`字符数  : ${info.charCount}`);
    console.log(`已写入  : ${outPath}`);
    return;
  }
  console.log(`标题  : ${info.title}`);
  console.log(`URL   : ${info.url}`);
  console.log(`浏览器: ${info.browser || '未知'}`);
  console.log(`标签页: ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
  console.log(`字符数: ${info.charCount}`);
  console.log('---');
  console.log(info.text);
}

function printLinks(info) {
  console.log(`页面  : ${info.title}`);
  console.log(`URL   : ${info.url}`);
  console.log(`链接数: ${info.links.length}`);
  console.log('---');
  for (const l of info.links) {
    console.log(`[${l.index}] ${l.visible ? ' ' : '隐'} ${compact(l.text, 80)}`);
    console.log(`      ${l.href}`);
  }
}

function printClick(info) {
  // 试运行返回的是 wouldClick，没有 clicked。原来这里直接读 clicked.text，
  // 于是 --dryRun 一跑就崩——而 README 里恰恰宣传了这个用法。
  if (info.dryRun) {
    const w = info.wouldClick || {};
    console.log(`试运行（未点击）: 匹配 ${info.matched} 个元素`);
    console.log(`会点到  : <${w.tag}> ${compact(w.text, 80)}`);
    if (w.href) { console.log(`链接地址: ${w.href}`); }
    console.log(`是否链接: ${w.isLink}   按钮类: ${w.isButtonLike}   破坏性文案: ${w.destructive}`);
    console.log(`不传 --force: ${w.blocked ? '会被拦下' : '也会执行'}`);
    console.log(`标签页  : ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
    return;
  }
  console.log(`点击元素: ${compact(info.clicked.text, 80)}`);
  if (info.clicked.href) { console.log(`链接地址: ${info.clicked.href}`); }
  console.log(`浏览器  : ${info.browser || '未知'}`);
  console.log(`标签页  : ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
  console.log(`跳转    : ${info.navigated ? '是' : '否'}`);
  if (info.urlAfter) { console.log(`当前URL : ${info.urlAfter}`); }
  if (info.openedTabs && info.openedTabs.length) {
    console.log(`新开标签页 ${info.openedTabs.length} 个：`);
    for (const t of info.openedTabs) {
      console.log(`  [${t.id}] ${t.title}`);
      console.log(`        ${t.url}`);
    }
  }
}

function printType(info) {
  console.log(`标签页  : ${info.tabId}${info.wasActive ? '（当前激活）' : '（后台）'}`);
  console.log(`目标    : <${info.tag}>  定位=${info.how}  可编辑区=${info.editable}`);
  console.log(`方式    : ${info.method}${info.cleared ? ' + 先清空' : ''}`);
  console.log(`输入字符: ${info.insertedChars}（长度 ${info.beforeLength} -> ${info.afterLength}）`);
  console.log(`execCommand: ${info.usedExecCommand ? '是' : '否（已用 Range 兜底）'}`);
  console.log(`内容预览: ${compact(info.preview, 200)}`);
}

module.exports = { compact, printTabs, printRead, printLinks, printClick, printType };
