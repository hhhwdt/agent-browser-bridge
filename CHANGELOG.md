# Changelog

Notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

1.7.0 is the first version prepared for distribution. Earlier version numbers (1.4.x–1.6.x) were
development iterations of a tool that was not published; their changes are not itemised, because
reconstructing them from the code alone would be guesswork.

## [Unreleased]

### Added

- Shared token between bridge and extension: the server generates a 32-byte hex token on first start, writes it to a per-user config file, and requires `X-ABB-Token` on every route except `/health`. The extension reads the token from `chrome.storage.local` (pasted in the popup) and sends it on every poll and result. `--no-token` restores the old behaviour for development. Closes the "any local program can drive the bridge" hole.
- `test/test-token.js`: token is generated, required, and validated — the failure mode where a missing token lets any local program drive the bridge.
- Update notice: the bridge checks npm registry on start and prints one line if a newer version exists. `--no-update-check` disables it. `node src/cli.js diag` also checks.
- `test/test-update.js`: version comparison logic — the failure mode where a user sees a wrong update prompt or no prompt when one is needed.
- Markdown output for `read`: `format: 'markdown'` returns Markdown instead of plain text. Covers headings, paragraphs, lists, links, images, inline code, code blocks, blockquotes, tables.
- `test/test-markdown.js`: HTML to Markdown conversion — the failure mode where structure is lost or page content is dumped raw.
- Frozen-tab recovery: `tab_unresponsive` hint now names the exact next call (`activate` then retry). Opt-in `--auto-activate` on `read` wakes a discarded tab and retries once.
- `test/test-frozen-tab.js`: the hint names the next step — the failure mode where a user doesn't know to activate before retrying.
- Batch actions: `POST /batch` executes an ordered list of actions, returning one result per step. First failure stops the batch unless `continueOnError: true`. `node src/cli.js batch <file>` and `browser_batch` MCP tool.
- `test/test-batch.js`: batch execution order and stop-on-failure — the failure mode where a batch bypasses the risk rails or runs steps out of order.
- Per-tab lease: `lease: true` on `read` acquires an exclusive lock on the tab, preventing two callers from operating the same tab simultaneously. Other callers get `tab_busy`. Lease is released on completion or after 5 minutes.
- `test/test-lease.js`: lease acquisition and release — the failure mode where two agents interleave on the same tab with no ordering guarantee.
- Browser-layer tests in CI: a new `browser-tests` job runs `test-live.js` against headless Chrome with the extension loaded unpacked.
- Windows autostart: `scripts/install-autostart.ps1` registers a per-user scheduled task to start the bridge at logon. `scripts/uninstall-autostart.ps1` removes it.
- `wait` now supports URL, element-count and network-idle conditions alongside the existing
  selector/text conditions. Each can be combined with the others and with `state=disappear`.
  `--idle <ms>` treats "no new resource entries for N ms" as idle — a page-side approximation,
  documented as such in the tool description.
- `test/test-i18n-keys.js`: every `data-i18n` / `data-i18n-html` / `getMessage` / `__MSG_…__` key used by the popup and the manifest must exist in both locale files — a missing key renders as an empty string, which is silent.
- `test/test-wait.js`: each wait condition returns ok when satisfied and `wait_timeout` when not — the failure mode that means the next step ran before the page was ready.
- Audit log: every dispatched action appends one JSONL line (timestamp, action, target, outcome, duration, caller) to `audit.jsonl` in the per-user config directory. Query routes (`tabs`, `frames`, `media`, `diag`) are excluded. The file rotates at 10 MB. `node src/cli.js log [--tail N] [--json]` reads it. No page content is ever written.
- `test/test-audit.js`: the audit log records actions but never page content — a log that leaks what someone read is worse than no log.

### Changed

- The extension popup is localised: `default_locale` plus `_locales/en` and `_locales/zh_CN`, no string hard-coded in `popup.html` or `popup.js`.
- `diag`'s `markedCount` now comes from `collectMarkedTabs()` (live detection by title prefix and badge) instead of `markedTabs.size` (historical records), so the popup shows the number of tabs that actually carry a mark right now.
- `unmarkTask` now checks whether a specific tab is actually marked before injecting, and updates `markedTabs` after clearing so storage stays consistent with reality.

## [1.7.1] - 2026-10-16

Eight defects that all had the same shape: the tool reported success for work that did not happen.

### Fixed

- The extension registered its boot block twice, so `bootstrap()` ran twice per service-worker
  start and `diag`'s "SW starts" counter doubled — the counter used to judge whether the worker is
  being recycled.
- `links --selector` returned `ok` with zero links when the selector matched nothing, because the
  page-side `selector_not_found` error was dropped on the way out. `linksInPage` also never reported
  `selectorMatched`, so the frame scorer fell back to the first frame and links inside an `iframe`
  could not be found at all.
- `grab` reported `ok` for a download that was interrupted, and for one that never registered. `save`
  already returns `error: 'interrupted'` for the first case.
- `unmarkTask` counted promise rejections, which `removeBadge` and `hideIndicator` never produce, so
  the "N tabs did not respond" note never appeared and marks left behind in a frozen tab were never
  reported.
- `session --key` returned a single value before the 4000-character truncation ran, so one large key
  came back whole.
- `eval` injected with `allFrames`, so side-effecting code ran once per frame while only one result
  was reported — the rule `click`, `type` and `key` already follow.
- `screenshot --selector` measured an element inside an `iframe` in that frame's own coordinates and
  used them as the CDP clip, cropping the wrong region. Sub-frames now measure through
  `DOM.getFrameOwner` / `DOM.getBoxModel`, whose coordinates are already relative to the main frame;
  when the frame cannot be measured, the action reports `element_not_found` instead of a wrong crop.
- `waitForTabUrl` accepted a prefix match, so navigating to a URL that the current address merely
  extends returned the pre-navigation URL.

### Added

- `test/test-result-semantics.js`: 41 assertions covering the eight fixes above, so silent success
  cannot come back unnoticed. `test/test-sw-load.js` also asserts the extension boots exactly once.
- `tools/check-package.js`: fails if the tarball contains a file git does not track. `npm pack`
  includes `README*` no matter what `.gitignore` or `files` say, which is how a local ops document
  full of absolute paths would have been uploaded.
- `tools/check-version.js`: `package.json` and `extension/manifest.json` must carry the same version.
- Windows CI job, a tag-triggered release workflow, `prepublishOnly` gating the offline suite,
  CONTRIBUTING, this changelog, issue and pull-request templates.
- Errors that point at the next step: `eval` and `screenshot` name `frames` / `--frameId` when the
  target is not in the main frame; `links` names `frames` when a selector matches nothing.

## [1.7.0] - 2026-10-15

### Changed

- `extension/` split into `extension/sw/` by responsibility: `injected.js` (page functions),
  `guards.js` (timeouts, frame selection, permissions), `config.js`, `marks.js`, `actions.js`,
  `background.js`.
- Tests moved to `test/`, the source-level checkers to `tools/`, and the repository root now holds
  only `README*`, `LICENSE`, `CHANGELOG.md` and `package.json`.
- `src/setup.js` walks every setup step and reports which one is missing.

### Added

- Offline test suite, runnable with no browser and no configuration, plus CI on Node 18, 20 and 22.
