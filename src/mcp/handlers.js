/**
 * 工具执行：把工具名映射到一次桥接调用。返回值直接作为工具结果。
 */

'use strict';

const { ab } = require('./bridge.js');
const { text, errorText } = require('./log.js');
const { tabTarget, pageTarget } = require('./tools.js');
const { ensureBridge } = require('./ensure.js');
const { BridgeError, BridgeUnavailableError } = require('../client.js');

/** 截图 base64 超过这个体积就不塞进上下文了，改为提示收窄截取范围。 */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;

const HANDLERS = {
  async browser_list_tabs(a) {
    const d = await ab.tabs({ browser: a.browser });
    return text(`${d.tabs.length} 个标签页：\n` + d.tabs.map((t) => {
      const flags = [t.active ? '激活' : '后台', t.discarded ? '已休眠' : null].filter(Boolean).join('/');
      return `[${t.id}] (${flags}) ${t.title}\n      ${t.url}`;
    }).join('\n'));
  },

  async browser_read_page(a) {
    const d = await ab.read({
      ...pageTarget(a),
      selector: a.selector,
      includeLinks: !!a.includeLinks,
      returnHtml: !!a.returnHtml,
      format: a.format,
      autoActivate: !!a.autoActivate,
      lease: !!a.lease
    });
    const head = `标题: ${d.title}\nURL: ${d.url}\n标签页: ${d.tabId}${d.wasActive ? '（激活）' : '（后台）'}`
      + `  框架: ${d.frameId}  正文容器: ${d.usedSelector}  字符数: ${d.charCount}`;
    const parts = [head, '---', d.text || '(空)'];
    if (Array.isArray(d.links) && d.links.length) {
      parts.push('--- 链接 ---', d.links.map((l) => `${l.text}  ->  ${l.href}`).join('\n'));
    }
    if (d.html) {
      parts.push(`--- HTML${d.htmlTruncated ? '（已截断）' : ''} ---`, d.html);
    }
    if (Array.isArray(d.contentEditables) && d.contentEditables.length) {
      parts.push('--- 可编辑区域 ---', d.contentEditables.map((c) => {
        const sel = [c.tag, c.id ? '#' + c.id : '', c.className ? '.' + c.className.split(/\s+/).join('.') : '']
          .join('').slice(0, 160);
        return `[${c.index}] ${sel}  ${c.ariaLabel || ''}  ${c.visible ? '可见' : '隐藏'}  ${c.textLength} 字`
          + `${c.designMode ? '  (designMode)' : ''}`;
      }).join('\n'));
    }
    return text(parts.join('\n'));
  },

  async browser_get_links(a) {
    const d = await ab.links({
      ...pageTarget(a),
      selector: a.selector,
      text: a.text
    });
    if (!d.links.length) { return text(`没有链接（容器: ${d.usedSelector}）。`); }
    return text(`${d.links.length} 个链接：\n` + d.links.map((l) =>
      `[${l.index}] ${l.visible ? ' ' : '隐'} ${l.text.slice(0, 120)}\n      ${l.href}`).join('\n'));
  },

  async browser_navigate(a) {
    const d = await ab.navigate({
      ...tabTarget(a),
      url: a.url,
      newTab: !!a.newTab,
      active: !!a.active,
      waitMs: a.waitMs
    });
    return text(`已导航: ${d.url}\n标签页: ${d.tabId}`
      + `${d.openedNewTab ? '（后台新建）' : d.wasActive ? '（当前激活）' : '（后台）'}`
      + `${d.redirected ? '\n（发生了重定向，上面是最终地址）' : ''}`
      + `${d.waitTimedOut ? '\n（等待地址变更超时，页面可能仍在加载）' : ''}`);
  },

  async browser_batch(a) {
    if (!Array.isArray(a.steps) || a.steps.length === 0) {
      return errorText('需要 steps 数组。');
    }
    const d = await ab.batch(a.steps, { continueOnError: a.continueOnError });
    const lines = (d.results || []).map((r) => {
      const mark = r.ok ? 'ok  ' : 'FAIL';
      return `  ${mark}  步骤 ${r.step}  ${r.action}  ${r.ok ? '' : r.error || ''}`;
    });
    return text(`批量执行完成（${(d.results || []).length} 步）:\n` + lines.join('\n'));
  },

  async browser_click(a) {
    const d = await ab.click({
      ...pageTarget(a),
      selector: a.selector,
      text: a.text,
      href: a.href,
      index: typeof a.index === 'number' ? a.index : 0,
      allowNonLink: !!a.force,
      dryRun: !!a.dryRun
    });
    if (d.dryRun) {
      const w = d.wouldClick || {};
      return text(`试运行（未点击）：匹配 ${d.matched} 个元素。\n`
        + `会点到: <${w.tag}> ${JSON.stringify(w.text || '')}`
        + `${w.href ? '\n链接: ' + w.href : ''}\n`
        + `是否链接: ${w.isLink}  按钮类: ${w.isButtonLike}  破坏性文案: ${w.destructive}\n`
        + `${w.blocked ? '不传 force 会被拦下。' : '不传 force 也会执行。'}`);
    }
    return text(`已点击: ${d.clicked.text}\n`
      + `${d.clicked.href ? '链接: ' + d.clicked.href + '\n' : ''}`
      + `标签页: ${d.tabId}${d.wasActive ? '（激活）' : '（后台）'}  框架: ${d.frameId}\n`
      + `跳转: ${d.navigated ? '是' : '否'}${d.urlAfter ? '  当前: ' + d.urlAfter : ''}`
      + `${d.openedTabs && d.openedTabs.length ? '\n新开标签页: ' + d.openedTabs.map((t) => `[${t.id}] ${t.url}`).join(' ') : ''}`);
  },

  async browser_type(a) {
    const d = await ab.type({
      ...pageTarget(a),
      selector: a.selector,
      text: a.text,
      value: a.value,
      method: a.method === 'html' ? 'html' : 'text',
      clear: !!a.clear,
      allowNonInput: !!a.force
    });
    return text(`已写入 <${d.tag}>（定位方式 ${d.how}，框架 ${d.frameId}）\n`
      + `字符数 ${d.beforeLength} -> ${d.afterLength}，execCommand: ${d.usedExecCommand ? '是' : '否'}\n`
      + `预览: ${d.preview}\n`
      + `注意：只写入了内容，没有提交。`);
  },

  async browser_press_key(a) {
    const d = await ab.key({
      ...pageTarget(a),
      key: a.key,
      selector: a.selector,
      ctrl: !!a.ctrl,
      shift: !!a.shift,
      alt: !!a.alt,
      meta: !!a.meta
    });
    return text(`已派发 ${d.key}（keyCode ${d.keyCode}）到 <${d.target}>，框架 ${d.frameId}。\n`
      + `页面是否取消该事件: ${d.notCancelled ? '否' : '是'}`);
  },

  async browser_wait_for(a) {
    if (!a.selector && !a.text && !a.url && !a.idleMs) {
      return errorText('需要 selector、text、url 或 idleMs 之一作为等待条件。');
    }
    const d = await ab.wait({
      ...pageTarget(a),
      selector: a.selector,
      text: a.text,
      url: a.url,
      count: a.count,
      idleMs: a.idleMs,
      state: a.state === 'disappear' ? 'disappear' : 'appear',
      timeoutMs: a.timeoutMs
    });
    return text(`条件已成立（等待 ${d.elapsedMs}ms，标签页 ${d.tabId}，框架 ${d.frameId}）。`);
  },

  async browser_screenshot(a) {
    const d = await ab.screenshot({
      ...pageTarget(a),
      selector: a.selector,
      full: !!a.full,
      format: a.format
    });
    const meta = `标签页 ${d.tabId}  ${d.width || '?'}x${d.height || '?'}  ${d.format}  方式 ${d.via}`
      + `${d.selector ? '  元素 ' + d.selector : ''}${d.fullPage ? '  整页' : ''}`;
    const base64 = String(d.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    if (!base64) { return text(meta + '\n（没有拿到图像数据）'); }
    if (base64.length > IMAGE_MAX_BYTES) {
      return text(`${meta}\n图像约 ${(base64.length / 1024 / 1024).toFixed(1)}MB，太大，未返回。`
        + '请改用 selector 只截需要的元素，或 full=false 只截可视区域。');
    }
    return {
      content: [
        { type: 'text', text: meta },
        { type: 'image', data: base64, mimeType: d.format === 'jpeg' ? 'image/jpeg' : 'image/png' }
      ]
    };
  },

  async browser_eval(a) {
    const d = await ab.evalPage({ ...pageTarget(a), code: a.code });
    if (d.truncated) {
      return text(`结果过大已截断（框架 ${d.frameId}）：\n${d.json}`);
    }
    const v = d.value;
    return text(`框架 ${d.frameId}  标签页 ${d.tabId}:\n`
      + (typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
  },

  async browser_frames(a) {
    const d = await ab.frames({ ...tabTarget(a) });
    if (!d.frames.length) { return text('没有取到任何框架。'); }
    return text(`${d.title}\n${d.url}\n共 ${d.frameCount} 个框架：\n` + d.frames.map((f) => {
      if (!f.info) { return `[frameId=${f.frameId}] 注入失败: ${f.error}`; }
      const i = f.info;
      return `[frameId=${f.frameId}] ${i.isMainFrame ? '主框架' : '子框架'}  ${i.title}\n`
        + `    ${i.href}\n`
        + `    designMode=${i.designMode}  body可编辑=${i.bodyIsContentEditable}`
        + `${i.bodyEditableByDesignMode ? '（designMode）' : ''}`
        + `  contenteditable元素=${i.editableAttrCount}  role=textbox=${i.textboxRoleCount}  输入框=${i.inputCount}\n`
        + `    正文长度=${i.bodyTextLength}  子框架=${i.iframeCount}`;
    }).join('\n'));
  },

  async browser_save_file(a) {
    // 下载被中断时桥接返回 ok:false + error:interrupted，会由 callTool 的
    // BridgeError 分支统一翻译，这里只处理成功的返回。
    const d = await ab.save({
      ...tabTarget(a),
      url: a.url,
      filename: a.filename,
      overwrite: !!a.overwrite,
      waitMs: a.waitMs
    });
    return text(`已保存: ${d.filename || '(等待中)'}\n`
      + `来源: ${d.url}\n状态: ${d.done ? '已完成' : d.state}`
      + `${d.bytes ? `  大小 ${(d.bytes / 1024).toFixed(1)} KB` : ''}`);
  },

  async browser_upload_file(a) {
    const d = await ab.upload({
      ...tabTarget(a),
      selector: a.selector,
      files: a.files
    });
    return text(`已选择文件: ${(d.files || []).join(', ')}\n填入 ${d.selector}（标签页 ${d.tabId}）\n`
      + `注意：只是选择了文件，提交表单仍需另外点击。`);
  },

  async browser_session(a) {
    const d = await ab.session({
      ...tabTarget(a),
      name: a.name,
      key: a.key,
      storage: a.storage
    });
    const parts = [`标签页 ${d.tabId}  ${d.url}`];
    if (d.cookies) {
      parts.push(`--- Cookie（${d.cookies.length} 个）---`);
      parts.push(d.cookies.map((c) => `${c.name} = ${c.value}${c.httpOnly ? '  [httpOnly]' : ''}`
        + `${c.domain ? '  @' + c.domain : ''}`).join('\n'));
    }
    if (d.storage) {
      for (const name of ['localStorage', 'sessionStorage']) {
        const store = d.storage[name];
        if (!store) { continue; }
        const keys = Object.keys(store);
        parts.push(`--- ${name}（${keys.length} 项）---`);
        parts.push(keys.map((k) => `${k} = ${String(store[k]).slice(0, 300)}`).join('\n'));
      }
    }
    if (d.cookiesError) { parts.push(`Cookie 读取失败: ${d.cookiesError}`); }
    if (d.storageError) { parts.push(`本地存储读取失败: ${d.storageError}`); }
    return text(parts.join('\n'));
  },

  async browser_close_tab(a) {
    const d = await ab.close({ tabId: a.tabId });
    return text(`已关闭: ${d.closedTitle}\n原地址: ${d.closedUrl}`);
  },

  async browser_clear_marks() {
    const d = await ab.unmark({});
    const per = (d.browsers || []).map((b) => `${b.browser}: ${b.ok ? '已清理 ' + b.cleared.length + ' 个' : '失败 ' + b.error}`);
    return text(`已清除标记 ${d.cleared.length} 个标签页: ${d.cleared.join(', ') || '（无）'}`
      + (per.length ? '\n' + per.join('\n') : ''));
  },

  async browser_status() {
    const h = await ab.health();
    const lines = [
      `桥接服务: 在线（apiVersion ${h.apiVersion}）`,
      `在线的浏览器: ${(h.browsers || []).join(', ') || '（无）'}`,
      `扩展连接: ${h.extensionConnected ? '是' : '否'}`,
      `待下发任务: ${h.pendingTasks}   队列: ${h.queuedTasks}`,
      `允许的扩展 id: ${(h.allowedExtensionIds || []).join(', ') || '（未上报）'}`
    ];
    try {
      const d = await ab.diag({});
      lines.push(`扩展版本: ${d.version}   扩展 id: ${d.extensionId || '（未上报）'}`);
      lines.push(`轮询循环: ${d.loopRunning ? '运行中' : '未运行'}`);
      lines.push(`已标记标签页: ${(d.markedTabs || []).length} 个`);
      lines.push(`错误条数: ${d.errorCount || 0}`);
      for (const e of (d.errors || []).slice(-5)) {
        lines.push(`  [${e.where}] ${String(e.msg).slice(0, 200)}`);
      }
    } catch (e) {
      lines.push(`扩展诊断读取失败: ${e.code || e.message}`);
    }
    return text(lines.join('\n'));
  },

  /* ---------------------------------------------------------------- *
   * computer 桌面控制（Windows 本地执行）。走 ab.computerXxx 动作族，
   * 错误翻译沿用 callTool 的 BridgeError 分支，这里只拼人话结果。
   * ---------------------------------------------------------------- */

  async computer_screen(a) {
    const d = await ab.computerScreen({
      windowTitle: a.windowTitle,
      hwnd: a.hwnd,
      region: a.region
    });
    const meta = `${d.mode === 'window' ? '窗口截图' : '桌面截图'}  ${d.width}x${d.height}  ${(d.bytes / 1024).toFixed(0)}KB`;
    const base64 = String(d.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    if (!base64) { return text(meta + '\n（没有拿到图像数据）'); }
    if (base64.length > IMAGE_MAX_BYTES) {
      return text(`${meta}\n图像约 ${(base64.length / 1024 / 1024).toFixed(1)}MB，太大，未返回。`
        + '请用 region 只截需要的区域，或 windowTitle 只截目标窗口。');
    }
    return {
      content: [
        { type: 'text', text: meta },
        { type: 'image', data: base64, mimeType: 'image/png' }
      ]
    };
  },

  async computer_ocr(a) {
    const d = await ab.computerOcr({
      windowTitle: a.windowTitle,
      hwnd: a.hwnd,
      index: a.index,
      region: a.region,
      language: a.language
    });
    if (!d.lines || d.lines.length === 0) {
      return text('没有识别到文字。可以先用 computer_screen 看一眼画面，或换 windowTitle/region 缩小范围。');
    }
    return text(`${d.lines.length} 行文字（坐标可直接给 computer_click）：\n`
      + d.lines.map((l) => `[${l.x},${l.y} ${l.w}x${l.h}] ${l.text}`).join('\n'));
  },

  async computer_find_image(a) {
    const d = await ab.computerFindImage({
      template: a.template,
      threshold: a.threshold,
      windowTitle: a.windowTitle,
      hwnd: a.hwnd,
      index: a.index,
      region: a.region
    });
    if (!d.found) {
      return text(`没找到（最高相似度 ${d.score}，阈值 ${d.threshold}）。`
        + '可以调低 threshold、换更小更独特的模板，或先用 computer_screen 确认界面没变。');
    }
    return text(`找到：中心 (${d.center.x}, ${d.center.y})，区域 ${d.w}x${d.h} 从 (${d.x}, ${d.y}) 起，相似度 ${d.score}。`);
  },

  async computer_diff(a) {
    const d = await ab.computerDiff({ before: a.before, after: a.after, threshold: a.threshold });
    if (d.sizeMismatch) { return text(d.note || '两张图尺寸不同，无法比较。'); }
    if (!d.changed) { return text('没有检测到变化。'); }
    return text(`有变化：占比 ${(d.ratio * 100).toFixed(2)}%，变化区域 (${d.box.x}, ${d.box.y}) ${d.box.w}x${d.box.h}。`);
  },

  async computer_windows() {
    const d = await ab.computerWindows();
    if (!d.windows.length) { return text('没有发现可见窗口。'); }
    return text(`${d.windows.length} 个窗口：\n` + d.windows.map((w) => {
      const flags = [
        w.minimized ? '最小化' : null,
        w.maximized ? '最大化' : null,
        w.visible ? null : '隐藏'
      ].filter(Boolean).join('/');
      return `[${w.index}] hwnd=${w.hwnd}  ${w.process}(pid ${w.pid})  ${flags ? `(${flags}) ` : ''}${w.title}\n`
        + `      ${w.bounds.x},${w.bounds.y} ${w.bounds.w}x${w.bounds.h}`;
    }).join('\n'));
  },

  async computer_window(a) {
    const d = await ab.computerWindow({ action: a.action, title: a.title, pid: a.pid, force: a.force });
    const names = { activate: '已到前台', minimize: '已最小化', maximize: '已最大化', close: '已请求关闭' };
    return text(`${names[a.action] || a.action}: ${d.title || d.hwnd}`);
  },

  async computer_click(a) {
    await ab.computerClick({ x: a.x, y: a.y, button: a.button, double: a.double });
    return text(`已在 (${a.x}, ${a.y})${a.button && a.button !== 'left' ? ' ' + a.button + '键' : ''}${a.double ? ' 双击' : ''}。`
      + '建议回头截图确认点对地方。');
  },

  async computer_move(a) {
    await ab.computerMove({ x: a.x, y: a.y });
    return text(`鼠标已移到 (${a.x}, ${a.y})。`);
  },

  async computer_drag(a) {
    await ab.computerDrag({ x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, steps: a.steps, stepMs: a.stepMs });
    return text(`已从 (${a.x1}, ${a.y1}) 拖到 (${a.x2}, ${a.y2})。`);
  },

  async computer_scroll(a) {
    await ab.computerScroll({ amount: a.amount, x: a.x, y: a.y });
    return text(`已滚动 ${a.amount || -3} 格${a.x != null ? `（位置 ${a.x}, ${a.y}）` : ''}。`);
  },

  async computer_type(a) {
    const d = await ab.computerType({ text: a.text });
    return text(`已键入 ${d.chars ? d.chars + ' 字符（发到当前焦点窗口）。' : '空文本，未发送。'}`);
  },

  async computer_key(a) {
    await ab.computerKey({ key: a.key });
    return text(`已派发按键 ${a.key}（发到当前焦点窗口）。`);
  },

  async computer_clipboard(a) {
    if (a.action === 'write') {
      await ab.computerClipboard({ action: 'write', text: a.text, force: a.force });
      return text('已写入剪贴板。');
    }
    const d = await ab.computerClipboard({ action: 'read' });
    const t = d.text == null ? '' : String(d.text);
    return text(`剪贴板（${d.length || 0} 字符${d.truncated ? '，已截断' : ''}）:\n${t.slice(0, 4000)}`);
  },

  async computer_shell(a) {
    const d = await ab.computerShell({ command: a.command, timeoutMs: a.timeoutMs, force: a.force });
    const lines = [
      `exit=${d.exitCode}  耗时 ${d.durationMs}ms  输出 ${(d.stdout || '').length} 字符`
    ];
    lines.push('---');
    lines.push(String(d.stdout || '').slice(0, 8000) || '（无输出）');
    return text(lines.join('\n'));
  },

  async computer_process(a) {
    if (a.mode === 'kill') {
      await ab.computerProcess({ mode: 'kill', pid: a.pid, force: a.force });
      return text(`已请求终止 pid=${a.pid}。`);
    }
    const d = await ab.computerProcess({ mode: 'list' });
    const rows = d.processes || [];
    // ConvertTo-Json 输出的键名大小写取决于 PowerShell 侧，两种形状都伺候
    return text(`${rows.length} 个进程：\n` + rows.map((p) => {
      const name = p.ProcessName || p.processName || '';
      const mem = p.memMb != null ? p.memMb : '?';
      return `${p.Id || p.id || p.pid}  ${name}  ${mem}MB`;
    }).join('\n'));
  },

  async computer_notify(a) {
    const d = await ab.computerNotify({ title: a.title, message: a.message });
    if (d.ok === false) {
      return text(`通知失败: ${d.error}${d.detail ? '  ' + d.detail : ''}`);
    }
    return text('已弹出 Windows 通知。');
  },

  async computer_media(a) {
    const d = await ab.computerMedia({ op: a.op, volume: a.volume });
    const parts = [];
    if (d.volumePercent != null) { parts.push(`音量 ${d.volumePercent}%`); }
    if (d.muted != null) { parts.push(d.muted ? '已静音' : '未静音'); }
    if (a.op && a.op !== 'get' && a.op !== 'volume') { parts.push(`已执行 ${a.op}`); }
    return text(parts.join('  ') || '完成。');
  },

  async computer_tree(a) {
    const d = await ab.computerTree({
      windowTitle: a.windowTitle,
      hwnd: a.hwnd,
      pid: a.pid,
      depth: a.depth,
      maxNodes: a.maxNodes,
      includeOffscreen: a.includeOffscreen,
      patterns: a.patterns
    });
    const nodes = d.nodes || [];
    const lines = [`窗口「${d.title || ''}」  ${d.count} 个控件`
      + `${d.truncated ? '（已截断，用 computer_find 缩小范围）' : ''}`];
    for (const n of nodes) {
      if (lines.length > 180) {
        lines.push('...（输出过长，剩余节点未列出）');
        break;
      }
      const flags = [];
      if (!n.enabled) { flags.push('disabled'); }
      if (n.offscreen) { flags.push('offscreen'); }
      if (n.focused) { flags.push('focused'); }
      const id = n.automationId ? ` id=${n.automationId}` : '';
      const b = n.bounds ? ` @${n.bounds.x},${n.bounds.y} ${n.bounds.w}x${n.bounds.h}` : '';
      const name = String(n.name || '').replace(/\s+/g, ' ').slice(0, 60);
      const pat = n.patterns && n.patterns.length ? ` [${n.patterns.join(',')}]` : '';
      lines.push(`${'  '.repeat(Math.min(n.depth, 12))}[${n.ref}] ${n.controlType} "${name}"${id}${b}${pat}`
        + (flags.length ? ` (${flags.join(',')})` : ''));
    }
    return text(lines.join('\n'));
  },

  async computer_find(a) {
    const d = await ab.computerFind({
      windowTitle: a.windowTitle,
      hwnd: a.hwnd,
      pid: a.pid,
      name: a.name,
      nameExact: a.nameExact,
      automationId: a.automationId,
      controlType: a.controlType,
      className: a.className,
      maxResults: a.maxResults,
      depth: a.depth,
      includeOffscreen: a.includeOffscreen,
      patterns: a.patterns
    });
    const rows = d.matches || [];
    if (rows.length === 0) {
      return text(`窗口「${d.title || ''}」里没有匹配的控件（扫描 ${d.visited} 个节点）。`);
    }
    const lines = [`窗口「${d.title || ''}」匹配 ${rows.length} 个`
      + `${d.truncated ? '（可能还有更多，用 depth/maxResults 调整）' : ''}`];
    for (const n of rows) {
      const id = n.automationId ? ` id=${n.automationId}` : '';
      const b = n.bounds ? ` @${n.bounds.x},${n.bounds.y} ${n.bounds.w}x${n.bounds.h}` : '';
      const name = String(n.name || '').replace(/\s+/g, ' ').slice(0, 80);
      const pat = n.patterns && n.patterns.length ? ` [${n.patterns.join(',')}]` : '';
      lines.push(`[${n.ref}] ${n.controlType} "${name}"${id}${b}${pat}`);
    }
    return text(lines.join('\n'));
  },

  async computer_act(a) {
    const d = await ab.computerAct({
      ref: a.ref,
      action: a.action,
      text: a.text,
      windowTitle: a.windowTitle,
      hwnd: a.hwnd,
      name: a.name,
      automationId: a.automationId,
      controlType: a.controlType,
      className: a.className,
      requestId: a.requestId
    });
    const parts = [`${d.action || a.action} 完成`, `ref=${d.ref || a.ref || '?'}`];
    if (d.method) { parts.push(`方式 ${d.method}`); }
    if (d.reResolved) { parts.push('原 ref 已失效，按选择器重新定位'); }
    if (d.state) { parts.push(`状态 ${d.state}`); }
    if (d.textChars !== undefined) { parts.push(`写入 ${d.textChars} 字符`); }
    if (d.value !== undefined) {
      const value = String(d.value);
      parts.push(`文本：${value.slice(0, 2000)}${value.length > 2000 ? '…' : ''}`);
    }
    return text(parts.join('  '));
  },

  async computer_wait_for(a) {
    const d = await ab.computerWaitFor({
      ref: a.ref,
      condition: a.condition,
      value: a.value,
      windowTitle: a.windowTitle,
      hwnd: a.hwnd,
      name: a.name,
      automationId: a.automationId,
      controlType: a.controlType,
      className: a.className,
      timeoutMs: a.timeoutMs,
      intervalMs: a.intervalMs
    });
    return text(`${d.condition} 已满足（${d.elapsedMs}ms）`
      + (d.ref ? `  ref=${d.ref}` : ''));
  },

  async computer_batch(a) {
    const d = await ab.computerBatch({
      ops: a.ops,
      waitMs: a.waitMs,
      stopOnError: a.stopOnError,
      requestId: a.requestId
    });
    const results = d.results || [];
    const okCount = results.filter((r) => r.ok).length;
    const lines = [`${results.length} 个动作，${okCount} 个成功`];
    results.forEach((r, i) => {
      if (r.skipped) {
        lines.push(`${i + 1}. ${r.action}  跳过`);
        return;
      }
      if (r.ok) {
        lines.push(`${i + 1}. ${r.action}  ok`);
        return;
      }
      lines.push(`${i + 1}. ${r.action}  失败: ${r.error || 'unknown'}`
        + (r.hint ? '  ' + r.hint : ''));
    });
    return text(lines.join('\n'));
  }
};

/** 调用工具，把桥接的错误码翻译成模型能照着做的提示。 */
async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) { return errorText(`未知工具: ${name}`); }

  try {
    return await handler(args || {});
  } catch (e) {
    if (e instanceof BridgeError) {
      return errorText(`${e.code}${e.detail && e.detail.hint ? ': ' + e.detail.hint : ''}\n`
        + JSON.stringify(e.detail, null, 2).slice(0, 1500));
    }
    if (e instanceof BridgeUnavailableError) {
      // 桥接可能在会话中途被关掉，这里给它一次重新起来的机会
      try {
        await ensureBridge();
        return await handler(args || {});
      } catch (e2) {
        return errorText(`桥接服务不可用: ${e2.message}`);
      }
    }
    return errorText(`执行失败: ${e && e.message ? e.message : String(e)}`);
  }
}

module.exports = { HANDLERS, callTool };
