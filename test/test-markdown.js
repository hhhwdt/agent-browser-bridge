#!/usr/bin/env node
/**
 * Markdown 转换测试：从 extension/sw/ 里抽出真实的 markdownInPage 源码，在 Node 里用假 DOM 驱动。
 *
 * 防的失败：HTML 转 Markdown 时丢失结构（标题、列表、表格），
 * 或者把页面内容原样塞进 Markdown（等于没转）。
 *
 *   node test-markdown.js
 */

'use strict';

const { extractFunction } = require('./sw-source.js');

const found = extractFunction('markdownInPage');
if (!found) {
  console.error('在 extension/sw/ 里找不到 markdownInPage，测试无法进行');
  process.exit(1);
}
const markdownInPage = new Function('return ' + found.src)();

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 200)}`);
  }
}

/** 构造一个简单的 DOM 元素。 */
function makeEl(tag, text, children) {
  let kids = children || [];
  if (!children && text) {
    kids = [{ nodeType: 3, textContent: text, childNodes: [] }];
  }
  return {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    childNodes: kids,
    textContent: text || '',
    getAttribute: () => null,
    children: kids
  };
}

/** 构造一个文本节点。 */
function makeText(text) {
  return { nodeType: 3, textContent: text, childNodes: [] };
}

/** 构造一个容器元素，把 children 包进去。 */
function makeContainer(children) {
  return makeEl('DIV', '', children);
}

(async () => {
  // 标题
  let r = markdownInPage(makeContainer([makeEl('H1', 'Hello')]));
  check('H1 转成 # ', r.ok && r.markdown === '# Hello', `got: ${r.markdown}`);

  r = markdownInPage(makeContainer([makeEl('H2', 'World')]));
  check('H2 转成 ## ', r.ok && r.markdown === '## World', `got: ${r.markdown}`);

  // 段落
  r = markdownInPage(makeContainer([makeEl('P', 'This is a paragraph.')]));
  check('段落转成纯文本', r.ok && r.markdown === 'This is a paragraph.', `got: ${r.markdown}`);

  // 链接
  const a = makeEl('A', 'Click here');
  a.getAttribute = (name) => name === 'href' ? 'https://example.com' : null;
  r = markdownInPage(makeContainer([makeEl('P', '', [makeText('Visit '), a, makeText(' for more.')])]));
  check('链接转成 Markdown 格式', r.ok && r.markdown.includes('[Click here](https://example.com)'),
    `got: ${r.markdown}`);

  // 无序列表
  r = markdownInPage(makeContainer([makeEl('UL', '', [makeEl('LI', 'Item 1'), makeEl('LI', 'Item 2')])]));
  check('无序列表转成 - ', r.ok && r.markdown.includes('- Item 1') && r.markdown.includes('- Item 2'),
    `got: ${r.markdown}`);

  // 行内代码
  const code = makeEl('CODE', 'const x = 1;');
  r = markdownInPage(makeContainer([makeEl('P', '', [makeText('Use '), code, makeText(' here.')])]));
  check('行内代码转成 ` `', r.ok && r.markdown.includes('`const x = 1;`'), `got: ${r.markdown}`);

  // 代码块
  r = markdownInPage(makeContainer([makeEl('PRE', 'line 1\nline 2')]));
  check('代码块转成 ``` ', r.ok && r.markdown.includes('```') && r.markdown.includes('line 1'), `got: ${r.markdown}`);

  // 空元素
  r = markdownInPage(null);
  check('空元素返回 error', !r.ok && r.error === 'element_not_found');

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
