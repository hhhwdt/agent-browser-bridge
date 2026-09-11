/**
 * Agent Browser Bridge 自测。
 *
 * 判定语义：断言函数正常返回即通过，抛出 Error 即失败。
 * 不允许"返回一段说明文字"就算通过——那种写法会让失败被误判为成功。
 *
 * 所有操作都在后台新建的测试标签页里进行，不触碰用户当前激活的标签页，
 * 结束时关闭该标签页。
 */
const { createClient, BridgeError } = require('./client.js');
const { loadTestConfig } = require('./test-config.loader.js');

const cfg = loadTestConfig();

// 测试页 URL 带唯一参数，避免与用户已打开的同名页面冲突。
// 否则 match 会同时命中用户标签页，产品逻辑会正确优先激活的那个，
// 使"按 match 应命中测试标签页"这类断言误报失败。
const TEST_PAGE = cfg.pageUrl;
const TEST_URL = TEST_PAGE + (TEST_PAGE.includes('?') ? '&' : '?') + 'abbSelftest=1';
const TEST_MATCH = 'abbSelftest=1';
const LINK_TEXT = cfg.linkText;
const LINK_TARGET = cfg.linkTargetFragment;

const client = createClient();
let pass = 0;
let fail = 0;
const failures = [];

/** 运行一个断言。fn 正常返回 detail 字符串即通过，抛错即失败。 */
async function check(name, fn) {
  try {
    const detail = await fn();
    pass++;
    console.log(`  PASS  ${name}${detail !== undefined ? ' — ' + detail : ''}`);
    return true;
  } catch (e) {
    fail++;
    const msg = e instanceof BridgeError
      ? `[${e.code}] ${(e.detail && e.detail.hint) || e.message}`
      : (e && e.message ? e.message : String(e));
    failures.push(`${name} — ${msg}`);
    console.log(`  FAIL  ${name} — ${msg}`);
    return false;
  }
}

/** 断言辅助：不满足则抛错。 */
function assert(cond, msg) {
  if (!cond) { throw new Error(msg || '断言失败'); }
}

/** 期望某个调用抛出指定错误码。 */
async function expectErrorCode(code, fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof BridgeError && e.code === code) { return; }
    throw new Error(`期望错误码 ${code}，实际 ${e.code || e.message}`);
  }
  throw new Error(`期望抛出 ${code}，但调用成功了`);
}

