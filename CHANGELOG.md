# Changelog

Notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

1.7.0 is the first version prepared for distribution. Earlier version numbers (1.4.x–1.6.x) were
development iterations of a tool that was not published; their changes are not itemised, because
reconstructing them from the code alone would be guesswork.

## [1.9.0] - 2026-10-21

### Added

- WebSocket task channel: the extension opens `ws://127.0.0.1:18777/ws` and authenticates by sending
  the shared token and its extension ID in the first `hello` message (a browser WebSocket cannot
  carry custom headers). Queued tasks are pushed onto the channel immediately instead of waiting for
  the next poll. The server sends two heartbeats every 20 seconds: a control ping for dead-connection
  detection (automatically answered by the browser, no JS runs) and a `{"type":"ka"}` data frame —
  the MV3 service worker's idle timer only resets on WebSocket traffic that enters the event loop,
  so the keep-alive side must be ordinary data frames. The handshake, frame framing and ping/pong
  are a minimal RFC 6455 implementation on `node:crypto` — the zero-dependency constraint holds.
- Long-poll delivery is preserved verbatim as the fallback: when no WebSocket is connected for a
  browser, tasks flow through the original held `GET /poll`. `diag` reports the channel state; close
  codes 4401/4403 mirror the HTTP 401/403 semantics, and pasting a corrected token in the popup
  reconnects immediately via `storage.onChanged`. The keep-alive alarm also re-attempts the channel,
  because a running poll loop keeps the service worker resident and a latched auth-failed state
  would otherwise never see a fresh bootstrap.
- `test/test-ws.js` (offline): handshake accept-key against the RFC 6455 §1.3 sample values, task
  push without any poll, result round-trip over HTTP, channel rejection by extension ID and by token,
  and replacement of the channel when the same browser connects twice.
- Results travel over the WebSocket channel once it is authenticated: the extension sends
  `{"type":"result", id, result}` on the same connection, and the server settles it through the same
  code path the HTTP `/result` route uses (`queue.recordResult`), browser-mismatch protection
  included. `POST /result` remains as the fallback for results produced while the channel is down.
  The `{"type":"result"}` framing rides on the existing RFC 6455 layer; per-frame size limits now
  differ by phase (1 MB before auth, 34 MB after, matching the 32 MB HTTP body cap plus slack).
