/**
 * 多浏览器隔离与路由测试。
 *
 * 需要 Chrome 与 Edge 都加载了本扩展。若只有一个在线，会自动跳过相应断言并提示。
 *
 * 验证点：
 *   1. 两个浏览器都能独立汇报标签页
 *   2. 只存在于 Chrome 的标签页，按 match 会自动路由到 Chrome
 *   3. 只存在于 Edge 的标签页，按 match 会自动路由到 Edge
 *   4. 显式指定 browser 时只在该浏览器内查找，不会串到另一个
 *
 * 全部操作都在后台新建的测试标签页里进行，结束后关闭。
 */
const { createClient, BridgeError } = require('./client.js');
const { loadTestConfig } = require('./test-config.loader.js');

const PAGE = loadTestConfig().pageUrl;
const CHROME_ONLY = 'abbChromeProbe=1';
const EDGE_ONLY = 'abbEdgeProbe=1';

const client = createClient();
let pass = 0, fail = 0;
const failures = [];

function assert(c, m) { if (!c) { throw new Error(m); } }

async function check(name, fn) {
  try {
    const d = await fn();
    pass++;
    console.log(`  PASS  ${name}${d ? ' — ' + d : ''}`);
  } catch (e) {
    fail++;
    const msg = e instanceof BridgeError
      ? `[${e.code}] ${(e.detail && e.detail.hint) || e.message}`
      : (e && e.message ? e.message : String(e));
    failures.push(`${name} — ${msg}`);
    console.log(`  FAIL  ${name} — ${msg}`);
  }
}

async function expectError(code, fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof BridgeError && e.code === code) { return; }
    throw new Error(`期望 ${code}，实际 ${e.code || e.message}`);
  }
  throw new Error(`期望抛出 ${code}，但调用成功`);
}

(async () => {
  console.log('=== 前置检查 ===');

  const health = await client.health();
  const browsers = health.browsers || [];
  console.log(`  在线浏览器: ${browsers.join(', ') || '（无）'}`);

  const hasChrome = browsers.includes('chrome');
  const hasEdge = browsers.includes('edge');

  if (!hasChrome || !hasEdge) {
    console.log(`\n需要 Chrome 与 Edge 同时在线才能完整验证（当前缺 ${!hasEdge ? 'edge ' : ''}${!hasChrome ? 'chrome' : ''}）。`);
    console.log('请确认另一个浏览器已加载扩展并处于运行状态。');
    process.exit(2);
  }

  await check('两个浏览器均独立汇报标签页', async () => {
    const e = await client.tabs({ browser: 'edge' });
    const c = await client.tabs({ browser: 'chrome' });
    assert(Array.isArray(e.tabs) && Array.isArray(c.tabs), '返回结构异常');
    return `edge=${e.tabs.length} 个，chrome=${c.tabs.length} 个`;
  });

  console.log('\n=== 自动选路 ===');

  let chromeTab = null;
  let edgeTab = null;

  await check('在 Chrome 后台新建测试标签页', async () => {
    const n = await client.navigate({ url: `${PAGE}&${CHROME_ONLY}`, newTab: true, browser: 'chrome' });
    chromeTab = n.tabId;
    assert(typeof chromeTab === 'number', '未返回 tabId');
    return `tabId=${chromeTab}`;
  });

  await check('在 Edge 后台新建测试标签页', async () => {
    const n = await client.navigate({ url: `${PAGE}&${EDGE_ONLY}`, newTab: true, browser: 'edge' });
    edgeTab = n.tabId;
    assert(typeof edgeTab === 'number', '未返回 tabId');
    return `tabId=${edgeTab}`;
  });

  await new Promise((r) => setTimeout(r, 3000));

  await check('Chrome 专属页按 match 自动路由到 Chrome', async () => {
    const d = await client.read({ match: CHROME_ONLY });
    assert(d.browser === 'chrome', `命中 ${d.browser}，期望 chrome`);
    assert(d.tabId === chromeTab, `命中标签页 ${d.tabId}，期望 ${chromeTab}`);
    return `browser=chrome tabId=${d.tabId}`;
  });

  await check('Edge 专属页按 match 自动路由到 Edge', async () => {
    const d = await client.read({ match: EDGE_ONLY });
    assert(d.browser === 'edge', `命中 ${d.browser}，期望 edge`);
    assert(d.tabId === edgeTab, `命中标签页 ${d.tabId}，期望 ${edgeTab}`);
    return `browser=edge tabId=${d.tabId}`;
  });

  console.log('\n=== 隔离验证 ===');

  await check('用 Edge 读 Chrome 专属页被拒绝', async () => {
    await expectError('no_tab_matched', () => client.read({ match: CHROME_ONLY, browser: 'edge' }));
    return 'no_tab_matched';
  });

  await check('用 Chrome 读 Edge 专属页被拒绝', async () => {
    await expectError('no_tab_matched', () => client.read({ match: EDGE_ONLY, browser: 'chrome' }));
    return 'no_tab_matched';
  });

  await check('显式指定 Chrome 读 Chrome 页成功', async () => {
    const d = await client.read({ match: CHROME_ONLY, browser: 'chrome' });
    assert(d.browser === 'chrome', `browser=${d.browser}`);
    return `charCount=${d.charCount}`;
  });

  await check('指定不存在的浏览器被拒绝', async () => {
    await expectError('browser_not_connected', () => client.read({ match: CHROME_ONLY, browser: 'firefox' }));
    return 'browser_not_connected';
  });

  console.log('\n=== 收尾 ===');

  for (const [name, id] of [['Chrome', chromeTab], ['Edge', edgeTab]]) {
    await check(`关闭 ${name} 测试标签页`, async () => {
      if (typeof id !== 'number') { throw new Error('没有有效的 tabId'); }
      const d = await client.close({ tabId: id });
      return `已关闭「${(d.closedTitle || '').slice(0, 26)}」`;
    });
  }

  await check('两个浏览器标签页都未残留', async () => {
    const t = await client.tabs();
    const leftover = t.tabs.filter((x) => x.url && (x.url.includes(CHROME_ONLY) || x.url.includes(EDGE_ONLY)));
    assert(leftover.length === 0, `仍有 ${leftover.length} 个测试标签页`);
    return '已清理';
  });

  console.log(`\n=== 通过 ${pass} 项，失败 ${fail} 项 ===`);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('异常终止：', e);
  process.exit(2);
});