(async () => {
  let testTabId = null;
  let activeTabIdBefore = null;

  console.log('=== 1. 服务与能力 ===');

  const health = await client.health();
  let healthOk = false;

  await check('health 可用且带接口版本', async () => {
    assert(health.ok === true, 'health.ok 不是 true');
    assert(typeof health.apiVersion === 'string' && health.apiVersion.length > 0, '缺少 apiVersion');
    healthOk = true;
    return `apiVersion=${health.apiVersion}`;
  });

  await check('扩展已连接且报告浏览器名', async () => {
    assert(health.extensionConnected === true, 'extensionConnected 为 false');
    assert(Array.isArray(health.browsers) && health.browsers.length > 0, 'browsers 为空');
    return `browsers=${JSON.stringify(health.browsers)}`;
  });

  await check('能力清单包含全部动作', async () => {
    const need = ['tabs', 'read', 'links', 'click', 'type', 'key',
      'navigate', 'mark', 'unmark', 'close', 'reload', 'multiBrowser'];
    assert(Array.isArray(health.capabilities), 'capabilities 不是数组');
    const missing = need.filter((c) => !health.capabilities.includes(c));
    assert(missing.length === 0, `缺少 ${missing.join(', ')}`);
    return `${health.capabilities.length} 项`;
  });

  await check('isReady 返回 true', async () => {
    assert(await client.isReady() === true, 'isReady 为 false');
    return 'true';
  });

  if (!healthOk) {
    console.log('\n服务不可用，终止。');
    process.exit(1);
  }

  console.log('\n=== 2. 标签页隔离 ===');

  await check('列出标签页', async () => {
    const t = await client.tabs();
    assert(Array.isArray(t.tabs), 'tabs 不是数组');
    assert(t.tabs.length > 0, '没有任何标签页');
    // 浏览器窗口不在前台时可能没有激活标签页，这是合法状态
    const act = t.tabs.find((x) => x.active);
    activeTabIdBefore = act ? act.id : null;
    return `${t.tabs.length} 个，当前激活 ${activeTabIdBefore === null ? '（无，窗口未在前台）' : activeTabIdBefore}`;
  });

  await check('后台新建测试标签页（不激活）', async () => {
    const r = await client.navigate({ url: TEST_URL, newTab: true });
    testTabId = r.tabId;
    assert(typeof testTabId === 'number', '未返回 tabId');
    assert(r.openedNewTab === true, 'openedNewTab 不是 true');
    assert(r.wasActive === false, 'wasActive 应为 false');
    return `tabId=${testTabId}`;
  });

  await check('新建后用户激活标签页未被改变', async () => {
    const t = await client.tabs();
    const found = t.tabs.find((x) => x.active);
    const now = found ? found.id : null;
    assert(now === activeTabIdBefore, `激活页从 ${activeTabIdBefore} 变成 ${now}`);
    return `仍为 ${now === null ? '（无）' : now}`;
  });

  if (testTabId === null) {
    console.log('\n测试标签页创建失败，终止。');
    process.exit(1);
  }

  console.log('\n=== 3. 读取类操作 ===');

  await check('read 按 tabId 读取正文', async () => {
    const d = await client.read({ tabId: testTabId });
    assert(d.charCount > 100, `字符数过少：${d.charCount}`);
    assert(d.wasActive === false, `wasActive 应为 false，实际 ${d.wasActive}`);
    assert(typeof d.browser === 'string' && d.browser.length > 0,
      `未回报来源浏览器，实际 ${d.browser}`);
    assert(d.text.length > 100, '正文过短');
    return `${d.charCount} 字符，selector=${d.usedSelector}`;
  });

  await check('read 按 match 定位到同一标签页', async () => {
    const d = await client.read({ match: TEST_MATCH });
    assert(d.tabId === testTabId, `命中 tabId=${d.tabId}，期望 ${testTabId}`);
    return `tabId=${d.tabId}`;
  });

  await check('links 枚举链接', async () => {
    const d = await client.links({ tabId: testTabId });
    assert(d.links.length > 10, `链接数过少：${d.links.length}`);
    assert(d.links.every((l) => typeof l.href === 'string'), '存在缺少 href 的链接');
    return `${d.links.length} 个`;
  });

  await check('links 按文字过滤', async () => {
    const d = await client.links({ tabId: testTabId, text: LINK_TEXT });
    assert(d.links.length >= 1, '未过滤出任何链接');
    return `命中 ${d.links.length} 个：${d.links[0].text.slice(0, 30)}`;
  });

  console.log('\n=== 4. 标记 ===');

  const MARK_TEXT = '自测标记XYZ';

  await check('mark 打标记（徽标 + 页面提示）', async () => {
    const d = await client.mark({ tabId: testTabId, text: MARK_TEXT });
    assert(d.badge, '未返回 badge');
    assert(d.indicatorPlaced === true, '页面内提示未放置');
    assert(d.tabId === testTabId, 'tabId 不符');
    return `badge=${d.badge}`;
  });

  await check('页面内确实存在标记元素', async () => {
    const d = await client.read({ tabId: testTabId, selector: 'html' });
    assert(d.text.includes(MARK_TEXT), `正文中未找到标记文本 "${MARK_TEXT}"`);
    return `找到 "${MARK_TEXT}"`;
  });

  await check('unmark 清除标记', async () => {
    const d = await client.unmark({ tabId: testTabId });
    assert(Array.isArray(d.cleared) && d.cleared.includes(testTabId), '未报告清除该标签页');
    return `已清除 ${d.cleared.length} 个`;
  });

  await check('清除后页面内标记元素消失', async () => {
    const d = await client.read({ tabId: testTabId, selector: 'html' });
    assert(!d.text.includes(MARK_TEXT), '标记文本仍然存在');
    return '已消失';
  });

  console.log('\n=== 5. 输入类操作 ===');

  await check('type 写入 input', async () => {
    const d = await client.type({
      tabId: testTabId,
      selector: '#quick-search-query',
      value: 'ABTEST',
      clear: true
    });
    assert(d.afterLength === 6, `期望长度 6，实际 ${d.afterLength}`);
    assert(d.preview === 'ABTEST', `preview 应为 ABTEST，实际 "${d.preview}"`);
    return `长度 ${d.beforeLength} -> ${d.afterLength}`;
  });

  await check('read 读回 input 的值并校验', async () => {
    const d = await client.read({ tabId: testTabId, selector: '#quick-search-query' });
    assert(d.text.trim() === 'ABTEST', `读回内容为 "${d.text.trim()}"，期望 "ABTEST"`);
    return `读回 "${d.text.trim()}"`;
  });

  await check('type 清空 input（还原现场）', async () => {
    const d = await client.type({
      tabId: testTabId,
      selector: '#quick-search-query',
      value: '',
      clear: true
    });
    assert(d.afterLength === 0, `仍有 ${d.afterLength} 字符`);
    return '已清空';
  });

  await check('type 到非可编辑元素被拒绝', async () => {
    await expectErrorCode('not_editable', () => client.type({
      tabId: testTabId, selector: '#main-content', value: 'x'
    }));
    return 'not_editable';
  });

  await check('key 派发 Enter', async () => {
    const d = await client.key({ tabId: testTabId, selector: '#quick-search-query', key: 'Enter' });
    assert(d.key === 'Enter', `key 为 ${d.key}`);
    return `keyCode=${d.keyCode}`;
  });

  console.log('\n=== 6. 点击类操作 ===');

  await check('click 非链接元素被拒绝', async () => {
    await expectErrorCode('not_a_link', () => client.click({ tabId: testTabId, selector: '#main-content' }));
    return 'not_a_link';
  });

  await check('click 不存在的元素报错明确', async () => {
    await expectErrorCode('no_element_matched', () => client.click({
      tabId: testTabId, selector: 'a#__not_exist__'
    }));
    return 'no_element_matched';
  });

  await check('click 点击链接并跳转', async () => {
    const d = await client.click({ tabId: testTabId, text: LINK_TEXT });
    assert(d.clicked && d.clicked.href, '未返回被点击的链接');
    assert(d.navigated === true, '未发生跳转');
    assert(d.urlAfter.includes(LINK_TARGET), `跳转目标异常：${d.urlAfter}`);
    return `已跳转至 ${d.urlAfter.slice(-40)}`;
  });

  await check('点击后仍是同一个标签页（未新开）', async () => {
    const t = await client.tabs();
    assert(t.tabs.some((x) => x.id === testTabId), '测试标签页丢失');
    return '是';
  });

  console.log('\n=== 7. 浏览器参数与路由 ===');

  await check('指定不存在的浏览器被拒绝', async () => {
    await expectErrorCode('browser_not_connected', () => client.read({
      match: TEST_MATCH, browser: 'firefox'
    }));
    return 'browser_not_connected';
  });

  await check('显式指定归属浏览器可读，其他浏览器正确隔离', async () => {
    const owner = (await client.read({ tabId: testTabId })).browser;
    const same = await client.read({ tabId: testTabId, browser: owner });
    assert(same.browser === owner, `指定 ${owner} 却由 ${same.browser} 执行`);

    // 该标签页只属于 owner，指定其他浏览器应当找不到，而不是串过去读
    const others = ((await client.health()).browsers || []).filter((b) => b !== owner);
    for (const b of others) {
      await expectErrorCode('no_tab_matched', () => client.read({ tabId: testTabId, browser: b }));
    }

    return others.length
      ? `owner=${owner}，${others.join('/')} 正确隔离`
      : `owner=${owner}（单浏览器）`;
  });

  // 前面的 click 测试把标签页跳走了，先导航回测试 URL，
  // 让 TEST_MATCH 重新唯一指向测试标签页
  await check('navigate 把测试标签页导回原地址', async () => {
    const d = await client.navigate({ url: TEST_URL, tabId: testTabId });
    assert(d.openedNewTab === false, '不应新开标签页');
    return `tabId=${d.tabId}`;
  });

  await check('自动选路命中正确标签页', async () => {
    const d = await client.read({ match: TEST_MATCH });
    assert(d.tabId === testTabId, `命中 ${d.tabId}，期望 ${testTabId}`);
    return `自动选中 tabId=${testTabId}`;
  });

  await check('match 找不到时错误码明确', async () => {
    await expectErrorCode('no_tab_matched', () => client.read({ match: 'pageId=___not_exist___' }));
    return 'no_tab_matched';
  });

  console.log('\n=== 8. 收尾 ===');

  await check('close 缺 tabId 被拒绝', async () => {
    await expectErrorCode('missing_tab_id', () => client.close({}));
    return 'missing_tab_id';
  });

  await check('关闭测试标签页', async () => {
    const d = await client.close({ tabId: testTabId });
    assert(d.tabId === testTabId, 'tabId 不符');
    return `已关闭「${(d.closedTitle || '').slice(0, 30)}」`;
  });

  await check('测试标签页确已关闭', async () => {
    const t = await client.tabs();
    assert(!t.tabs.some((x) => x.id === testTabId), '测试标签页仍存在');
    return '已消失';
  });

  await check('用户的激活标签页自始至终未变', async () => {
    const t = await client.tabs();
    const found = t.tabs.find((x) => x.active);
    const now = found ? found.id : null;
    assert(now === activeTabIdBefore, `激活页变成 ${now}，原为 ${activeTabIdBefore}`);
    return `始终为 ${now === null ? '（无）' : now}`;
  });

  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===`);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n自测异常终止：', e);
  process.exit(2);
});
