/**
 * 动作实现：截图。CDP 截后台标签页/整页/元素，失败时退避扩展自带截屏。
 *
 * 对应 action：screenshot。
 */

import { rectInPage } from './inject-read.js';
import { advancedNotGranted, INJECT_TIMEOUT_MS, ensureInjectable, resolveTab, withTimeout } from './guards.js';

async function captureByCdp(tabId, format, clip, beyondViewport) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const params = { format, captureBeyondViewport: !!beyondViewport };
    if (clip) {
      params.clip = clip;
    }
    const shot = await withTimeout(
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params),
      20000
    );
    if (!shot || !shot.data) {
      throw new Error('empty_screenshot');
    }
    // 顺带取一下页面实际尺寸，便于调用方判断
    let metrics = null;
    try {
      metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    } catch (e) { /* 忽略 */ }
    const content = metrics && metrics.cssContentSize ? metrics.cssContentSize : null;
    // 整页截图才有意义报内容尺寸；否则报视口尺寸，避免误导
    const showContentSize = !!beyondViewport;
    return {
      dataUrl: 'data:image/' + format + ';base64,' + shot.data,
      width: clip ? Math.round(clip.width) : (showContentSize && content ? Math.round(content.width) : null),
      height: clip ? Math.round(clip.height) : (showContentSize && content ? Math.round(content.height) : null)
    };
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) { /* 忽略 */ }
  }
}

async function elementRectInMainFrame(tabId, selector) {
  try {
    const injection = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: rectInPage,
        args: [selector]
      }),
      INJECT_TIMEOUT_MS
    );
    const hit = (injection || []).find((r) => r.result);
    return hit ? hit.result : null;
  } catch (e) {
    return null;
  }
}

async function elementRectByCdp(tabId, selector, frameId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    return null;
  }

  try {
    await chrome.debugger.sendCommand(target, 'DOM.enable');

    // 先拿到该框架自身的文档节点
    const owner = await chrome.debugger.sendCommand(target, 'DOM.getFrameOwner', { frameId });
    if (!owner || typeof owner.backendNodeId !== 'number') { return null; }
    const described = await chrome.debugger.sendCommand(target, 'DOM.describeNode', {
      backendNodeId: owner.backendNodeId,
      pierce: true
    });
    const contentDoc = described && described.node ? described.node.contentDocument : null;
    if (!contentDoc || typeof contentDoc.nodeId !== 'number') { return null; }

    const found = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
      nodeId: contentDoc.nodeId,
      selector
    });
    if (!found || typeof found.nodeId !== 'number' || found.nodeId === 0) { return null; }

    const box = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId: found.nodeId });
    const quad = box && box.model ? box.model.content : null;
    if (!quad || quad.length < 8) { return null; }

    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min.apply(null, xs);
    const y = Math.min.apply(null, ys);
    const width = Math.max.apply(null, xs) - x;
    const height = Math.max.apply(null, ys) - y;
    if (!width || !height) { return null; }

    // CDP 给的是视口坐标，clip 要的是页面坐标，补上主框架的滚动偏移
    let scrollX = 0;
    let scrollY = 0;
    try {
      const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
      const viewport = metrics && metrics.cssVisualViewport;
      if (viewport) {
        scrollX = viewport.pageX || 0;
        scrollY = viewport.pageY || 0;
      }
    } catch (e) {
      // 拿不到滚动偏移就按未滚动处理；比直接放弃截图更接近预期
    }

    return { x: x + scrollX, y: y + scrollY, width, height, scale: 1 };
  } catch (e) {
    return null;
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) { /* 忽略 */ }
  }
}

export async function screenshotTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const format = task.format === 'jpeg' ? 'jpeg' : 'png';

  // debugger 默认不授予（可选权限）。未授予时 CDP 整条路不可用：
  // 后台标签页/整页/跨框架元素直接报可理解的错误，
  // 前台可视区域退回扩展自带截屏，与"CDP 失败"的退避语义一致。
  const notGranted = await advancedNotGranted();

  // 元素截图：先量出元素在页面坐标里的矩形。
  // 主框架直接注入量；指定了子框架就交给 CDP——注入量到的坐标是那个框架自己的
  // 坐标系，直接当 clip 用会截到页面别的区域。
  let clip = null;
  if (task.selector) {
    const frameId = typeof task.frameId === 'number' ? task.frameId : 0;
    clip = frameId === 0
      ? await elementRectInMainFrame(tab.id, task.selector)
      : (notGranted ? null : await elementRectByCdp(tab.id, task.selector, frameId));
    if (!clip) {
      if (notGranted && frameId !== 0) {
        return { ...notGranted, url: tab.url };
      }
      return {
        ok: false,
        error: 'element_not_found',
        selector: task.selector,
        frameId,
        url: tab.url,
        hint: frameId === 0
          ? '元素不在主框架里。用 frames 动作查出它所在框架的 frameId，再用 --frameId 指定。'
          : '该框架里没有命中这个选择器，或框架内容读不到（跨进程 iframe）。'
      };
    }
  }

  // 未授予时不允许走 CDP；非激活标签页连退避都不可用（captureVisibleTab 只截
  // 当前可见标签页，硬截会返回同一窗口里另一个标签页的画面），直接报门禁错误。
  if (notGranted && !tab.active) {
    return { ...notGranted, url: tab.url };
  }

  // 首选 CDP：能截后台标签页、整页和指定元素（中途会短暂附加调试器）
  let cdpMessage = null;
  if (!notGranted) {
    try {
      const cdp = await captureByCdp(tab.id, format, clip, !!task.full || !!clip);
      return {
        ok: true,
        data: {
          tabId: tab.id,
          url: tab.url,
          width: cdp.width || tab.width || null,
          height: cdp.height || tab.height || null,
          format,
          via: 'cdp',
          selector: task.selector || null,
          fullPage: !!task.full,
          dataUrl: cdp.dataUrl
        }
      };
    } catch (e) {
      cdpMessage = String(e && e.message ? e.message : e);

      // 退避：CDP 不可用时改用扩展自带截屏，但它只能截当前可见标签页
      if (!tab.active) {
        return {
          ok: false,
          error: 'capture_failed',
          url: tab.url,
          message: cdpMessage,
          hint: 'CDP 截屏失败且该标签页不是激活状态（扩展自带截屏只能截当前可见标签页）。'
            + '可先关掉该标签页的 DevTools，或让该页面在前台后重试。'
        };
      }
    }
  }

  try {
    const dataUrl = await withTimeout(
      chrome.tabs.captureVisibleTab(tab.windowId, { format }),
      15000
    );
    return {
      ok: true,
      data: {
        tabId: tab.id,
        url: tab.url,
        width: tab.width || null,
        height: tab.height || null,
        format,
        via: 'captureVisibleTab',
        selector: null,
        fullPage: false,
        note: notGranted
          ? '未授予“增强功能”权限，退避用了扩展自带截屏：只截到当前可见标签页的可视区域；'
            + '整页、后台标签页和跨框架元素截图需要在扩展弹窗里授予后重试。'
          : (clip ? '元素截图不支持退避方案，已返回可视区域整屏' : undefined),
        dataUrl
      }
    };
  } catch (e2) {
    if (notGranted) {
      return { ...notGranted, url: tab.url };
    }
    return {
      ok: false,
      error: 'capture_failed',
      url: tab.url,
      message: String(e2 && e2.message ? e2.message : e2),
      cdpMessage
    };
  }
}
