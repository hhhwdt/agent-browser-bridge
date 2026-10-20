# Roadmap

Directions, not commitments. Each item below is written so that someone who has read
[docs/ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) can pick it up
without re-deriving the context: what it is, why it matters, where the change goes, what would make it
done, and which parts are still open questions rather than settled design.

**State when this was written:** 1.7.1 is on `main` (the eight silent-success fixes plus the
packaging guards, tests and scaffolding). Publishing to npm needs the repository secret `NPM_TOKEN`;
the tag `v1.7.1` is what triggers it.

## Suggested order

| # | Item | Effort | Risk | Needs a decision first |
|---|---|---|---|---|
| 1 | Shared secret between bridge and extension | medium | high — touches the trust boundary | **yes** |
| 2 | English extension UI | small | low | no |
| 3 | Update notice | small | low | no |
| 4 | `wait` for network idle, URL, count | medium | low | no |
| 5 | Markdown output for `read` | medium | low | no |
| 6 | Audit log | medium | low | no |
| 7 | Frozen-tab recovery | small | **high — steals focus if done naively** | **yes** |
| 8 | Browser-layer tests in CI | medium-high | flaky | no |
| 9 | Batch actions | medium | low | no |
| 10 | Start the bridge at logon (Windows) | small | low | no |
| 11 | Keep two agents off the same tab | medium | low | depends on 1 |

Recommended for the next release (1.8.0): **1, 2, 4, 6**. Items 3 and 5 are cheap follow-ups. Item 8
is the one that raises confidence in everything else, including this list.

## Rules every item has to respect

These are not preferences; they are the constraints the codebase already lives by, and a change that
breaks one will be rejected regardless of what it does.

- **No dependencies, no build step.** `dependencies: {}` is checked in CI. A markdown converter (item
  5) or a semver comparison (item 3) has to be written by hand.
- **A function in `extension/sw/inject-*.js` must be self-contained** — `executeScript` serialises the
  function's own source, module scope does not travel with it. Run `node tools/check-inject-scope.js`.
  Note it does not strip comments: mentioning another injected function's literal name in a comment
  reads as a reference, so reword the comment rather than editing the checker.
- **Write actions must not run in every frame.** Probe read-only across frames, then act in the one
  frame that matched — the pattern in `injectInBestFrame`.
- **Never report success for work that did not happen.** Every new failure path needs an error code and
  an `ok: false`. `test/test-result-semantics.js` is where the ones of that shape belong.
- **Every injection needs a timeout** (`INJECT_TIMEOUT_MS` in `guards.js`).
- **Comments in Chinese, documentation in English.** Tests are named for the failure they prevent.
- **The risk rails are part of the interface.** `click` refusing destructive buttons, `type` not
  submitting, `close` requiring an explicit `tabId`. New actions inherit them; a batch (item 9) must
  not become a way around them.

## 1. Shared secret between the bridge and the extension

**Why.** [SECURITY.md](SECURITY.md) lists this as the biggest hole that is open: any extension that
declares host access to `127.0.0.1:18777` sends no `Origin`, so the server cannot tell it from the real
extension, and it can then drive every action while borrowing this extension's `debugger` and
`cookies` permissions. The same gap lets a page hold the poll slot and swallow a task. SECURITY.md
already names the fix: "a token pasted into an options page once would close it".

**What it does and does not buy.** It closes (a) another extension, because extensions cannot read
files on disk, and (b) a web page, which can neither read the file nor guess the token. It does **not**
close a local process running as the same user — that process can read the token file, and it could
read the browser profile anyway. SECURITY.md's trust boundary ("can run code on this machine as this
user") stays exactly where it is; say so in the docs rather than implying more.

**Where.**

- `src/server.js`: generate the token on first start with `crypto.randomBytes(32).toString('hex')`,
  write it `0600` to a per-user config path (`%APPDATA%\agent-browser-bridge\token` on Windows,
  `$XDG_CONFIG_HOME` or `~/.config/agent-browser-bridge/token` elsewhere; `--token-file` overrides).
  Require header `X-ABB-Token` on every route **except** `GET /health`, which must keep working before
  setup and must not leak the token. Keep the existing `Origin` checks as a second layer.
  `--no-token` restores today's behaviour and must print a warning at startup.
- `extension/sw/config.js` + `background.js`: send the header from `pollOnce` and `postResult`. On
  `401`, stop the normal retry loop and record a distinct state, or the extension will hammer the
  bridge every `RETRY_DELAY_MS` forever.
- `extension/popup.html` + `popup.js`: one field to paste the token, stored in `chrome.storage.local`.
  This is the only place a human can put it — extensions cannot read files.
