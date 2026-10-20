#!/usr/bin/env node
/**
 * 结果语义测试：动作**失败时**必须报失败，而不是报成功。
 *
 * 为什么单独有这个套件：这套代码最初的缺陷里，最贵的一类不是"功能没做"，而是
 * "没做成却说做成了"——调用方看到 ok 就没有理由再看第二眼。这一类当场不会报错，
 * 事后也没有日志，只有在别的地方绕一大圈才发现文件没落盘、链接没读到、代码跑了三遍。
 * 下面每一条都是真实踩过的：它们当时全都没有被任何测试挡住。
 *
 * 从 extension/sw/ 抽真实的函数源码，在 Node 里用替身驱动，不碰浏览器。
 *
 *   node test-result-semantics.js
 */

'use strict';

const { extractFunction } = require('./sw-source.js');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : String(detail).slice(0, 220)}`);
  }
}

/** 取出函数源码；找不到就报错，不要静默跳过。 */
function need(name) {
  const found = extractFunction(name);
  if (!found) { throw new Error('在 extension/sw/ 里找不到 ' + name); }
  return found.src;
}

(async () => {

  /* ================================================================ *
   * 1. session --key 也要截断
   *
   * 踩过的：截断循环写在 key 分支的 return 之后，指定 key 取一个几百 KB 的
   * 缓存值时原样返回，整个值塞进命令行输出和 /result 回传。
   * ================================================================ */
  console.log('\n[1] readStorageInPage：单 key 的截断');
  {
    const readStorageInPage = new Function('return ' + need('readStorageInPage'))();
    const big = 'x'.repeat(5000);
    const store = {
      length: 2,
      key: (i) => (i === 0 ? 'a' : 'big'),
      getItem: (k) => (k === 'big' ? big : k === 'a' ? 'short' : null)
    };
    globalThis.window = { localStorage: store, sessionStorage: store };

    const one = readStorageInPage(true, false, 'big');
    const v = one.localStorage.big;
    check('指定 key 取大值被截断',
      typeof v === 'string' && v.length < 5000 && v.endsWith('…[截断]'), `len=${v && v.length}`);
    check('指定 key 取小值原样返回', readStorageInPage(true, false, 'a').localStorage.a === 'short');
    check('指定不存在的 key 返回 null', readStorageInPage(true, false, 'nope').localStorage.nope === null);
    const all = readStorageInPage(true, false, null);
    check('不带 key 时仍按名列出并逐项截断',
      all.localStorage.a === 'short' && all.localStorage.big.endsWith('…[截断]'),
      JSON.stringify(Object.keys(all.localStorage)));
  }

  /* ================================================================ *
   * 2. links：选择器没命中不能报成功，命中要能参与框架打分
   *
   * 踩过的：页面侧返回 error:'selector_not_found'，动作层只取 links 字段把它丢掉，
   * 于是 `links --selector "#nope"` 报 ok 加 0 条链接，调用方以为页面上没有链接。
   * 同一个字段缺失还让多框架打分永远平手，iframe 里的链接找不到。
   * ================================================================ */
  console.log('\n[2] links：选择器未命中与框架打分');
  {
    const makeA = (i) => ({
      href: 'https://e.test/' + i,
      innerText: 'link' + i,
      textContent: 'link' + i,
      getBoundingClientRect: () => ({ width: 100, height: 20, left: 0, top: 0 })
    });
    const scope = { querySelectorAll: () => [makeA(1), makeA(2)] };
    globalThis.window = globalThis;
    globalThis.top = globalThis;
    globalThis.location = { href: 'https://e.test/page' };
    globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    globalThis.document = {
      querySelector: (s) => (s === '#box' ? scope : null),
      querySelectorAll: () => [makeA(1), makeA(2)]
    };

    const linksInPage = new Function('return ' + need('linksInPage'))();
    const hit = linksInPage('#box', null);
    check('命中时返回 selectorMatched=true', hit.selectorMatched === true);
    check('命中时 usedSelector 是原选择器', hit.usedSelector === '#box', hit.usedSelector);
    check('未命中时返回 selector_not_found', linksInPage('#nope', null).error === 'selector_not_found');
    check('不带选择器时 selectorMatched=false', linksInPage(null, null).selectorMatched === false);

    const pickContentFrame = new Function('return ' + need('pickContentFrame'))();
    const score = pickContentFrame('#box');
    check('命中框架的得分压过正文更长的框架',
      score({ selectorMatched: true, charCount: 0 }) > score({ selectorMatched: false, charCount: 100000 }));

    const stubs = {
      resolveTab: async () => ({ id: 7, active: false, url: 'https://e.test/page', title: 't' }),
      ensureInjectable: async () => ({})
    };
    const makeLinksTab = (picked) => new Function(
      'chrome', 'resolveTab', 'ensureInjectable', 'injectAndPick', 'linksInPage',
      need('pickContentFrame') + '\n' + need('linksTab') + '\nreturn linksTab;'
    )({}, stubs.resolveTab, stubs.ensureInjectable, async () => picked, linksInPage);

    const miss = await makeLinksTab({
      data: { links: [], usedSelector: null, error: 'selector_not_found' }, frameId: 0, frameCount: 3
    })({ selector: '#nope' });
    check('linksTab 把未命中报成失败', miss.ok === false && miss.error === 'selector_not_found',
      JSON.stringify(miss));

    const ok = await makeLinksTab({
      data: { links: [{ index: 0 }], usedSelector: '#box' }, frameId: 5, frameCount: 3
    })({ selector: '#box' });
    check('正常结果仍是 ok，并带出命中的框架',
      ok.ok === true && ok.data.links.length === 1 && ok.data.frameId === 5, JSON.stringify(ok.data));
  }

  /* ================================================================ *
   * 3. waitForTabUrl：不能把导航前的地址当结果返回
   *
   * 踩过的：命中判断写成"当前地址以目标为前缀"，于是从 /doc?id=1 导航到 /doc 时
   * 第一次轮询就命中，navigate 回报的 url 是旧地址，调用方紧接着 read 读到旧页面。
   * 另外 chrome.tabs.update 刚返回时地址未变、status 仍是 complete，
   * 会被误判成"服务端重定向"而立刻返回。
   * ================================================================ */
  console.log('\n[3] waitForTabUrl：地址判定');
  {
    const src = need('waitForTabUrl');
    const build = (sequence) => {
      const steps = sequence.slice();
      const chrome = { tabs: { get: async () => (steps.length > 1 ? steps.shift() : steps[0]) } };
      return new Function('chrome', src + '\nreturn waitForTabUrl;')(chrome);
    };

    const superset = await build([
      { url: 'https://e.test/doc?id=1', status: 'complete' },
      { url: 'https://e.test/doc?id=1', status: 'loading' },
      { url: 'https://e.test/doc', status: 'complete' }
    ])(1, 'https://e.test/doc', 3000, 'https://e.test/doc?id=1');
    check('当前地址是目标的超集时不算已到达',
      superset.url === 'https://e.test/doc' && !superset.redirected && !superset.timedOut,
      JSON.stringify(superset));

    const stale = await build([{ url: 'https://e.test/old', status: 'complete' }])(
      1, 'https://e.test/new', 400, 'https://e.test/old');
    check('地址未变时不报重定向，而是等到超时', stale.timedOut === true && !stale.redirected,
      JSON.stringify(stale));

    const moved = await build([{ url: 'https://e.test/login', status: 'complete' }])(
      1, 'https://e.test/private', 400, 'https://e.test/old');
    check('地址确实变了才报 redirected', moved.redirected === true && moved.url === 'https://e.test/login',
      JSON.stringify(moved));

    const hashOnly = await build([{ url: 'https://e.test/doc', status: 'complete' }])(
      1, 'https://e.test/doc#sec2', 400, 'https://e.test/other');
    check('只差 #fragment 时算到达', hashOnly.url === 'https://e.test/doc' && !hashOnly.timedOut,
      JSON.stringify(hashOnly));

    const gone = new Function('chrome', src + '\nreturn waitForTabUrl;')({ tabs: { get: async () => null } });
    check('标签页没了报 tabGone', (await gone(1, 'https://e.test/doc', 300)).tabGone === true);
  }

  /* ================================================================ *
   * 4. elementRectByCdp：iframe 里的元素要在主框架坐标系里量
   *
   * 踩过的：子框架里注入量到的矩形是那个框架自己的坐标系，直接当 CDP 的 clip 用，
   * 截出来的是页面另一处的内容——比报错更难发现。
   * ================================================================ */
  console.log('\n[4] elementRectByCdp：跨框架坐标');
  {
    const src = need('elementRectByCdp');
    const make = (handlers) => {
      const calls = [];
      const chrome = {
        debugger: {
          attach: async () => { calls.push('attach'); },
          detach: async () => { calls.push('detach'); },
          sendCommand: async (target, method, params) => {
            calls.push(method);
            if (!handlers[method]) { throw new Error('unexpected ' + method); }
            return handlers[method](params);
          }
        }
      };
      return { calls, run: new Function('chrome', src + '\nreturn elementRectByCdp;')(chrome) };
    };

    const ok = make({
      'DOM.enable': () => ({}),
      'DOM.getFrameOwner': () => ({ backendNodeId: 99 }),
      'DOM.describeNode': () => ({ node: { contentDocument: { nodeId: 5 } } }),
      'DOM.querySelector': (p) => ({ nodeId: p.selector === '#hit' ? 12 : 0 }),
      'DOM.getBoxModel': () => ({ model: { content: [100, 50, 300, 50, 300, 90, 100, 90] } }),
      'Page.getLayoutMetrics': () => ({ cssVisualViewport: { pageX: 40, pageY: 300 } })
    });
    const rect = await ok.run(1, '#hit', 5);
    check('quad 换算出的宽高正确', rect && rect.width === 200 && rect.height === 40, JSON.stringify(rect));
    check('补上了主框架的滚动偏移', rect && rect.x === 140 && rect.y === 350, JSON.stringify(rect));
    check('用完 detach 调试器',
      ok.calls[0] === 'attach' && ok.calls[ok.calls.length - 1] === 'detach', JSON.stringify(ok.calls));

    const noHit = make({
      'DOM.enable': () => ({}),
      'DOM.getFrameOwner': () => ({ backendNodeId: 99 }),
      'DOM.describeNode': () => ({ node: { contentDocument: { nodeId: 5 } } }),
      'DOM.querySelector': () => ({ nodeId: 0 })
    });
    check('选择器未命中返回 null', (await noHit.run(1, '#nope', 5)) === null);

    const noDoc = make({
      'DOM.enable': () => ({}),
      'DOM.getFrameOwner': () => ({ backendNodeId: 99 }),
      'DOM.describeNode': () => ({ node: {} })
    });
    check('读不到内容文档返回 null', (await noDoc.run(1, '#hit', 7)) === null);

    const attachFail = new Function('chrome', src + '\nreturn elementRectByCdp;')({
      debugger: {
        attach: async () => { throw new Error('Another debugger is already attached'); },
        detach: async () => { throw new Error('not attached'); },
        sendCommand: async () => { throw new Error('不该被调用'); }
      }
    });
    check('调试器附加失败返回 null 而不是抛错', (await attachFail(1, '#hit', 5)) === null);
  }

  /* ================================================================ *
   * 5. unmark：清不掉的标签页要报出来
   *
   * 踩过的：失败判据取的是 Promise 的 rejected，而清标记的两个函数内部都吞掉异常，
   * 于是 failed 永远是空的，"N 个标签页无响应"的提示从来没出现过，
   * 冻结标签页里残留的标记也没人知道。
   * ================================================================ */
  console.log('\n[5] unmarkTask：失败项统计');
  {
    const makeUnmarkTask = (pageClearedFor) => new Function(
      'chrome', 'resolveTab', 'removeBadge', 'hideIndicator', 'collectMarkedTabs', 'saveMarks', 'markedTabs', 'BROWSER_NAME',
      need('unmarkTask') + '\nreturn unmarkTask;'
    )(
      { tabs: { query: async () => [{ id: 1 }, { id: 2 }] } },
      async () => null,
      async (id) => pageClearedFor(id),
      async (id) => pageClearedFor(id),
      async () => [1, 2],
      async () => {},
      new Set([1, 2]),
      'edge'
    );

    const partial = await makeUnmarkTask((id) => id !== 1)({});
    check('清不掉的标签页被统计出来',
      Array.isArray(partial.data.failed) && partial.data.failed.length === 1 && partial.data.failed[0] === 1,
      JSON.stringify(partial.data.failed));
    check('带出说明原因的 note', typeof partial.data.note === 'string' && partial.data.note.includes('1 个'),
      String(partial.data.note));
    check('部分失败时整体仍是 ok（冻结标签页是常态）', partial.ok === true);

    const all = await makeUnmarkTask(() => true)({});
    check('全部清掉时没有 note', all.data.failed.length === 0 && all.data.note === undefined,
      JSON.stringify(all.data));
  }

  /* ================================================================ *
   * 6. grab：中断与根本没登记下载项都算失败
   *
   * 踩过的：等下载的循环跑完后无条件 return ok:true，下载被服务端拒绝而中断、
   * 或者压根没登记下载项（扩展侧失败、页面兜底也没触发下载）时都报成功，
   * 调用方以为文件已经在磁盘上。同仓的 save 对同一种情况是报错的。
   * ================================================================ */
  console.log('\n[6] grabTab：下载结果');
  {
    const src = need('grabTab');
    const makeGrab = (downloadItem, extensionDownload) => {
      const created = [];
      const chrome = {
        downloads: {
          onCreated: { addListener: (f) => created.push(f), removeListener: () => {} },
          download: async () => {
            if (extensionDownload === 'throw') { throw new Error('blob url rejected'); }
            created.forEach((f) => f({ id: extensionDownload }));
            return extensionDownload;
          },
          search: async () => (downloadItem ? [downloadItem] : [])
        },
        debugger: {
          attach: async () => {},
          detach: async () => {},
          onEvent: { addListener: () => {}, removeListener: () => {} },
          sendCommand: async () => ({})
        },
        scripting: {
          executeScript: async () => [
            { result: { ok: true, bytes: 1234, type: 'video/mp4', objectUrl: 'blob:abc' } }
          ]
        }
      };
      return new Function(
        'chrome', 'resolveTab', 'withTimeout', 'tabUnresponsive', 'filenameFromUrl', 'withMediaSubdir',
        src + '\nreturn grabTab;'
      )(
        chrome,
        async () => ({ id: 3, url: 'https://e.test/page' }),
        (p) => p,
        () => ({ ok: false, error: 'tab_unresponsive' }),
        () => 'f.bin',
        (n) => 'videos/' + n
      );
    };

    const stopped = await makeGrab(
      { id: 9, state: 'interrupted', error: 'SERVER_FORBIDDEN', filename: null, totalBytes: 0 }, 9
    )({ url: 'https://e.test/a.mp4', match: 'e.test', waitMs: 200 });
    check('中断报 ok:false / interrupted',
      stopped.ok === false && stopped.error === 'interrupted', JSON.stringify(stopped));
    check('中断带出底层原因', stopped.reason === 'SERVER_FORBIDDEN', JSON.stringify(stopped.reason));

    const done = await makeGrab({ id: 9, state: 'complete', filename: 'videos/f.bin', totalBytes: 4321 }, 9)(
      { url: 'https://e.test/a.mp4', match: 'e.test', waitMs: 200 });
    check('完成仍是 ok:true 且 done=true', done.ok === true && done.data.done === true,
      JSON.stringify(done).slice(0, 160));

    const never = await makeGrab(null, 'throw')({ url: 'https://e.test/a.mp4', match: 'e.test', waitMs: 400 });
    check('从未登记下载项报 ok:false / download_not_tracked',
      never.ok === false && never.error === 'download_not_tracked', JSON.stringify(never));
  }

  /* ================================================================ *
   * 7. eval：代码只能在一个框架里跑
   *
   * 踩过的：没指定 frameId 时用 allFrames 注入，带副作用的代码在每个框架里各跑一遍，
   * 而回报的只是其中一份结果——点按钮、提交表单各发生 N 次，输出里看不出来。
   * click / type / key 早就改成了"先探测再单框架执行"，eval 漏在外面。
   * ================================================================ */
  console.log('\n[7] evalTab：只注入一个框架');
  {
    const src = need('evalTab');
    let seen = null;
    const makeEvalTab = (injection) => {
      seen = null;
      const chrome = { scripting: { executeScript: async (opts) => { seen = opts; return injection; } } };
      return new Function(
        'chrome', 'resolveTab', 'ensureInjectable', 'withTimeout', 'tabUnresponsive', 'INJECT_TIMEOUT_MS', 'evalInPage', 'EVAL_MAX_JSON',
        src + '\nreturn evalTab;'
      )(
        chrome,
        async () => ({ id: 1, active: false, url: 'https://e.test/p', title: 't' }),
        async () => ({}),
        (p) => p,
        () => ({ ok: false, error: 'tab_unresponsive' }),
        12000,
        async () => ({ ok: true, value: 1 }),
        200 * 1024
      );
    };

    await makeEvalTab([{ frameId: 0, result: { ok: true, value: 'T' } }])({ code: 'document.title' });
    check('默认只注入主框架',
      seen && seen.target.frameIds && seen.target.frameIds.length === 1 && seen.target.frameIds[0] === 0,
      JSON.stringify(seen && seen.target));
    check('不再使用 allFrames', seen && seen.target.allFrames === undefined, JSON.stringify(seen && seen.target));

    await makeEvalTab([{ frameId: 4, result: { ok: true, value: 'inner' } }])({ code: 'x', frameId: 4 });
    check('指定 frameId 时只注入该框架',
      seen && seen.target.frameIds.length === 1 && seen.target.frameIds[0] === 4,
      JSON.stringify(seen && seen.target));

    const err = await makeEvalTab([{ frameId: 0, result: { ok: false, evalError: 'x is not defined' } }])({ code: 'x' });
    check('主框架报错时 ok:false', err.ok === false && err.error === 'eval_error', JSON.stringify(err).slice(0, 160));
    check('主框架报错时提示可以换框架', typeof err.hint === 'string' && err.hint.includes('frameId'), String(err.hint));

    const err2 = await makeEvalTab([{ frameId: 4, result: { ok: false, evalError: 'boom' } }])({ code: 'x', frameId: 4 });
    check('已指定框架时不再提示换框架', err2.hint === undefined, String(err2.hint));
  }

  /* ================================================================ *
   * 8. screenshot：主框架走注入，子框架走 CDP
   *
   * 踩过的：元素矩形测量把 frameId 兜成 0，子框架分支成了死代码；
   * 而真给了子框架 frameId 时又拿框架内的坐标去裁图，裁到页面别处。
   * ================================================================ */
  console.log('\n[8] screenshotTab：元素定位分支');
  {
    const src = need('screenshotTab');
    let calls = [];
    const makeShot = (rect) => {
      calls = [];
      return new Function(
        'chrome', 'resolveTab', 'ensureInjectable', 'elementRectInMainFrame', 'elementRectByCdp', 'captureByCdp', 'withTimeout', 'tabUnresponsive',
        src + '\nreturn screenshotTab;'
      )(
        { tabs: {} },
        async () => ({ id: 2, active: true, url: 'https://e.test/p', title: 't', width: 800, height: 600, windowId: 1 }),
        async () => ({}),
        async (tabId, selector) => { calls.push(['main', selector]); return rect; },
        async (tabId, selector, frameId) => { calls.push(['cdp', selector, frameId]); return rect; },
        async () => ({ dataUrl: 'data:image/png;base64,AAA', width: 10, height: 10 }),
        (p) => p,
        () => ({ ok: false, error: 'tab_unresponsive' })
      );
    };
    const rect = { x: 1, y: 2, width: 3, height: 4, scale: 1 };

    await makeShot(rect)({ selector: '#x' });
    check('未指定 frameId 时用注入量主框架', calls.length === 1 && calls[0][0] === 'main', JSON.stringify(calls));

    await makeShot(rect)({ selector: '#x', frameId: 4 });
    check('指定子框架时改用 CDP',
      calls.length === 1 && calls[0][0] === 'cdp' && calls[0][2] === 4, JSON.stringify(calls));

    await makeShot(rect)({ selector: '#x', frameId: 0 });
    check('frameId=0 仍走注入', calls.length === 1 && calls[0][0] === 'main', JSON.stringify(calls));

    const miss = await makeShot(null)({ selector: '#x' });
    check('量不到元素时报 element_not_found',
      miss.ok === false && miss.error === 'element_not_found', JSON.stringify(miss).slice(0, 160));
    check('报错时提示用 frames 查 frameId',
      typeof miss.hint === 'string' && miss.hint.includes('frames'), String(miss.hint));
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
