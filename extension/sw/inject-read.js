/**
 * Agent Browser Bridge —— 页面内读取类注入函数。
 *
 * extractInPage 按选择器/正文容器提取内容；linksInPage 枚举链接；
 * markdownInPage 把元素转 Markdown；rectInPage 量元素在页面坐标里的矩形；
 * diagInPage 上报框架自身的可编辑性与结构信息。
 *
 * 本文件只放注入函数：Chrome 会把这些函数序列化后送进页面执行，
 * 因此每个函数都必须自包含——不能引用模块里的任何东西。这条规则由
 * tools/check-inject-scope.js 静态把关。
 */

export function extractInPage(selector, includeLinks, returnHtml) {
  const pick = () => {
    if (selector) {
      const el = document.querySelector(selector);
      if (el) { return { el, used: selector }; }
    }
    // 依次回退到常见正文容器，最后兜底 body
    const candidates = [
      ['#main-content', '#main-content'],          // Confluence
      ['.wiki-content', '.wiki-content'],          // Confluence 旧版正文
      ['#content', '#content'],
      ['main', 'main'],
      ['article', 'article']
    ];
    for (const [sel, label] of candidates) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').trim().length > 0) {
        return { el, used: label };
      }
    }
    return { el: document.body, used: 'body' };
  };

  const { el, used } = pick();

  // 表单控件的值不在 innerText 里，必须单独取，否则读输入框永远为空
  const tag = el.tagName;
  const isFormControl = tag === 'INPUT' || tag === 'TEXTAREA';
  let text;

  if (isFormControl) {
    text = el.value == null ? '' : String(el.value);
  } else if (tag === 'SELECT') {
    const opt = el.options[el.selectedIndex];
    text = opt ? opt.text : '';
  } else {
    // 必须读取仍在文档中的元素：innerText 依赖渲染结果，脱离文档的克隆体会退化成
    // textContent，导致换行全部丢失。innerText 本身已排除 script/style 等不渲染内容，
    // 因此不需要预先克隆剔除。
    text = el.innerText || '';

    // 元素不可见等情况下 innerText 可能拿不到换行，退回按块级元素逐行拼接
    if (text && !text.includes('\n')) {
      const lines = [];
      el.querySelectorAll('p, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote').forEach((n) => {
        const t = (n.innerText || n.textContent || '').trim();
        if (t) { lines.push(t); }
      });
      if (lines.length > 1) { text = lines.join('\n'); }
    }
  }

  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let links = [];
  if (includeLinks) {
    links = Array.from(el.querySelectorAll('a[href]'))
      .map((a) => ({ text: (a.innerText || '').trim(), href: a.href }))
      .filter((l) => l.href && !l.href.startsWith('javascript:'));
  }

  const bodyEl = document.body;
  const frameEditable = !!bodyEl && (
    bodyEl.isContentEditable
    || document.designMode === 'on'
    || !!document.querySelector('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]')
  );

  const result = {
    title: document.title,
    url: location.href,
    usedSelector: used,
    // 供多框架注入时挑选结果
    isMainFrame: (function () { try { return window === window.top; } catch (e) { return false; } })(),
    selectorMatched: !!(selector && document.querySelector(selector)),
    // 编辑态下正文在编辑器框架里，主框架只剩工具栏，据此区分
    frameEditable,
    text,
    charCount: text.length,
    links
  };

  // 需要定位元素（例如找编辑器选择器）时，附上结构信息
  if (returnHtml) {
    const MAX = 200000;
    const html = el.outerHTML || '';
    result.html = html.length > MAX ? html.slice(0, MAX) : html;
    result.htmlTruncated = html.length > MAX;

    result.contentEditables = [];

    // TinyMCE 等老式富文本编辑器用 designMode='on' 让整个文档可编辑，
    // 此时 body 上没有 contenteditable 属性，必须单独识别，否则会误判为"无编辑器"。
    if (document.designMode === 'on' && document.body) {
      const r = document.body.getBoundingClientRect();
      result.contentEditables.push({
        index: 0,
        tag: 'body',
        id: document.body.id || '',
        className: (typeof document.body.className === 'string' ? document.body.className : '').slice(0, 120),
        ariaLabel: document.body.getAttribute('aria-label') || '',
        dataTestId: document.body.getAttribute('data-testid') || '',
        visible: r.width > 0 && r.height > 0,
        textLength: (document.body.innerText || '').length,
        designMode: true
      });
    }

    Array.from(document.querySelectorAll(
      '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    )).slice(0, 50).forEach((n) => {
      const r = n.getBoundingClientRect();
      result.contentEditables.push({
        index: result.contentEditables.length,
        tag: n.tagName.toLowerCase(),
        id: n.id || '',
        className: (typeof n.className === 'string' ? n.className : '').slice(0, 120),
        ariaLabel: n.getAttribute('aria-label') || '',
        dataTestId: n.getAttribute('data-testid') || '',
        visible: r.width > 0 && r.height > 0,
        textLength: (n.innerText || '').length,
        designMode: false
      });
    });
  }

  return result;
}

