/**
 * 动作实现：文件传输——上传（CDP 塞 file input）、抓取（防盗链补 CORS 头）、
 * 保存（浏览器下载栈）、下载（页面内 fetch 回传 base64）。
 *
 * 对应 action：upload / grab / save / download。
 */

import { fetchInPage } from './inject-media.js';
import { advancedNotGranted, ensureInjectable, injectAndPick, resolveTab, withTimeout } from './guards.js';

export async function uploadTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }
  const files = Array.isArray(task.files) ? task.files.filter(Boolean) : [];
  if (files.length === 0) {
    return { ok: false, error: 'missing_files', hint: '用 --file <绝对路径> 指定要上传的文件，可重复多次' };
  }

  const selector = task.selector || 'input[type=file]';
  const target = { tabId: tab.id };

  const notGranted = await advancedNotGranted();
  if (notGranted) {
    return { ...notGranted, url: tab.url };
  }

  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    return {
      ok: false,
      error: 'cdp_attach_failed',
      message: String(e && e.message ? e.message : e),
      hint: '该标签页可能开着 DevTools（一个标签页同时只能有一个调试器），关掉 DevTools 再试。'
    };
  }

  try {
    const doc = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1 });
    const found = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector
    });
    if (!found || !found.nodeId) {
      return { ok: false, error: 'element_not_found', selector, url: tab.url };
    }
    await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', {
      files,
      nodeId: found.nodeId
    });
    return {
      ok: true,
      data: {
        tabId: tab.id,
        url: tab.url,
        selector,
        files: files.map((p) => String(p).split(/[\\/]/).pop())
      }
    };
  } catch (e) {
    return { ok: false, error: 'upload_failed', message: String(e && e.message ? e.message : e), url: tab.url };
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 保存「有防盗链且不发 CORS 头」的媒体。
 *
 * save 走浏览器下载栈，不带 Referer，会被防盗链 403；download 在页面里 fetch
 * 能带上 Referer，但跨域读取被 CORS 拦。这里把两者拼起来：
 *   1. 用 CDP 的 Fetch 域在**响应阶段**拦截目标 CDN 的响应，
 *      给它补上 Access-Control-Allow-Origin，让页面能合法读到字节；
 *   2. 页面内 fetch（自动带正确的 Referer）拿到 blob，
 *      用 blob URL + <a download> 触发浏览器下载，字节不经过桥接服务；
 *   3. 全程只在目标 origin 上拦截，其他请求原样放行，避免卡住页面。
 *
 * 代价：期间会短暂附加调试器（浏览器顶部会出现提示条），且与 DevTools 互斥。
 */
export async function grabTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页' };
  }
  if (!task.url) { return { ok: false, error: 'missing_url', hint: '用 --url 指定媒体地址' }; }

  let pattern;
  try { pattern = new URL(task.url).origin + '/*'; }
  catch (e) { return { ok: false, error: 'bad_url', url: task.url }; }

  const notGranted = await advancedNotGranted();
  if (notGranted) {
    return { ...notGranted, url: task.url };
  }

  const target = { tabId: tab.id };
  const targetKey = String(task.url).slice(0, 120);
  const paused = [];
  let attached = false;
  let downloadId = null;

  /** 只拦截目标响应，其余一律放行，否则页面会被 Fetch 域卡住。 */
  const onEvent = (source, method, params) => {
    if (!source || source.tabId !== tab.id || method !== 'Fetch.requestPaused') { return; }
    const p = params || {};
    const url = (p.request && p.request.url) || '';
    const isTarget = url.includes(targetKey) || url.slice(0, 120) === targetKey;

    if (isTarget && p.responseStatusCode) {
      const headers = (p.responseHeaders || [])
        .filter((h) => h.name.toLowerCase() !== 'access-control-allow-origin');
      headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      paused.push({ url: url.slice(0, 90), status: p.responseStatusCode });

      chrome.debugger.sendCommand(target, 'Fetch.continueResponse', {
        requestId: p.requestId,
        responseHeaders: headers
      }).catch(() => {
        chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      });
      return;
    }

    chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  };

  // 页面触发下载后，由这里拿到 downloadId，才能等到它真正落盘
  const onCreated = (item) => {
    if (downloadId === null && item && typeof item.id === 'number') { downloadId = item.id; }
  };

  // 页面侧用 <a download> 触发下载，文件名只能是纯名字（不能带路径），
  // 因此这里不加子目录；落点由浏览器下载目录决定，与 save 相同。
  const filename = task.filename
    ? String(task.filename).split(/[\\/]/).pop()
    : filenameFromUrl(task.url);

  try {
    chrome.downloads.onCreated.addListener(onCreated);
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    chrome.debugger.onEvent.addListener(onEvent);
    await chrome.debugger.sendCommand(target, 'Fetch.enable', {
      patterns: [{ urlPattern: pattern, requestStage: 'Response' }]
    });

    const inj = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (url, name) => {
        try {
          const res = await fetch(url, { credentials: 'omit', mode: 'cors' });
          if (!res.ok) { return { ok: false, status: res.status }; }
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          // 交给扩展用 chrome.downloads 接管，这样能指定子目录与重名策略；
          // 成功后由扩展通知页面回收 blob URL。
          return { ok: true, bytes: blob.size, type: blob.type || null, objectUrl };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      },
      args: [task.url, filename]
    }), task.timeoutMs || 180000);

    const fetched = inj && inj[0] ? inj[0].result : null;

    if (!fetched || !fetched.ok) {
      return {
        ok: false,
        error: 'grab_fetch_failed',
        url: task.url,
        status: fetched && fetched.status,
        message: fetched && fetched.error,
        cdpPaused: paused,
        hint: '页面内取流失败。注意 grab 与 DevTools 互斥（一个标签页同时只能有一个调试器）。'
      };
    }

    // 用扩展的下载栈接管页面里生成的 blob URL，从而能指定统一子目录
    if (fetched.objectUrl) {
      try {
        downloadId = await chrome.downloads.download({
          url: fetched.objectUrl,
          filename: withMediaSubdir(task.filename || filenameFromUrl(task.url)),
          conflictAction: task.overwrite ? 'overwrite' : 'uniquify'
        });
      } catch (e) {
        // 跨上下文 blob URL 不被接受时，退回页面自己触发下载（会落在下载根目录）
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (u, n) => {
            const a = document.createElement('a');
            a.href = u; a.download = n; a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { try { URL.revokeObjectURL(u); a.remove(); } catch (e) { /* 忽略 */ } }, 60000);
          },
          args: [fetched.objectUrl, filename]
        }).catch(() => {});
      }
    } else {
      return { ok: false, error: 'grab_no_blob_url', url: task.url, cdpPaused: paused };
    }

    // 等下载真正落盘
    const waitMs = typeof task.waitMs === 'number' ? task.waitMs : 60000;
    const deadline = Date.now() + waitMs;
    let item = null;
    while (Date.now() < deadline) {
      if (downloadId !== null) {
        const found = await chrome.downloads.search({ id: downloadId }).catch(() => null);
        item = found && found[0] ? found[0] : null;
        if (item && (item.state === 'complete' || item.state === 'interrupted')) { break; }
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // 从头到尾没有登记任何下载项：扩展侧接管失败，页面兜底的 <a download> 也没触发下载。
    // 这种情况下文件不在磁盘上，报成功会让调用方以为已经拿到了。
    if (downloadId === null) {
      return {
        ok: false,
        error: 'download_not_tracked',
        url: task.url,
        fetchedBytes: fetched.bytes,
        cdpPaused: paused,
        hint: '页面已取到数据，但浏览器没有登记任何下载项，无法确认文件是否落盘。'
      };
    }

    // 与 save 保持一致：中断就是失败，不能只看"下载项存在"
    if (item && item.state === 'interrupted') {
      return {
        ok: false,
        error: 'interrupted',
        url: task.url,
        downloadId,
        fetchedBytes: fetched.bytes,
        cdpPaused: paused,
        reason: item.error || null,
        hint: '下载被中断（服务端拒绝、磁盘不可写或被取消），文件没有完整落盘。'
      };
    }

    return {
      ok: true,
      data: {
        tabId: tab.id,
        url: task.url,
        fetchedBytes: fetched.bytes,
        mime: fetched.type,
        cdpPaused: paused,
        downloadId,
        state: item ? item.state : 'unknown',
        filename: item ? item.filename : null,
        bytes: item && item.totalBytes > 0 ? item.totalBytes : fetched.bytes,
        done: !!item && item.state === 'complete'
      }
    };
  } catch (e) {
    return { ok: false, error: 'grab_failed', message: String(e && e.message ? e.message : e) };
  } finally {
    try { chrome.downloads.onCreated.removeListener(onCreated); } catch (e) { /* 忽略 */ }
    try { chrome.debugger.onEvent.removeListener(onEvent); } catch (e) { /* 忽略 */ }
    if (attached) {
      try { await chrome.debugger.sendCommand(target, 'Fetch.disable'); } catch (e) { /* 忽略 */ }
      try { await chrome.debugger.detach(target); } catch (e) { /* 忽略 */ }
    }
  }
}

