/**
 * Agent Browser Bridge —— 媒体类注入函数：枚举页面媒体候选、页面内带 Referer 的 fetch。
 *
 * 本文件只放注入函数：Chrome 会把这些函数序列化后送进页面执行，
 * 因此每个函数都必须自包含——不能引用模块里的任何东西。这条规则由
 * tools/check-inject-scope.js 静态把关。
 */

export function mediaInPage(opts) {
  const MIN_IMG = (opts && opts.minImageSize) || 200;   // 过滤图标等小图
  const MAX_SCAN = (opts && opts.maxScanChars) || 3000000;

  const videos = [];
  const audios = [];
  const images = [];
  const streams = [];

  const abs = (u) => {
    if (!u) { return null; }
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  };

  // ---- 媒体元素 ----
  document.querySelectorAll('video').forEach((v) => {
    const src = abs(v.currentSrc || v.src);
    if (src && !src.startsWith('blob:')) {
      videos.push({
        src,
        w: v.videoWidth || null,
        h: v.videoHeight || null,
        duration: isFinite(v.duration) ? Math.round(v.duration) : null,
        poster: abs(v.poster)
      });
    } else if (src && src.startsWith('blob:')) {
      videos.push({ src, blob: true, note: 'MSE/blob 源，需从页面数据里找真实清单' });
    }
    v.querySelectorAll('source').forEach((s) => {
      const u = abs(s.src);
      if (u && !u.startsWith('blob:')) {
        videos.push({ src: u, from: 'source', type: s.type || null });
      }
    });
  });

  document.querySelectorAll('audio').forEach((a) => {
    const src = abs(a.currentSrc || a.src);
    if (src && !src.startsWith('blob:')) { audios.push({ src }); }
  });

  // ---- 图片（按实际渲染尺寸过滤，避免把 UI 图标当内容）----
  document.querySelectorAll('img').forEach((i) => {
    const src = abs(i.currentSrc || i.src);
    if (!src || src.startsWith('data:')) { return; }
    if ((i.naturalWidth || 0) >= MIN_IMG && (i.naturalHeight || 0) >= MIN_IMG) {
      images.push({ src, w: i.naturalWidth, h: i.naturalHeight, alt: (i.alt || '').slice(0, 80) });
    }
  });

  // ---- 页面数据里的播放清单（HLS/DASH 等）----
  // 用字符串化 + 正则，避免对大对象做深度递归（实测会超时）。
  let text = '';
  document.querySelectorAll('script').forEach((s) => {
    if (text.length >= MAX_SCAN) { return; }
    const t = s.textContent || '';
    if (/\.(m3u8|mpd)/i.test(t) || /playAddr|play_url|video_url|backupUrl/i.test(t)) {
      text += t.slice(0, 500000);
    }
  });
  if (document.body && text.length < MAX_SCAN) {
    const pageData = document.getElementById('RENDER_DATA');
    if (pageData && pageData.textContent) { text += pageData.textContent.slice(0, 1500000); }
  }

  if (text) {
    const re = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm|m4s|flv)(?:[?#][^\s"'<>\\]*)?/gi;
    const seen = new Set();
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard < 50000) {
      const u = m[0].replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
      const key = u.slice(0, 200);
      if (!seen.has(key)) { seen.add(key); streams.push({ src: u, from: 'page-data' }); }
      guard++;
    }
  }

  // ---- 去重合并 ----
  const dedupe = (arr, keyName) => {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      const k = item[keyName].slice(0, 300);
      if (seen.has(k)) { continue; }
      seen.add(k);
      out.push(item);
    }
    return out;
  };

  return {
    url: location.href,
    title: document.title,
    counts: { videos: videos.length, streams: streams.length, images: images.length, audios: audios.length },
    videos: dedupe(videos, 'src').slice(0, 30),
    streams: dedupe(streams, 'src').slice(0, 40),
    images: dedupe(images, 'src').slice(0, 60),
    audios: dedupe(audios, 'src').slice(0, 20)
  };
}

export function fetchInPage(url, maxBytes, headers) {
  return fetch(url, { credentials: 'include', redirect: 'follow', headers: headers || undefined })
    .then(function (res) {
      if (!res.ok) { return { error: 'http_' + res.status }; }
      return res.arrayBuffer().then(function (buf) {
        const bytes = new Uint8Array(buf);
        if (bytes.length > maxBytes) { return { error: 'too_large', bytes: bytes.length }; }
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return {
          base64: btoa(bin),
          bytes: bytes.length,
          contentType: res.headers.get('content-type'),
          disposition: res.headers.get('content-disposition')
        };
      });
    })
    .catch(function (e) { return { error: String(e && e.message ? e.message : e) }; });
}
