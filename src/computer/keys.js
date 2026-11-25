/**
 * Agent Browser Bridge —— 键名到虚拟键码的解析。
 *
 * computerKey 的输入是键名串（"Ctrl+C"、"Enter"、"Win+D"），平台侧全靠这一处
 * 映射翻译。白名单制：名单外的键名直接报错，不给 SendInput 喂垃圾。
 */

'use strict';

/** 名称 → Virtual-Key code（winuser.h）。每个别名一行，方便核对。 */
const KEY_NAMES = {
    // 字母与数字（仅作为组合键成员出现；纯文本输入走 computer_type）
    a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
    i: 0x49, j: 0x4A, k: 0x4B, l: 0x4C, m: 0x4D, n: 0x4E, o: 0x4F, p: 0x50,
    q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
    y: 0x59, z: 0x5A,
    '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
    '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
    // 常用导航与功能键
    enter: 0x0D, return: 0x0D,
    tab: 0x09, escape: 0x1B, esc: 0x1B,
    space: 0x20, backspace: 0x08, bksp: 0x08,
    delete: 0x2E, del: 0x2E, insert: 0x2D, ins: 0x2D,
    home: 0x24, end: 0x23, pgup: 0x21, pageup: 0x21, pgdn: 0x22, pagedown: 0x22,
    up: 0x26, arrowup: 0x26, down: 0x28, arrowdown: 0x28,
    left: 0x25, arrowleft: 0x25, right: 0x27, arrowright: 0x27,
    f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76,
    f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
    // F13-F24：没有默认绑定，测试与宏用保留键（winuser.h 同表）
    f13: 0x7C, f14: 0x7D, f15: 0x7E, f16: 0x7F, f17: 0x80, f18: 0x81,
    f19: 0x82, f20: 0x83, f21: 0x84, f22: 0x85, f23: 0x86, f24: 0x87,
    printscreen: 0x2C, prtsc: 0x2C,
    // 多媒体与启动（winuser.h 同表）
    volumemute: 0xAD, volumedown: 0xAE, volumeup: 0xAF,
    medianext: 0xB0, mediaprev: 0xB1, mediastop: 0xB2, mediaplay: 0xB3,
    calculator: 0xB7
};

const MOD_NAMES = {
    ctrl: 0xA2, control: 0xA2,          // VK_LCONTROL
    shift: 0xA1,                        // VK_LSHIFT
    alt: 0xA4, menu: 0xA4,              // VK_LMENU
    win: 0x5B, meta: 0x5B, super: 0x5B  // VK_LWIN
};

/**
 * 解析 "ctrl+shift+t" 或 "Enter"。返回 { mods, vks } 或 { error }。
 * 组合键允许的成员：修饰键 + 白名单键名；连按多个普通键用加号串联。
 */
function parseKeyCombo(input) {
    const raw = String(input || '').trim();
    if (!raw) { return { error: '键名为空' }; }
    const parts = raw.toLowerCase().split(/[+,]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) { return { error: '键名为空' }; }
    if (parts.length > 6) { return { error: '组合键最多 6 个成员：' + raw }; }

    const mods = [];
    const vks = [];
    for (const part of parts) {
        const mod = MOD_NAMES[part];
        if (mod !== undefined) {
            if (vks.length) { return { error: '修饰键必须在普通键之前：' + part }; }
            mods.push(mod);
            continue;
        }
        const vk = KEY_NAMES[part];
        if (vk === undefined) { return { error: '未知键名：' + part + '（支持 Enter/Tab/Escape/方向键/F1-24 与 ctrl/shift/alt/win 修饰）' }; }
        vks.push(vk);
    }
    if (!vks.length) { return { error: '组合里没有普通键，比如 Ctrl+C 这样的写法' }; }
    return { mods, vks };
}

module.exports = { parseKeyCombo, KEY_NAMES, MOD_NAMES };