- `node src/cli.js token --rotate` mints a replacement token file and prints the two steps to make
  it live (restart the bridge — the old token stays valid until then — and re-paste the new value in
  each browser's popup, which reconnects immediately). For leak response; previously the only way
  was deleting the file by hand.
- `client.action(name, params)`: an escape hatch that dispatches by registry action name. Named
  methods stay the comfortable path; this one covers the window where a published npm package lags
  behind a new action, and it derives path, body and request timeout from the registry entry.
- The popup shows the push-channel state ("推送通道: 在线/离线") from the background's own `ws`
  state, next to the bridge dot — when a call becomes slow, the popup answers "is the channel up"
  without a `diag` round trip.

### Changed

- Action metadata is described once, in `src/actions-registry.js`: HTTP path, how each parameter is
  read from the body (raw / boolean / number / enum), validation rules with their exact error codes
  and hints, default dispatch timeouts, the MCP tool schema and description, and the CLI value
  options. The generic route runner (`src/server/routes/generic.js`) drives validation and task
  assembly from it; `src/mcp/tools.js` generates `TOOLS` from it; `src/cli/args.js` derives the
  value-option whitelist from it. The 20 straight-line routes shrink to one `makeRoute` line each
  and hand-written handlers remain only where they have real extra logic (`/mark`, `/batch`,
  `/reload`). `test/test-registry.js` is new and cross-checks the registry against the route table,
  the extension's action functions and the MCP handlers — the extension cannot import the registry
  (browser ESM), so its action names are locked there instead of being centralised. Error codes,
  hints, schemas and dispatch behaviour are byte-for-byte unchanged; all pre-existing suites pass
  unmodified except `test-client.js`, which now reads the parser from its one real home.

### Fixed

- `download --maxBytes N` never reached the server: `maxBytes` was missing from the CLI value-option
  list, so the flag was parsed as an empty switch and the number was dropped. It is now derived from
  the registry with the rest.
- Token mode broke every local caller, and 1.8.0 shipped it: the server requires `X-ABB-Token` on
  all routes except `/health`, but `client.js` — which sits under the CLI and the MCP server —
  never sent the header and offered no way to supply it. The 401 hint told users to paste the
  token into the extension popup, which cannot help a CLI invocation. `client.js` now reads the
  token from the same per-user config file the server uses and sends it automatically
  (`createClient({ token })` overrides); the 401 hint names both paths. No security regression:
  the barrier this preserves is against other extensions and other-user processes, not against a
  process already running as the user, which could read the file anyway.
- `grab`'s 190-second dispatch budget never took effect: `clampTimeout` carries a hard 120-second
  ceiling, and the registry-declared default was silently clamped to it. Long fetches then reported
  `timeout` to the caller while the extension was still downloading — the "worked anyway" defect
  class 1.7.1 cleaned up. The ceiling is now a registry field (`maxTimeout`); `grab` declares
  300000 so its own default survives, other actions keep the 2-minute ceiling, and
  `test/test-registry.js` pins the invariant that every declared default really applies.
- The WebSocket frame parser kept its truncation boundary at the start of the last *attempted* frame
  instead of the last *consumed* one, with two consequences. A batch ending exactly on a complete
  frame left that frame buffered, so it was dispatched a second time when the next chunk arrived —
  fatal for the final continuation of a fragmented message, whose replay hits an empty fragment
  state and answers `close(1002)`, discarding every other message in that chunk (this is the
  deterministic `browser_read_page` timeout right after `browser_screenshot`: the ~100 KB result is
  split into continuation frames by the browser, and the next inbound message kills the channel).
  Incomplete frames split across TCP segments are now also resumed precisely from the start of the
  not-yet-complete frame. The parser tracks a consumed boundary: complete frames are consumed
  immediately, only unfinished ones are retained. `test/test-ws.js` adds a fragmented-message
  regression (continuations finish, then a following message must still be parsed).
- The extension could enter a reconnect chase where two live WebSocket instances kept replacing each
  other at sub-second intervals. `connect()` had no re-entrancy guard and a socket's `onclose`
  cleared `sock`/`healthy` unconditionally, so a stale reconnect timer firing next to an already
  healthy channel opened a duplicate connection, which the server replaces by design, and whose
  victim's `onclose` then re-armed the chase — after a bridge restart the flap fed itself forever
  and tasks landed on the doomed connection (callers saw `timeout`). Three fixes that hold together:
  `connect()` refuses when a socket exists, `onclose` ignores a socket that is no longer the current
  one, and the server's replacement close now carries the dedicated code 4420 ("a newer connection
  of your browser took over — do not reconnect") instead of a generic 1000. `test/test-ws.js` pins
  the 4420 code.
- A queued task sent onto a WebSocket channel that had died in the seconds before its `onclose`
  cleanup was silently dropped (`flushTasks` only handled `throw`, but `sendTask` returns `false`
  in that state); it is now put back at the queue head and the channel is unregistered so the
  long-poll fallback takes it over.

## [1.8.0] - 2026-10-20

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
- Virtual cursor: `click` / `type` / `key` render a visible arrow cursor at the target element (glides between consecutive actions, presses when the synthetic events fire), so the person watching the browser can see where the agent is acting. Probe and dry-run stay side-effect free; cursor failures never affect the action itself.

### Changed

- The extension popup is localised: `default_locale` plus `_locales/en` and `_locales/zh_CN`, no string hard-coded in `popup.html` or `popup.js`.
- `diag`'s `markedCount` now comes from `collectMarkedTabs()` (live detection by title prefix and badge) instead of `markedTabs.size` (historical records), so the popup shows the number of tabs that actually carry a mark right now.
- `unmarkTask` now checks whether a specific tab is actually marked before injecting, and updates `markedTabs` after clearing so storage stays consistent with reality.
- `src/server.js`, `src/cli.js` and `src/mcp.js` became thin entry shims whose implementations live in `src/server/`, `src/cli/` and `src/mcp/`; the extension's `sw/injected.js` split into six `inject-*.js` modules and `sw/actions.js` into six `actions-*.js` modules, with `actions.js` re-exporting them so `background.js` keeps one import path. Bin paths and test spawn paths are unchanged. The helpers duplicated between the server and the CLI now live in `src/version.js` and `src/config-dir.js`.

### Fixed

- The CLI update check never ran: it required `./package.json` from `src/`, where no package.json exists, so no version was ever compared or printed.
- The audit log silently failed on a machine without the config directory (custom `--log-file` paths, first run on a new machine); the directory is now created before appending.
- The `browser-tests` CI job has been red since it was added, so it never actually verified anything: the bridge required a token that a fresh-profile extension cannot have, and setup-chrome@v1 installed branded Chrome, which ignores `--load-extension` since Chrome 137. The job now starts the bridge with `--no-token` on the disposable runner and pins Chrome for Testing via setup-chrome@v2.
- The npm package is published as `@hhhwdt/agent-browser-bridge`: the unscoped `agent-browser-bridge` name on the registry is held by another account. The bin command names (`agent-browser-bridge`, `agent-browser-bridge-mcp`, `agent-browser-bridge-setup`) are unchanged.

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
