/**
 * Agent Browser Bridge —— 扩展弹窗。
 *
 * 用途：
 *   1. 显示本机桥接服务是否在线。
 *   2. 管理允许读取的站点授权。
 *
 * 说明：浏览器要求站点授权必须由用户手势触发，因此授权只能在这个弹窗里由用户
 * 手动完成，后台服务脚本无法代为授权。
 */

const BRIDGE_URL = 'http://127.0.0.1:18777';

// 清单里硬编码授权的条目（本机桥接地址），始终生效，且不参与"撤销全部"
const DEFAULT_ORIGINS = [
  'http://127.0.0.1:18777/*',
  'http://localhost:18777/*'
];

// 高级能力所需的可选权限。默认不授予，避免安装时索取过宽权限。
const ADV_PERMISSIONS = ['debugger', 'cookies'];
const ADV_LABELS = {
  debugger: 'debugger — 元素/整页截图、向文件选择框填入本地文件',
  cookies: 'cookies — 读取站点登录 Cookie'
};

const bridgeDot = document.getElementById('bridgeDot');
const bridgeStatus = document.getElementById('bridgeStatus');
const originList = document.getElementById('originList');
const originInput = document.getElementById('originInput');
const advList = document.getElementById('advList');

/** 规范化用户输入的站点，返回可授权的 origin 模式。 */
function toOriginPattern(raw) {
  let v = String(raw || '').trim();
  if (!v) { return null; }

  // 允许直接粘贴完整 URL
  if (!v.includes('://')) {
    v = 'https://' + v;
  }

  let origin;
  try {
    origin = new URL(v).origin;
  } catch (e) {
    return null;
  }
  if (origin === 'null') { return null; }
  return origin + '/*';
}

async function refreshBridgeStatus() {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000)
    });
    const data = await res.json();
    if (data && data.extensionConnected) {
      bridgeDot.className = 'dot ok';
      bridgeStatus.textContent = '桥接服务在线，扩展已连接';
    } else {
      bridgeDot.className = 'dot bad';
      bridgeStatus.textContent = '桥接服务在线，但扩展未连接';
    }
  } catch (e) {
    bridgeDot.className = 'dot bad';
    bridgeStatus.textContent = '桥接服务未启动（需要运行 start-server.ps1）';
  }
}

async function refreshOrigins() {
  const granted = await chrome.permissions.getAll();
  const origins = (granted.origins || []).filter((o) => !DEFAULT_ORIGINS.includes(o));

  originList.innerHTML = '';
  const addItem = (text) => {
    const li = document.createElement('li');
    li.textContent = text;
    originList.appendChild(li);
  };

  if (origins.length === 0) {
    addItem('尚未授权任何站点');
    addItem('读取网页前需先在下方为对应站点授权');
  } else {
    origins.forEach(addItem);
  }
}

/* ------------------------------------------------------------------ *
 * 高级能力权限
 * 浏览器要求权限请求必须由用户手势触发，所以只能在这个弹窗里完成，
 * 后台服务脚本无法代为申请。
 * ------------------------------------------------------------------ */

async function refreshAdvancedPermissions() {
  const granted = await chrome.permissions.getAll();
  const perms = granted.permissions || [];

  advList.innerHTML = '';
  for (const p of ADV_PERMISSIONS) {
    const li = document.createElement('li');
    const has = perms.includes(p);
    li.textContent = (has ? '✓ ' : '✗ ') + (ADV_LABELS[p] || p);
    li.style.color = has ? '#1a7f37' : '#656d76';
    advList.appendChild(li);
  }
}

document.getElementById('grantAdvBtn').addEventListener('click', async () => {
  const ok = await chrome.permissions.request({ permissions: ADV_PERMISSIONS });
  if (!ok) {
    alert('未获得授权。');
  }
  await refreshAdvancedPermissions();
});

document.getElementById('revokeAdvBtn').addEventListener('click', async () => {
  await chrome.permissions.remove({ permissions: ADV_PERMISSIONS });
  await refreshAdvancedPermissions();
});

async function grant(pattern) {
  if (!pattern) {
    alert('请输入有效的站点，例如 confluence.example.com');
    return;
  }
  const ok = await chrome.permissions.request({ origins: [pattern] });
  if (ok) {
    await refreshOrigins();
  } else {
    alert('未获得授权');
  }
}

document.getElementById('grantBtn').addEventListener('click', async () => {
  const pattern = toOriginPattern(originInput.value);
  await grant(pattern);
  originInput.value = '';
});

document.getElementById('grantAllBtn').addEventListener('click', async () => {
  if (!confirm('将授权读取所有网站的页面内容，确认继续？')) { return; }
  await grant('*://*/*');
});

document.getElementById('revokeAllBtn').addEventListener('click', async () => {
  if (!confirm('将撤销所有可撤销的站点授权（清单中默认授权的站点不受影响），确认继续？')) { return; }
  const granted = await chrome.permissions.getAll();
  const origins = (granted.origins || []).filter((o) => !DEFAULT_ORIGINS.includes(o));
  if (origins.length === 0) {
    alert('没有可撤销的授权');
    return;
  }
  await chrome.permissions.remove({ origins });
  await refreshOrigins();
});

/* ------------------------------------------------------------------ *
 * 标签页标记
 * 清除走后台服务脚本，它在页面内还原标题与图标；弹窗本身不直接注入。
 * ------------------------------------------------------------------ */

const markSummary = document.getElementById('markSummary');

function sendToBackground(action) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'abb-popup', action }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: 'no_response' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

async function refreshMarks() {
  const r = await sendToBackground('status');
  if (!r.ok) {
    markSummary.textContent = '状态读取失败';
    return;
  }
  markSummary.textContent = r.markedCount > 0
    ? `已标记 ${r.markedCount} 个标签页`
    : '当前没有标记';
}

document.getElementById('clearMarksBtn').addEventListener('click', async () => {
  const r = await sendToBackground('clearMarks');
  if (!r.ok) {
    alert('清除失败：' + (r.error || '未知错误'));
    return;
  }
  await refreshMarks();
});

refreshBridgeStatus();
refreshOrigins();
refreshMarks();
refreshAdvancedPermissions();
setInterval(refreshBridgeStatus, 2000);
