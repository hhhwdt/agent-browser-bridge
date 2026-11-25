#!/usr/bin/env node
/**
 * 离线测试总入口：跑完所有不需要浏览器、不需要 test-config.js 的套件。
 *
 * 这些套件都不碰 18777 上正在跑的那个桥接实例（各自在隔离端口上起自己的服务），
 * 因此可以在 CI 里跑，也可以在改完代码后随手跑一遍。
 *
 * 套件之间互不共享状态，所以默认并行跑（CAP 个一起），总耗时约等于最慢那几个
 * 而不是全部相加。只有一个例外：会操作真实桌面的套件必须串行，否则两个套件的
 * 鼠标键盘会互相插——它们被列在 SERIAL 里，最后单独跑。
 *
 *   node test-offline.js
 *   ABB_TEST_CONCURRENCY=1 node test-offline.js   # 排障时退回串行
 *
 * 需要浏览器的部分另有两个入口：
 *   node test-live.js    真机冒烟（仍不需要配置，用桥接自己的地址当测试床）
 *   node test-basic.js   等需要 test-config.js 的套件
 *
 * 环境变量：
 *   ABB_MCP_OFFLINE=1      跳过 test-mcp.js 里需要扩展的部分（CI 用），只验协议
 *   ABB_TEST_CONCURRENCY=N 并行度，默认 4
 *   ABB_TEST_TIMEOUT_MS=N  单个套件的超时，默认 240000
 */

'use strict';

const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CAP = (() => {
  const v = parseInt(process.env.ABB_TEST_CONCURRENCY || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 4;
})();
const TIMEOUT_MS = (() => {
  const v = parseInt(process.env.ABB_TEST_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 240000;
})();

const SUITES = [
  ['服务脚本模块图能否加载', 'test-sw-load.js'],
  ['服务端派发、队列、结果体与来源校验', 'test-server.js'],
  ['排队上限、一次排空与超时释放名额', 'test-queue-inflight.js'],
  ['动作注册表三方一致', 'test-registry.js'],
  ['WebSocket 任务通道', 'test-ws.js'],
  ['eval 的执行次数与取值语义', 'test-eval.js'],
  ['写操作只在一个框架里执行', 'test-frame-targeting.js'],
  ['命令行参数解析与客户端错误归类', 'test-client.js'],
  ['客户端并发闸门与读类重试', 'test-client-limits.js'],
  ['扩展来源允许列表', 'test-allowlist.js'],
  ['注入函数自包含', path.join('..', 'tools', 'check-inject-scope.js')],
  ['扩展 ID 与清单公钥一致', path.join('..', 'tools', 'check-extension-id.js')],
  ['发布包里没有本机专用文件', path.join('..', 'tools', 'check-package.js')],
  ['两处版本号一致', path.join('..', 'tools', 'check-version.js')],
  ['没有没人引用的死文件', path.join('..', 'tools', 'check-orphans.js')],
  ['动作失败时不报成功', 'test-result-semantics.js'],
  ['连续动作只打一次页面内标记', 'test-mark-throttle.js'],
  ['弹窗 i18n key 与 locale 文件一致', 'test-i18n-keys.js'],
  ['wait 条件成立与超时', 'test-wait.js'],
  ['审计日志不泄露页面内容', 'test-audit.js'],
  ['共享 token 校验', 'test-token.js'],
  ['更新检查版本比较', 'test-update.js'],
  ['Markdown 转换', 'test-markdown.js'],
  ['冻结标签页恢复提示', 'test-frozen-tab.js'],
  ['批量动作', 'test-batch.js'],
  ['Per-tab lease', 'test-lease.js'],
  ['computer 门禁与键名解析', 'test-computer-policy.js'],
  ['桌面写锁与 agent 身份', 'test-desktop-broker.js'],
  ['桌面策略、幂等与指标', 'test-desktop-runtime.js'],
  ['常驻桌面宿主（需 Windows）', 'test-desktop-host.js'],
  ['MCP 协议（自己充当客户端）', 'test-mcp.js']
];

/** 会驱动真实鼠标键盘/截屏的套件：必须独占跑。 */
const SERIAL = new Set(['test-computer.js', 'test-computer-uia.js', 'test-desktop-host.js', 'test-desktop-soak.js']);

/** 起一个套件并把输出攒起来；退出后再打印，避免并行时日志互相穿插。 */
function runSuite(label, file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    let out = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, TIMEOUT_MS);

    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { out += c.toString(); });
    child.on('error', (e) => { out += `\n启动失败: ${e.message}\n`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        label,
        file,
        ok: !timedOut && code === 0,
        status: timedOut ? 'timeout' : code,
        ms: Date.now() - started,
        out
      });
    });
  });
}

/**
 * 连子进程树一起杀。Windows 上 child.kill() 只杀直接子进程，
 * 套件里 spawn 的 powershell 宿主要靠 taskkill /T 才会跟着退出。
 */
function killTree(child) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch (e) { /* 落到 kill */ }
  }
  try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
}

function printSuite(label, file, out) {
  console.log(`\n${'='.repeat(64)}\n${label}  ——  ${file}\n${'='.repeat(64)}`);
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
}

(async () => {
  const parallel = SUITES.filter(([, file]) => !SERIAL.has(file));
  const serial = SUITES.filter(([, file]) => SERIAL.has(file));

  console.log(`离线套件：${SUITES.length} 个（并行 ${parallel.length}，串行 ${serial.length}），并行度 ${CAP}`);

  const done = new Map();
  let next = 0;

  /** 每个 worker 从共享下标里取下一个套件，直到取完。 */
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= parallel.length) { return; }
      const [label, file] = parallel[i];
      const r = await runSuite(label, file);
      printSuite(label, file, r.out);
      done.set(file, r);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CAP, parallel.length) }, worker));

  for (const [label, file] of serial) {
    const r = await runSuite(label, file);
    printSuite(label, file, r.out);
    done.set(file, r);
  }

  console.log(`\n${'='.repeat(64)}\n汇总\n${'='.repeat(64)}`);
  const results = SUITES.map(([label, file]) => done.get(file) || { label, file, ok: false, status: 'missing' });
  for (const r of results) {
    const time = typeof r.ms === 'number' ? `${(r.ms / 1000).toFixed(1)}s` : '   -';
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.file.padEnd(26)} ${time.padStart(6)}  ${r.label}`);
  }

  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((n, r) => n + (r.ms || 0), 0);
  console.log(failed.length
    ? `\n${failed.length} 个套件失败：${failed.map((r) => r.file).join(', ')}`
    : `\n${results.length} 个套件全部通过（套件耗时合计 ${(total / 1000).toFixed(1)}s，机器 ${os.cpus().length} 核）`);
  process.exit(failed.length ? 1 : 0);
})();
