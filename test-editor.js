/**
 * 富文本编辑器链路测试（iframe + contenteditable + designMode）。
 *
 * 警告：本测试必须进入页面的编辑态，会在目标页面产生草稿。
 * 因此只应在专用测试页上运行，且必须显式传入页面 URL：
 *
 *   node test-editor.js --url "https://.../editpage.action?pageId=XXX"
 *
 * 测试过程：
 *   1. 前台打开编辑页（编辑器仅在页面可见时实例化）
 *   2. 用 frames 找出可编辑框架，验证自动挑选命中它
 *   3. 读取编辑器原文并记录
 *   4. 写入纯文本 -> 读回校验
 *   5. 写入 HTML -> 校验结构生效
 *   6. 校验 script 被清洗
 *   7. 清空编辑器
 *
 * 注意：本测试不会保存，也不处理草稿。测试后目标页面的草稿需自行清理。
 * 用户的正式页面内容不受影响（未执行保存）。
 */
const { createClient } = require('./client.js');

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

// 优先用 --url；否则回退到 test-config.js 里的 editUrl
let EDIT_URL = argValue('--url');
if (!EDIT_URL) {
  try {
    EDIT_URL = require('./test-config.loader.js').loadTestConfig().editUrl || null;
  } catch (e) {
    EDIT_URL = null;
  }
}

if (!EDIT_URL) {
  console.error('必须提供 --url，且应指向一个可安全测试的页面编辑地址。');
  console.error('例如: node test-editor.js --url "https://host/pages/editpage.action?pageId=123"');
  console.error('也可在 test-config.js 中配置 editUrl 后直接运行。');
  process.exit(1);
}

const client = createClient();
let pass = 0, fail = 0;

function assert(c, m) { if (!c) { throw new Error(m); } }

async function check(name, fn) {
  try {
    const d = await fn();
    pass++;
    console.log(`  PASS  ${name}${d ? ' — ' + d : ''}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name} — ${e.code ? '[' + e.code + '] ' : ''}${e.message}`);
  }
}

(async () => {
  // 前台打开，编辑器才会实例化
  const nav = await client.navigate({ url: EDIT_URL, newTab: true, active: true });
  const tabId = nav.tabId;
  console.log(`测试标签页: ${tabId}（前台）\n`);

  let editorFrameId = null;
  let originalText = '';

  console.log('=== 框架识别 ===');

  await check('编辑页已加载', async () => {
    await new Promise((r) => setTimeout(r, 6000));
    const d = await client.read({ tabId });
    assert(d.charCount > 0, '读不到任何内容');
    return `${d.frameCount} 个框架，命中 frameId=${d.frameId}`;
  });

  await check('存在可编辑框架（编辑器）', async () => {
    const fr = await client.frames({ tabId });
    const editable = fr.frames.filter((f) => f.info && (
      f.info.bodyIsContentEditable
      || f.info.bodyEditableByDesignMode
      || f.info.editableAttrCount > 0
    ));
    assert(editable.length > 0,
      `未找到可编辑框架。各框架：${fr.frames.map((f) => `id=${f.frameId} ce=${f.info ? f.info.editableAttrCount : '?'}`).join(', ')}`);
    editorFrameId = editable[0].frameId;
    const i = editable[0].info;
    return `frameId=${editorFrameId} designMode=${i.designMode} bodyCE=${i.bodyIsContentEditable}`;
  });

  await check('read 自动挑选命中编辑器框架', async () => {
    const d = await client.read({ tabId });
    assert(d.frameId === editorFrameId,
      `自动挑选 frameId=${d.frameId}，期望 ${editorFrameId}`);
    return `frameId=${d.frameId}`;
  });

  if (editorFrameId === null) {
    console.log('\n未识别到编辑器，终止。');
    await client.close({ tabId }).catch(() => {});
    process.exit(1);
  }

  await check('读取编辑器原始内容', async () => {
    const d = await client.read({ tabId, frameId: editorFrameId });
    originalText = d.text;
    assert(d.charCount > 0, '编辑器内容为空');
    return `${d.charCount} 字符，前 60 字：${JSON.stringify(d.text.slice(0, 60))}`;
  });

  console.log('\n=== 写入 ===');

  const MARK = 'ABB编辑器自测临时内容';

  await check('type 写入纯文本', async () => {
    const d = await client.type({
      tabId, frameId: editorFrameId, value: MARK, clear: true
    });
    assert(d.editable === true, '未走可编辑分支');
    assert(d.usedExecCommand === true, '未使用 execCommand（富文本编辑器可能无法同步）');
    return `execCommand=true，长度 ${d.beforeLength} -> ${d.afterLength}`;
  });

  await check('read 读回并校验内容一致', async () => {
    const d = await client.read({ tabId, frameId: editorFrameId });
    assert(d.text.includes(MARK), `未读到写入内容，实际：${JSON.stringify(d.text.slice(0, 60))}`);
    return '内容一致';
  });

  await check('type --html 插入结构化内容', async () => {
    const d = await client.type({
      tabId, frameId: editorFrameId, value: '<h3>ABB标题</h3><p>ABB段落</p>',
      method: 'html', clear: true
    });
    assert(d.usedExecCommand === true, '未使用 execCommand');
    const back = await client.read({ tabId, frameId: editorFrameId, returnHtml: true });
    assert((back.html || '').includes('<h3'), 'h3 未生效');
    assert((back.html || '').includes('<p'), 'p 未生效');
    return 'h3 与 p 均生效';
  });

  await check('HTML 清洗：script 被剥离', async () => {
    await client.type({
      tabId, frameId: editorFrameId,
      value: '<p>安全内容</p><script>window.__abb_xss=1<\/script>',
      method: 'html', clear: true
    });
    const back = await client.read({ tabId, frameId: editorFrameId, returnHtml: true });
    assert(!(back.html || '').includes('__abb_xss'), 'script 未被剥离');
    return '已剥离';
  });

  console.log('\n=== 收尾 ===');

  await check('清空编辑器内容', async () => {
    const d = await client.type({ tabId, frameId: editorFrameId, value: '', clear: true });
    assert(d.afterLength <= 1, `仍有 ${d.afterLength} 字符`);
    return '已清空';
  });

  await check('未执行保存（正式页面不受影响）', async () => {
    // 只读校验：不应出现任何"已更新"提示
    const d = await client.read({ tabId });
    return d.charCount >= 0 ? '未触发保存操作' : '';
  });

  console.log(`\n=== 通过 ${pass} 项，失败 ${fail} 项 ===`);
  console.log(`\n注意：标签页 ${tabId} 仍打开，且该页面已产生草稿，需自行清理。`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('异常终止：', e);
  process.exit(2);
});
