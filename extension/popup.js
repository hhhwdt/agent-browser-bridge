/**
 * Agent Browser Bridge —— 扩展弹窗。
 *
 * 用途：
 *   1. 显示本机桥接服务是否在线。
 *   2. 管理允许读取的站点授权。
 *
 * 说明：浏览器要求站点授权必须由用户手势触发，因此授权只能在这个弹窗里由用户
 * 手动完成，后台服务脚本无法代为授权。
 *
 * 国际化：所有可见字符串都通过 chrome.i18n.getMessage 取自 _locales/，
 * HTML 里用 data-i18n / data-i18n-html 标记，JS 里直接调 getMessage。
 * 缺 key 时 getMessage 返回空字符串——弹窗上表现为一片空白，不报错。
 * test/test-i18n-keys.js 钉住每个用过的 key 在两个 locale 文件里都存在。
 */

const BRIDGE_URL = 'http://127.0.0.1:18777';

// 清单里硬编码授权的条目（本机桥接地址），始终生效，且不参与"撤销全部"
const DEFAULT_ORIGINS = [
  'http://127.0.0.1:18777/*',
  'http://localhost:18777/*'
];

// 高级能力所需的可选权限。默认不授予，避免安装时索取过宽权限。
//
// 注意：只列清单里真正声明为 optional_permissions 的权限。
// Chrome 禁止 debugger 作为可选权限（"Permission 'debugger' cannot be listed
// as optional"），它只能是必需权限，因此不在这里申请——请求未声明的权限会抛
// "Only permissions specified in the manifest may be requested"。
const ADV_PERMISSIONS = ['cookies'];
// 值是 i18n key，不是显示文本
const ADV_LABELS = {
  cookies: 'permCookies'
};

const bridgeDot = document.getElementById('bridgeDot');
const bridgeStatus = document.getElementById('bridgeStatus');
const originList = document.getElementById('originList');
const originInput = document.getElementById('originInput');
const advList = document.getElementById('advList');
const tokenInput = document.getElementById('tokenInput');
const tokenHint = document.getElementById('tokenHint');

/** 把 HTML 里 data-i18n / data-i18n-html 标记的元素填上本地化文本。 */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = chrome.i18n.getMessage(el.getAttribute('data-i18n-html'));
  });
  document.documentElement.lang = chrome.i18n.getUILanguage();
  originInput.placeholder = chrome.i18n.getMessage('originPlaceholder');
  tokenInput.placeholder = chrome.i18n.getMessage('tokenPlaceholder');
}

/** 从 chrome.storage.local 读取已保存的 token 并显示。 */
async function refreshToken() {
  try {
    const stored = await chrome.storage.local.get('abb-token');
    const token = stored && stored['abb-token'];
    if (token) {
      tokenInput.value = token;
      tokenHint.textContent = chrome.i18n.getMessage('tokenHintSaved');
      tokenHint.style.color = '#1a7f37';
    }
  } catch (e) { /* 忽略 */ }
}

/** 保存 token 到 chrome.storage.local。 */
document.getElementById('tokenSaveBtn').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    tokenHint.textContent = chrome.i18n.getMessage('tokenHintEmpty');
    tokenHint.style.color = '#cf222e';
    return;
  }
  try {
    await chrome.storage.local.set({ 'abb-token': token });
    tokenHint.textContent = chrome.i18n.getMessage('tokenHintSaved');
    tokenHint.style.color = '#1a7f37';
  } catch (e) {
    tokenHint.textContent = chrome.i18n.getMessage('tokenHintError');
    tokenHint.style.color = '#cf222e';
  }
});

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
      bridgeStatus.textContent = chrome.i18n.getMessage('statusOnline');
    } else {
      bridgeDot.className = 'dot bad';
      bridgeStatus.textContent = chrome.i18n.getMessage('statusOnlineNoExt');
    }
  } catch (e) {
    bridgeDot.className = 'dot bad';
    bridgeStatus.textContent = chrome.i18n.getMessage('statusOffline');
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
    addItem(chrome.i18n.getMessage('noOrigins'));
    addItem(chrome.i18n.getMessage('noOriginsHint'));
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
    const key = ADV_LABELS[p] || p;
    li.textContent = (has ? '✓ ' : '✗ ') + chrome.i18n.getMessage(key);
    li.style.color = has ? '#1a7f37' : '#656d76';
    advList.appendChild(li);
  }
}

document.getElementById('grantAdvBtn').addEventListener('click', async () => {
  const ok = await chrome.permissions.request({ permissions: ADV_PERMISSIONS });
  if (!ok) {
    alert(chrome.i18n.getMessage('alertNotGranted'));
  }
  await refreshAdvancedPermissions();
});

document.getElementById('revokeAdvBtn').addEventListener('click', async () => {
  await chrome.permissions.remove({ permissions: ADV_PERMISSIONS });
  await refreshAdvancedPermissions();
});

async function grant(pattern) {
  if (!pattern) {
    alert(chrome.i18n.getMessage('alertInvalidOrigin'));
    return;
  }
  const ok = await chrome.permissions.request({ origins: [pattern] });
  if (ok) {
    await refreshOrigins();
  } else {
    alert(chrome.i18n.getMessage('alertNotGranted'));
  }
}

document.getElementById('grantBtn').addEventListener('click', async () => {
  const pattern = toOriginPattern(originInput.value);
  await grant(pattern);
  originInput.value = '';
});

document.getElementById('grantAllBtn').addEventListener('click', async () => {
  if (!confirm(chrome.i18n.getMessage('confirmGrantAll'))) { return; }
  await grant('*://*/*');
});

document.getElementById('revokeAllBtn').addEventListener('click', async () => {
  if (!confirm(chrome.i18n.getMessage('confirmRevokeAll'))) { return; }
  const granted = await chrome.permissions.getAll();
  const origins = (granted.origins || []).filter((o) => !DEFAULT_ORIGINS.includes(o));
  if (origins.length === 0) {
    alert(chrome.i18n.getMessage('alertNothingToRevoke'));
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
const extIdEl = document.getElementById('extId');

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
    markSummary.textContent = chrome.i18n.getMessage('statusReadFailed');
    return;
  }
  markSummary.textContent = r.markedCount > 0
    ? chrome.i18n.getMessage('marksCount', String(r.markedCount))
    : chrome.i18n.getMessage('noMarks');
}

document.getElementById('clearMarksBtn').addEventListener('click', async () => {
  const r = await sendToBackground('clearMarks');
  if (!r.ok) {
    alert(chrome.i18n.getMessage('alertClearFailed', r.error || 'unknown'));
    return;
  }
  await refreshMarks();
});

/** 显示扩展 ID：服务端按 ID 放行，对不上时这串就是 --allow-extension 要的值。 */
function refreshExtensionId() {
  try {
    extIdEl.textContent = chrome.runtime.id;
  } catch (e) {
    extIdEl.textContent = chrome.i18n.getMessage('readFailed');
  }
}

applyI18n();
refreshBridgeStatus();
refreshExtensionId();
refreshOrigins();
refreshMarks();
refreshAdvancedPermissions();
refreshToken();
setInterval(refreshBridgeStatus, 2000);