- `src/setup.js`: a layer for "token configured", printing the file path and the paste step.
- `src/cli.js`: a subcommand to print the token and its path (`token` / `token --show`).
- Docs: README security model and install step, `docs/SECURITY.md` (move this hole from "not defended"
  to "defended", with the same-user caveat kept), QUICKSTART (one more step), CHANGELOG.

**Acceptance.** With a token configured, a request without the header gets `401` with a clear error
code; with it, everything works as before; `GET /health` works either way; `--no-token` behaves like
1.7.1 and warns. First run generates the file and prints how to paste it.

**Tests.** Extend `test/test-server.js` (isolated port, fake extension): 401 without the header, 200
with it, `/health` open, token file created with restrictive mode, `--no-token` accepted. On the
extension side, assert `pollOnce`/`postResult` carry the header — the stub-`chrome` approach in
`test/test-sw-load.js` is the cheapest place.

**Open decisions.** (a) Does the extension also *verify* the bridge (mutual auth), or only the bridge
verify the caller? Mutual is more work and buys little here. (b) Whether the token is mandatory by
default — recommended yes, because opt-in leaves the hole open for exactly the users who will not read
the docs. (c) How the popup reports "wrong token" without leaking whether the token exists.

## 2. English extension UI

**Why.** The popup is Chinese-only — 「授权」「授权所有站点」「撤销全部」「清除所有标记」 — with no
`_locales` and no `default_locale` in the manifest. Every document in this repository is English-first
with Chinese translations, so a reader who arrives from the README loads the extension and meets a
Chinese-only UI. For a project being handed to strangers that is the first impression.

**Where.** `extension/_locales/en/messages.json` and `extension/_locales/zh_CN/messages.json`;
`manifest.json` gets `default_locale` and `__MSG_…__` for `name` and `description`;
`popup.html`/`popup.js` go through `chrome.i18n.getMessage`, including the permission descriptions
built in `popup.js`.

**Acceptance.** With the browser in English the popup is English; in Chinese it is Chinese; no string
is hard-coded in the popup. Behaviour, layout and the permission flow are unchanged.

**Tests.** `test/test-sw-load.js` asserts exports only, so it will not catch a missing message key. Add
a small check that every `__MSG_`/`getMessage` key used exists in both locale files — a missing key
renders as an empty string at runtime, which is exactly the silent failure this project tries to
avoid.

**Open decisions.** The error `hint` strings in `actions.js` are Chinese and are read by agents, not by
the browser UI. Localising them through `chrome.i18n` would work but changes what an agent sees based
on the browser's locale. Recommendation: leave them, and say so in CONTRIBUTING.

## 3. Tell the user when a newer version exists

**Why.** There is no update channel: the extension is loaded unpacked and the bridge is started by
hand, so a user finds out about a fix only by looking. This is the cheapest way to make that visible
without running a self-hosted `.crx` + `update_url` (which needs HTTPS hosting and enterprise policy —
worth it for a team, not for this stage).

**Where.** `src/server.js` and `src/cli.js diag`: on start and on demand, read
`https://registry.npmjs.org/agent-browser-bridge/latest` with a short timeout, compare against
`package.json` (which `tools/check-version.js` already keeps equal to the manifest), and print one
line. Fire-and-forget: never delay startup, cache the answer for a day under the config dir, and add
`--no-update-check`. Use the public registry explicitly — a machine configured against a mirror
(`registry.npmmirror.com` is one this project has been developed on) would otherwise get a different
answer.

**Acceptance.** A newer published version prints one line naming it and what to do; no network call
when `--no-update-check` is set; startup time unchanged; no failure when offline.

**Tests.** Unit-test the comparison and the cache expiry with a mocked fetch. A hand-written
comparison is needed anyway (no dependencies), so test it against pre-release and equal versions.

## 4. `wait` for network idle, URL and element count

**Why.** `waitInPage` supports exactly two conditions: a selector appearing or disappearing (with a
visibility check when appearing), and a text substring in the body. Real pages need "it has finished
loading" and "the route changed", which today means sleeping and hoping.