/**
 * 用浏览器自己的下载栈把 URL 落盘。
 *
 * 与 downloadTab 的本质区别：
 *   - 这是浏览器级下载，不是页面内的 fetch，因此**不受 CORS 限制**，
 *     也不受 downloadTab 那个 20MB 上限约束；
 *   - 字节直接写盘，不经过桥接服务回传，因此大文件（视频）也可行；
 *   - 文件落在浏览器下载目录，filename 只能指定其下的相对路径。
 *
 * 不支持 blob: —— 那是页面内存里的对象引用，不是可下载的网络地址。
 */
export async function saveTab(task) {
  if (!task.url) {
    return { ok: false, error: 'missing_url', hint: '用 --url 指定要保存的地址' };
  }

  // 允许相对地址：给出标签页时按该页面的 URL 解析
  let target = String(task.url);
  let pageUrl = null;
  if (typeof task.tabId === 'number' || task.match || task.url) {
    const tab = await resolveTab(task).catch(() => null);
    if (tab && tab.url) {
      pageUrl = tab.url;
      try { target = new URL(target, tab.url).href; } catch (e) { /* 保持原值 */ }
    }
  }

  if (target.startsWith('blob:')) {
    return {
      ok: false,
      error: 'unsupported_scheme',
      url: target,
      hint: 'blob: 是页面内存里的对象引用，无法用浏览器下载栈保存。可在页面内用 eval 取出为 data URL，但受体积限制。'
    };
  }
  if (!/^https?:/i.test(target)) {
    return { ok: false, error: 'unsupported_scheme', url: target, hint: '只支持 http/https 地址' };
  }

  const options = {
    url: target,
    // 同名文件默认自动改名，避免静默覆盖已有文件
    conflictAction: task.overwrite ? 'overwrite' : 'uniquify'
  };
  options.filename = withMediaSubdir(task.filename || filenameFromUrl(target));
  if (task.saveAs) { options.saveAs = true; }

  let downloadId;
  try {
    downloadId = await chrome.downloads.download(options);
  } catch (e) {
    return { ok: false, error: 'download_failed', url: target, message: String(e && e.message ? e.message : e) };
  }

  // 等待完成，好把真实落盘路径回报给调用方
  const waitMs = typeof task.waitMs === 'number' ? task.waitMs : 30000;
  const deadline = Date.now() + waitMs;
  let item = null;

  for (;;) {
    const found = await chrome.downloads.search({ id: downloadId }).catch(() => null);
    item = found && found[0] ? found[0] : null;
    if (!item) { break; }
    if (item.state === 'complete' || item.state === 'interrupted') { break; }
    if (Date.now() >= deadline) { break; }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!item) {
    return { ok: true, data: { downloadId, url: target, pageUrl, state: 'unknown' } };
  }

  if (item.state === 'interrupted') {
    return {
      ok: false,
      error: 'interrupted',
      url: target,
      pageUrl,
      reason: item.error || null,
      hint: item.error === 'SERVER_FORBIDDEN' || item.error === 'SERVER_UNAUTHORIZED'
        ? '服务器拒绝下载，可能是链接已过期或不带正确的登录态。'
        : undefined
    };
  }

  return {
    ok: true,
    data: {
      downloadId,
      url: target,
      pageUrl,
      state: item.state,
      filename: item.filename || null,
      bytes: item.totalBytes > 0 ? item.totalBytes : (item.bytesReceived || null),
      mime: item.mime || null,
      done: item.state === 'complete'
    }
  };
}

