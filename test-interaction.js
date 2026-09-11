/**
 * 验证按钮交互分级与 wait 动作。全程无副作用：
 * 点击一律用 dryRun，不会真正触发任何按钮。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createClient, BridgeError } = require('./client.js');
const { loadTestConfig } = require('./test-config.loader.js');

const cfg = loadTestConfig();
const PAGE = cfg.pageUrl;
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
  console.log('=== 1. 风险词表单元校验 ===');

  await check('风险词表能识别不可逆操作', async () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'extension', 'background.js'), 'utf8'
    );
    const m = src.match(/const DESTRUCTIVE_RE = (\/[^\n]+?\/i);/);
    assert(m, '未能在源码中找到 DESTRUCTIVE_RE');
    const re = eval(m[1]);

    const shouldBlock = ['删除', '删除页面', '提交', '发布', '发送', '保存', '更新', '确认删除', 'Delete', 'Submit', 'Save'];
    const shouldAllow = ['编辑', '插入', '取消', '关闭', '粗体', '斜体', '表格', '下一页', 'Cancel', 'Close', 'Bold'];

    const missed = shouldBlock.filter((t) => !re.test(t));
    const wrong = shouldAllow.filter((t) => re.test(t));
    assert(missed.length === 0, `应拦截但未拦截: ${missed.join(', ')}`);
    assert(wrong.length === 0, `应放行但被拦截: ${wrong.join(', ')}`);
    return `拦截 ${shouldBlock.length} 项、放行 ${shouldAllow.length} 项，均正确`;
  });

  console.log('\n=== 2. 建立测试标签页 ===');

  const nav = await client.navigate({ url: PAGE + '&abbVerify=1', newTab: true });
  const tabId = nav.tabId;
  console.log(`  tabId=${tabId}`);
  await new Promise((r) => setTimeout(r, 3000));

  console.log('\n=== 3. wait 动作 ===');

  await check('等待已存在的元素立即成功', async () => {
    const d = await client.wait({ tabId, selector: '#main-content', timeoutMs: 5000 });
    assert(d.elapsedMs < 3000, `耗时 ${d.elapsedMs}ms 过长`);
    return `${d.elapsedMs}ms`;
  });

  await check('等待文字出现', async () => {
    const d = await client.wait({ tabId, text: '整改', timeoutMs: 5000 });
    return `${d.elapsedMs}ms`;
  });

  await check('等待不存在的元素超时报 wait_timeout', async () => {
    try {
      await client.wait({ tabId, selector: '#__abb_not_exist__', timeoutMs: 1500 });
      throw new Error('竟然成功了');
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'wait_timeout') { return 'wait_timeout'; }
      throw e;
    }
  });

  await check('wait 缺少条件时报 missing_condition', async () => {
    try {
      await client.wait({ tabId });
      throw new Error('竟然成功了');
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'missing_condition') { return 'missing_condition'; }
      throw e;
    }
  });

  console.log('\n=== 4. 点击分级（dryRun，不真正点击）===');

  await check('链接：允许点击', async () => {
    const d = await client.click({ tabId, text: '顺剪', dryRun: true });
    assert(d.wouldClick.isLink === true, `isLink=${d.wouldClick.isLink}`);
    assert(d.wouldClick.blocked === false, '链接不应被拦截');
    return `isLink=true blocked=false  text=${JSON.stringify(d.wouldClick.text.slice(0, 24))}`;
  });

  await check('普通容器 div：默认拦截', async () => {
    const d = await client.click({ tabId, selector: '#main-content', dryRun: true });
    assert(d.wouldClick.isLink === false, 'isLink 应为 false');
    assert(d.wouldClick.blocked === true, '容器应被拦截');
    return `isLink=false isButtonLike=${d.wouldClick.isButtonLike} blocked=true`;
  });

  await check('真实点击容器仍报 not_a_link', async () => {
    try {
      await client.click({ tabId, selector: '#main-content' });
      throw new Error('竟然成功了');
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'not_a_link') { return 'not_a_link'; }
      throw e;
    }
  });

  await check('dryRun 不产生任何副作用（页面未跳转）', async () => {
    const t = await client.tabs();
    const cur = t.tabs.find((x) => x.id === tabId);
    assert(cur && cur.url.includes('abbVerify=1'), '页面发生了跳转');
    return 'URL 未变';
  });

  console.log('\n=== 5. 收尾 ===');

  await check('关闭测试标签页', async () => {
    const d = await client.close({ tabId });
    return `已关闭「${(d.closedTitle || '').slice(0, 26)}」`;
  });

  console.log(`\n=== 通过 ${pass} 项，失败 ${fail} 项 ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('异常终止：', e);
  process.exit(2);
});