export function linksInPage(selector, filterText) {
  const scope = selector ? document.querySelector(selector) : document;
  if (!scope) {
    return { links: [], usedSelector: null, error: 'selector_not_found' };
  }

  const out = [];
  scope.querySelectorAll('a[href]').forEach((a) => {
    const r = a.getBoundingClientRect();
    const st = window.getComputedStyle(a);
    const isVisible = r.width > 0 && r.height > 0
      && st.visibility !== 'hidden' && st.display !== 'none';
    const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) { return; }
    if (filterText && !text.includes(filterText)) { return; }
    out.push({ index: out.length, text: text.slice(0, 200), href: a.href, visible: isVisible });
  });

  return {
    links: out,
    usedSelector: selector || 'document',
    isMainFrame: (function () { try { return window === window.top; } catch (e) { return false; } })(),
    // 供多框架注入时挑选结果：指定了选择器且走到这里，说明该框架命中了。
    // 少了这个字段，调用方的框架打分里那档"命中加权"永远不生效，多个框架都命中时
    // 只能退回第一个框架，iframe 内的链接就再也找不到。
    selectorMatched: !!selector,
    href: location.href
  };
}

export function markdownInPage(el) {
  if (!el) { return { ok: false, error: 'element_not_found' }; }

  const inline = (node) => {
    if (node.nodeType === 3) { return node.textContent; }
    if (node.nodeType !== 1) { return ''; }
    const tag = node.tagName.toLowerCase();
    if (tag === 'code') { return '`' + node.textContent + '`'; }
    if (tag === 'strong' || tag === 'b') { return '**' + Array.from(node.childNodes).map(inline).join('') + '**'; }
    if (tag === 'em' || tag === 'i') { return '*' + Array.from(node.childNodes).map(inline).join('') + '*'; }
    if (tag === 'a') {
      const text = Array.from(node.childNodes).map(inline).join('');
      const href = node.getAttribute('href') || '';
      return '[' + text + '](' + href + ')';
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      return '![' + alt + '](' + src + ')';
    }
    if (tag === 'br') { return '\n'; }
    return Array.from(node.childNodes).map(inline).join('');
  };

  const blocks = (node, depth) => {
    const lines = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.trim();
        if (text) { lines.push(text); }
        continue;
      }
      if (child.nodeType !== 1) { continue; }
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        lines.push('#'.repeat(level) + ' ' + inline(child).trim());
      } else if (tag === 'p') {
        lines.push(inline(child).trim());
      } else if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(child.children).filter((li) => li.tagName.toLowerCase() === 'li');
        items.forEach((li, i) => {
          const marker = tag === 'ol' ? (i + 1) + '.' : '-';
          lines.push('  '.repeat(depth) + marker + ' ' + inline(li).trim());
        });
      } else if (tag === 'blockquote') {
        const inner = blocks(child, depth).join('\n');
        lines.push(inner.split('\n').map((l) => '> ' + l).join('\n'));
      } else if (tag === 'pre') {
        lines.push('```');
        lines.push(child.textContent);
        lines.push('```');
      } else if (tag === 'table') {
        const rows = Array.from(child.querySelectorAll('tr'));
        rows.forEach((row, ri) => {
          const cells = Array.from(row.querySelectorAll('th,td')).map((c) => inline(c).trim());
          lines.push('| ' + cells.join(' | ') + ' |');
          if (ri === 0) { lines.push('| ' + cells.map(() => '---').join(' | ') + ' |'); }
        });
      } else {
        const text = inline(child).trim();
        if (text) { lines.push(text); }
      }
    }
    return lines;
  };

  const markdown = blocks(el, 0).join('\n\n').trim();
  return { ok: true, markdown, charCount: markdown.length };
}

export function rectInPage(selector) {
  const el = document.querySelector(selector);
  if (!el) { return null; }
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) { return null; }
  return {
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    width: r.width,
    height: r.height,
    scale: 1
  };
}

export function diagInPage() {
  const CE_SEL = '[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]';
  const body = document.body;

  return {
    isMainFrame: (function () { try { return window === window.top; } catch (e) { return false; } })(),
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    designMode: document.designMode || 'off',
    bodyExists: !!body,
    bodyIsContentEditable: body ? body.isContentEditable : null,
    bodyCEAttr: body ? body.getAttribute('contenteditable') : null,
    bodyEditableByDesignMode: !!body && document.designMode === 'on',
    editableAttrCount: document.querySelectorAll(CE_SEL).length,
    textboxRoleCount: document.querySelectorAll('[role="textbox"]').length,
    inputCount: document.querySelectorAll('input, textarea').length,
    iframeCount: document.querySelectorAll('iframe').length,
    bodyTextLength: body ? (body.innerText || '').length : 0,
    activeElement: document.activeElement ? document.activeElement.tagName.toLowerCase() : null
  };
}