export async function downloadTab(task) {
  const tab = await resolveTab(task);
  if (!tab || typeof tab.id !== 'number') {
    return { ok: false, error: 'no_tab_matched', hint: '没有找到匹配的标签页，可用 tabs 查看当前所有标签页' };
  }
  if (!task.url) {
    return { ok: false, error: 'missing_url', hint: '用 --url <地址> 指定要下载的地址（同源地址会自动带上登录态）' };
  }
  const guard = await ensureInjectable(tab);
  if (guard.error) { return guard.error; }

  const maxBytes = Number(task.maxBytes) > 0 ? Number(task.maxBytes) : DOWNLOAD_MAX_BYTES;
  const picked = await injectAndPick(
    tab.id,
    fetchInPage,
    [task.url, maxBytes, task.headers || null],
    (r, frameId) => (r ? (frameId === 0 ? 1 : 0) : -1)
  );
  if (picked.error) { return { ...picked.error, url: tab.url }; }

  const data = picked.data || {};
  if (data.error) {
    return { ok: false, error: data.error, bytes: data.bytes || null, url: task.url, tabId: tab.id };
  }
  return {
    ok: true,
    data: {
      tabId: tab.id,
      pageUrl: tab.url,
      url: task.url,
      filename: filenameFromDisposition(data.disposition) || filenameFromUrl(task.url),
      contentType: data.contentType || null,
      bytes: data.bytes,
      base64: data.base64
    }
  };
}

const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

function filenameFromDisposition(disposition) {
  if (!disposition) { return null; }
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star && star[1]) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch (e) { /* 忽略 */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain && plain[1] ? plain[1].trim() : null;
}

function filenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const name = path.split('/').filter(Boolean).pop();
    return name || 'download.bin';
  } catch (e) {
    return 'download.bin';
  }
}

const MEDIA_SUBDIR = 'videos';

function withMediaSubdir(name) {
  const n = String(name || '').trim();
  if (!n) { return MEDIA_SUBDIR + '/download.bin'; }
  if (n.includes('/') || n.includes('\\')) { return n; }
  return MEDIA_SUBDIR + '/' + n;
}
