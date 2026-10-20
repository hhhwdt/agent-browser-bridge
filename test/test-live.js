#!/usr/bin/env node
/**
 * 真机冒烟测试：不需要任何配置。
 *
 * 其他 test-*.js 都要先配 test-config.js 指向一个你已登录、可安全操作的页面。
 * 这个不同：它把桥接服务自己的地址（http://127.0.0.1:18777/）当测试床——该地址在
 * 清单的必需 host_permissions 里，因此天然已授权，不需要你在弹窗里点任何授权。
 *
 * 流程：后台新开一个标签页 → 注入测试夹具 → 逐个动作验证 → 清除标记并关闭标签页。
 * 全程不动你正在用的标签页，也不抢焦点。
 *
 * 覆盖的是几处"错了会静默做两遍"的地方：
 *   - click / type / key 在多个框架里同时命中时，只能执行一次
 *   - eval 里没写 return 的语句，只能执行一次
 *   - download 的大结果体（超过旧版 1MB 上限的那种）能完整回传
 *
 *   node test-live.js
 */

'use strict';

const http = require('node:http');
const { createClient } = require('../src/client.js');

const ab = createClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let tabId = null;
let fileSrv = null;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}  ${detail === undefined ? '' : JSON.stringify(detail).slice(0, 240)}`);
  }
}

/** 给 download 测试提供一个大文件。凭据模式下跨域要求回带精确 Origin，不能用 *。 */
function startFileServer() {
  return new Promise((resolve) => {
    fileSrv = http.createServer((req, res) => {
      if (req.url !== '/big.bin') { res.writeHead(404).end(); return; }
      const buf = Buffer.alloc(2 * 1024 * 1024, 0x41);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': 'http://127.0.0.1:18777',
        'Access-Control-Allow-Credentials': 'true'
      });
      res.end(buf);
    });
    fileSrv.listen(0, '127.0.0.1', () => resolve(fileSrv.address().port));
  });
}

(async () => {
  try {
    const health = await ab.health();
    if (!health.extensionConnected) {
      console.error('扩展未连接，先确认桥接服务与扩展都在运行。');
      process.exit(3);
    }

    console.log('\n[1] 在已授权 origin 上开一个后台标签页');
    const nav = await ab.navigate({ url: 'http://127.0.0.1:18777/health', newTab: true });
    tabId = nav.tabId;
    check('后台新建标签页（不抢焦点）', nav.openedNewTab === true && nav.wasActive === false, nav);
    const rd = await ab.read({ tabId });
    // 不断言正文内容：application/json 页面由浏览器内置查看器渲染，文字随版本变化
    check('能读到页面正文', rd.ok !== false && typeof rd.text === 'string' && rd.charCount > 0,
      { chars: rd.charCount });

    console.log('\n[2] 注入测试夹具：主框架与 iframe 各放一个同名按钮');
    await ab.evalPage({
      tabId,
      code: `
        window.__clicks = 0;
        window.__iframeClicks = 0;
        const b = document.createElement('button');
        b.id = 'abb-main-btn';
        b.textContent = 'ABB_TEST_BTN';
        b.onclick = () => { window.__clicks++; };
        document.body.appendChild(b);
        const inp = document.createElement('input');
        inp.id = 'abb-input';
        document.body.appendChild(inp);
        const ce = document.createElement('div');
        ce.id = 'abb-ce';
        ce.setAttribute('contenteditable', 'true');
        document.body.appendChild(ce);
        const f = document.createElement('iframe');
        f.id = 'abb-frame';
        f.style.cssText = 'width:400px;height:80px';
        f.srcdoc = '<button id="abb-dup" onclick="parent.__iframeClicks++">ABB_TEST_BTN</button>';
        document.body.appendChild(f);
        return 'ready';
      `
    });
    await sleep(600);
    const frames = await ab.frames({ tabId });
    check('iframe 已挂载（存在多个框架）', frames.frameCount >= 2, { frameCount: frames.frameCount });

    console.log('\n[3] click：同名按钮在两个框架里都有，只能点一次');
    const clk = await ab.click({ tabId, text: 'ABB_TEST_BTN' });
    check('点击成功', clk.ok !== false, clk);
    check('命中主框架', clk.frameId === 0, { frameId: clk.frameId });
    await sleep(300);
    const afterClick = await ab.evalPage({
      tabId,
      code: 'return { main: window.__clicks, iframe: window.__iframeClicks }'
    });
    const c = afterClick.value || {};
    check('总点击数 = 1', (c.main || 0) + (c.iframe || 0) === 1, c);

    console.log('\n[4] type：输入框只写一次');
    await ab.type({ tabId, selector: '#abb-input', value: 'HELLO' });
    const afterType = await ab.evalPage({ tabId, code: 'return document.querySelector("#abb-input").value' });
    check('输入框内容为单份 HELLO', afterType.value === 'HELLO', afterType.value);

    console.log('\n[5] type：contenteditable 只插一次');
    await ab.type({ tabId, selector: '#abb-ce', value: 'XYZ' });
    const afterCe = await ab.evalPage({ tabId, code: 'return document.querySelector("#abb-ce").innerText' });
    check('可编辑区内容为单份 XYZ', String(afterCe.value || '').trim() === 'XYZ', afterCe.value);

    console.log('\n[6] key：只派发一次');
    await ab.evalPage({
      tabId,
      code: 'window.__keys = 0; const i = document.querySelector("#abb-input"); i.focus(); i.addEventListener("keydown", () => { window.__keys++; }); return 1'
    });
    await ab.key({ tabId, key: 'Enter', selector: '#abb-input' });
    const afterKey = await ab.evalPage({ tabId, code: 'return window.__keys' });
    check('keydown 计数 = 1', afterKey.value === 1, afterKey.value);

    console.log('\n[7] eval：没写 return 的语句只执行一次');
    await ab.evalPage({ tabId, code: 'window.__n = 0; return 1' });
    await ab.evalPage({ tabId, code: 'window.__n = (window.__n || 0) + 1' });
    const afterEval = await ab.evalPage({ tabId, code: 'return window.__n' });
    check('副作用执行 1 次', afterEval.value === 1, afterEval.value);

    console.log('\n[8] eval：裸表达式与 return 两种写法都能取值');
    const expr = await ab.evalPage({ tabId, code: 'document.title' });
    check('裸表达式取到值', typeof expr.value === 'string' && expr.value.length > 0, expr.value);
    const ret = await ab.evalPage({ tabId, code: 'return document.title' });
    check('return 风格取到值', ret.value === expr.value, ret.value);

    console.log('\n[9] screenshot');
    let shot = await ab.screenshot({ tabId, full: true }).catch((e) => ({ _threw: e }));
    if (shot._threw && shot._threw.code !== 'advanced_not_granted') {
      check('整页截图发起成功', false, { code: shot._threw.code, message: shot._threw.message });
      shot = null;
    } else if (shot._threw) {
      // debugger 从 1.9.0 起是可选权限，全新 profile 没人点过弹窗授予。
      // 激活标签页后走退避：前台可视区域截图不需要 debugger，照样验动作链路；
      // 整页截图等授予后的本地环境再验。
      console.log('     debugger 未授予：激活标签页后改验退避路径（可视区域），整页截图留给已授予的环境');
      await ab.activate({ tabId });
      shot = await ab.screenshot({ tabId }).catch((e) => ({ _threw2: e }));
      if (shot._threw2) {
        check('退避截图发起成功', false, { code: shot._threw2.code, message: shot._threw2.message });
        shot = null;
      }
    }
    if (shot) {
      check('截图返回 dataUrl', String(shot.dataUrl || '').length > 1000, { error: shot.error, via: shot.via });
    }

    console.log('\n[10] download：2MB 文件（结果体约 2.7MB，旧版 1MB 上限会掐断连接）');
    const port = await startFileServer();
    const dl = await ab.download({ tabId, url: `http://127.0.0.1:${port}/big.bin` });
    check('下载成功且字节数正确', dl.ok !== false && dl.bytes === 2 * 1024 * 1024, { bytes: dl.bytes });
    check('base64 长度与 2MB 相符',
      String(dl.base64 || '').length === Math.ceil((2 * 1024 * 1024) / 3) * 4,
      String(dl.base64 || '').length);

    console.log('\n[11] wait：等待条件');
    const w = await ab.wait({ tabId, selector: '#abb-main-btn', timeoutMs: 3000 });
    check('已存在的元素立即满足', w.ok !== false, w);
    const w2 = await ab.wait({ tabId, selector: '#abb-nonexistent', timeoutMs: 1200 }).catch((e) => ({ err: e.code }));
    check('不存在的元素按时超时', w2.err === 'wait_timeout', w2);
  } catch (e) {
    fail++;
    console.log(`  FAIL 抛出异常: ${e && e.code ? e.code + ' ' : ''}${e && e.message ? e.message : e}`);
  } finally {
    try {
      // 只清自己这个标签页的标记。不要用 unmark all：那会把这个浏览器里
      // 你（或你正在跑的 agent）在其他页面上留下的标记一并清掉。
      const u = await ab.unmark({ tabId });
      console.log(`\n已清除标记: ${(u.cleared || []).join(', ') || '（无）'}`);
    } catch (e) {
      console.log('\n清除标记失败: ' + e.message);
    }
    if (tabId !== null) {
      try {
        const cl = await ab.close({ tabId });
        console.log(`已关闭标签页 ${tabId}: ${cl.closedTitle}`);
      } catch (e) {
        console.log(`关闭标签页 ${tabId} 失败: ` + e.message);
      }
    }
    if (fileSrv) { fileSrv.close(); }
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
