/**
 * semver 版本比较。cli 与 server 共用。
 */

'use strict';

/** 比较两个 semver 版本，返回 true 如果 a > b。 */
function isNewerVersion(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) { return true; }
    if (na < nb) { return false; }
  }
  return false;
}

module.exports = { isNewerVersion };