**Where.** `extension/sw/inject-run.js` (`waitInPage`), `extension/sw/actions-tabs.js` (`waitTab`),
`src/server.js` (`routeWait`, whose "selector or text required" check becomes "at least one
condition"), `src/cli/`, `src/client.js`, `src/mcp/` (schema and description).

- `--idle <ms>`: no in-flight `fetch`/XHR for N ms. The honest implementation is a page-side counter
  installed *before* the wait starts, because requests already in flight when the wait begins cannot
  be seen otherwise. Counting `performance.getEntriesByType('resource').length` and treating "no
  change for N ms" as idle is simpler but weaker; if you take that route, say so in the tool
  description instead of calling it "idle".
- `--url <substring>`: poll `location.href`. This is what makes SPA navigation usable.
- `--count <n>`: `document.querySelectorAll(selector).length >= n`, for lists that fill in.

**Acceptance.** Each condition works on its own and combined with `state=disappear`; a timeout still
returns `wait_timeout` with `elapsedMs`; the CLI, the client, MCP and the HTTP route all expose the
same options; the existing selector/text behaviour is unchanged.

**Tests.** A `test-wait.js` in the style of `test-eval.js`: extract `waitInPage`, drive it against a
fake DOM with a fake clock, and assert both the satisfied and the timed-out path for each condition.

**Open decisions.** Whether `--idle` uses CDP (`Network` domain, real in-flight tracking) instead of
the page-side approximation. CDP is accurate but attaches the debugger, which conflicts with DevTools
on that tab and with `grab`/`screenshot`. Recommendation: page-side first, documented as an
approximation.

## 5. Markdown output for `read`

**Why.** `read` returns plain text, or raw HTML with `returnHtml`. Feeding a page to an agent as
markdown keeps the structure that matters (headings, lists, tables, links) at a fraction of the tokens,
and tables in particular are unusable as flat text.

**Where.** `extension/sw/inject-read.js` — a new self-contained function (remember the checker's list
in `tools/check-inject-scope.js` and the expected exports in `test/test-sw-load.js`), plus a
`format` argument through `extractInPage` or a sibling function; `actions-read.js` (`readTab`),
`server.js` (`routeRead`), `cli.js`, `client.js`, `mcp.js`.

**Scope it deliberately.** Headings, paragraphs, ordered and unordered lists (one level of nesting),
links, images, inline code, fenced code blocks, blockquotes, tables. Anything beyond that — layout
tables, definition lists, footnotes — is out of scope and should be documented as such rather than
half-supported.

**Acceptance.** `read --format markdown` on a page with those constructs produces markdown that
renders correctly; plain text remains the default; the existing `usedSelector`/`charCount` picking is
unchanged; no dependency is added.

**Tests.** A fixture-driven suite: small HTML documents with a fake DOM, compared against expected
markdown. Keep fixtures tiny and add one per construct so a regression names itself.

## 6. Audit log

**Why.** The only record of what happened is the per-tab visible mark, which disappears when the tab
closes and says nothing about when or by whom. For a tool that drives a logged-in browser, "what did it
do to my browser" should be answerable — and it is the single cheapest thing that makes handing this
tool to someone else reasonable.

**Where.** The bridge, not the extension: `src/server.js` sees every request and can attribute it
(remote port today, token identity after item 1). Write append-only JSONL to the same per-user config
directory as the token, with a size cap and one rotation; `--log-file` overrides. Record timestamp,
action, target (match/tabId/host), outcome (`ok` / error code), duration, and caller identity.

**Never log page content.** No text, no cookies, no storage values, no screenshot bytes. The log
answers "what was touched", not "what was on the page" — a log that leaks the pages someone read is
worse than no log.

**Expose it** through `node src/cli.js log [--tail N] [--json]`. Not through MCP: an agent should not
be able to read the history of another caller's browsing.

**Acceptance.** Each dispatched action produces one line; failures are recorded with their error code;
`/health` and other non-action routes are not logged; the file rotates at the cap; nothing
page-derived appears in a line.

**Tests.** Extend `test/test-server.js`: isolated server plus fake extension, assert line shape,
rotation, and that a `read` of a fixture page logs the target but not the text.

## 7. Frozen-tab recovery

**Why.** `activate` can wake a discarded tab, but nothing retries: a frozen tab comes back as
`tab_unresponsive` and the caller has to know to try `activate` and then repeat the action.

**The trap.** Recovering a discarded tab means making the browser load it, which means activating it —
and this tool's central promise is that it does not steal focus. An "automatic" recovery that activates
tabs silently would break that promise in the one case where the user is most likely to notice.

**Where.** `extension/sw/guards.js` (`injectAndPick` / `injectInBestFrame` and the
`tabUnresponsive` path) and the `activate` implementation in `actions.js`.

**Recommended shape.** Report as today by default, but make the hint name the exact next call
(`activate` then retry), and add an opt-in `--auto-activate` (or a popup toggle) for people who accept
the focus change. If the tab is not discarded, do not activate at all — a frozen renderer is a
different problem, and a reload would destroy page state.

**Acceptance.** Default behaviour is unchanged and the error explains the next step; with the opt-in
set, a discarded tab is woken once and the action retried once, and the result says that it happened.

**Tests.** Drive the guard with a stub `chrome` where the first injection times out: assert one retry
when opted in, none when not, and that the returned error is the second attempt's.

## 8. Browser-layer tests in CI

**Why.** All 12 suites run inside Node. The extension's real behaviour — the only part that touches a
page — is covered by tests a human runs by hand. The eight silent-success defects fixed in 1.7.1 came
through exactly that gap, and the iframe screenshot path added in 1.7.1 has still never run against a
real iframe.

**Where.** A new job in `.github/workflows/ci.yml` plus, if needed, a launcher under `scripts/`. The
pieces: start `src/server.js`, launch Chrome with `--headless=new --load-extension=<abs path>
--user-data-dir=<temp>`, wait for `/health` to report a connected browser (the service worker needs a
moment), then run `node test/test-live.js`.

**Why it should work.** `test-live.js` needs no configuration and no site grant: it drives the
bridge's own address, which the manifest already has host permission for.

**Risks.** Headless extension support and service-worker startup are the flaky parts. Expect to need a
retry loop around the "extension connected" wait, and consider `--no-sandbox` on the runner. If it
turns out to be unreliable, gate the job behind a label rather than deleting it — a flaky test that
runs on demand still catches real breakage.

**Acceptance.** The job passes on a clean runner and fails when an `extension/sw/inject-*.js` module
is deliberately broken (verify that, or the job is decoration).

## 9. Batch actions

**Why.** Every action is a round trip. A multi-step flow (read, click, wait, read) pays that latency
each time, which is noticeable when an agent is driving.

**Where.** A new `/batch` route in `src/server.js` taking an ordered list of normal action payloads,
executed in sequence, returning one result per step; `--file` on the CLI; `browser_batch` in
`src/mcp.js`.

**Constraint.** A batch must not become a way around the rails. Each step keeps its own semantics: a
destructive `click` still needs its force flag, `type` still does not submit, and a failure stops the
batch unless the caller explicitly asked to continue. Results must name which step failed.

**Acceptance.** Steps run in order, per-step results are returned, the first failure stops the batch by
default, and the rails behave exactly as they do for a single call.

**Tests.** `test/test-server.js` style: a fake extension, three steps, one of them failing; assert
order, the stop-on-failure default, and that a destructive step without its flag is refused.

## 10. Start the bridge at logon (Windows)

**Why.** `scripts/start-server.ps1` starts it for the current session; after a reboot the bridge is
simply gone and every tool call fails with `extension_not_connected` until someone notices.

**Where.** `scripts/install-autostart.ps1` and `scripts/uninstall-autostart.ps1`, registering a
per-user scheduled task (`Register-ScheduledTask`, trigger at logon, run level limited — no admin
rights needed, and it must not ask for any). Document it in README/QUICKSTART next to the existing
PowerShell helpers.

**Acceptance.** After installing, a reboot leaves the bridge running and `diag` connected; uninstall
removes the task and nothing else; the scripts are idempotent and say what they changed.

**Tests.** None automated — verify by hand and record the steps in the pull request. Do not claim it
works on a machine you did not reboot.

## 11. Keep two agents off the same tab

**Why.** Tasks from every caller share one queue per browser, so two agents (say Claude Code and
Cursor) interleave on the same tab with no ordering guarantee. Today that is an invisible race.

**Where.** `src/server.js` dispatch and queueing, keyed by caller identity — which is what item 1
provides, so this depends on it.

**Shape.** An optional per-tab lease: a caller acquires it for a tab, other callers either wait or get
`busy` with the holder named, and the lease is released on completion, on timeout, or when the tab
closes. Keep it opt-in; single-agent users should not pay for it.

**Acceptance.** Two simulated clients touching one tab serialise when leases are in use; without a
lease, behaviour is exactly as today; a crashed client's lease expires rather than wedging the tab.

**Tests.** Server-level with two fake clients in `test/test-server.js`: interleaving, `busy` response,
expiry.

## Deliberately not planned

- **Writing cookies or web storage.** The tool exists because the user is *already* logged in. Writing
  credentials in is a different product with a much worse failure mode.
- **A store listing.** The README argues it: `debugger` plus executing code a local program supplies at
  run time is what store review treats as remote code execution. Loading unpacked is the supported
  path, and the manifest `key` keeps the extension ID identical across installs.
- **Firefox.** MV3 differs enough (event pages rather than service workers, `moz-extension://` IDs)
  that the support cost is real and the audience is small. The docs say it is untested; leave it that
  way.
- **Any dependency.** Including for markdown and semver. Zero dependencies is what lets a user read
  the code that runs on their machine, and CI enforces it.
