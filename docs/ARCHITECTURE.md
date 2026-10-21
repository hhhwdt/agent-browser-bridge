# Architecture

For someone about to change something. The [README](../README.md) explains what the tool is; this
file explains where things live, why they live there, and which mistakes this codebase has already
made so you do not repeat them.

---

## The four layers

```
   your agent (Claude Code, Cursor, anything that speaks MCP)
        │
        │  MCP over stdio: JSON-RPC, one message per line
        ▼
   mcp.js ──────────── the tool surface: 18 tools, schemas, descriptions
        │
        │  HTTP to 127.0.0.1:18777 — ALSO how cli.js and client.js talk to it
        ▼
   server.js ───────── the bridge: task queue, browser routing, origin checks
        │
        │  WebSocket (task push) + long poll (fallback): one queue per browser
        ▼
   extension/ ──────── the only part that touches a page
        │
        │  chrome.scripting.executeScript — background tabs, no focus change
        ▼
   the page, with the user's own logged-in session
```

Two things about this shape matter:

**The bridge pushes when it can, the extension polls when it must.** The extension opens a
WebSocket to the bridge and authenticates by sending the shared token in its first `hello`
message (a browser WebSocket cannot carry custom headers). While that channel is up, a queued
task is pushed onto it immediately, the result comes back on the same channel as a
`{"type":"result"}` frame (settlement shares the `/result` code path in `queue.js`), and the poll
loop in `background.js` stands down — with the HTTP `POST /result` retained as the fallback for
results produced while the channel is down. The
service worker keeps being reset by the browser when it goes idle; since Chrome 116 WebSocket
activity counts toward the idle timer, and the bridge sends two heartbeats every 20 seconds — a
control ping for dead detection plus a data frame, because an automatically answered pong never
enters the event loop — an online extension stays resident instead of waiting for an alarm
wake-up. If the channel is unavailable (proxy that swallows `Upgrade`, older extension),
delivery falls back to the original held `GET /poll`; the one-task-per-dispatch-each-round
semantics and the 30-second offline window still apply on that path.

**Only the last hop needs a browser.** Everything above `extension/` is ordinary Node. That is what
makes the offline test suite possible, and it is why the bridge and the MCP server are separate
processes rather than one.

## Layout: what goes where

```
src/            the Node side: the bridge, the library, and three entry points
  server.js       the local bridge (implementation in src/server/)
  client.js       the library (main in package.json)
  cli.js          the command line (implementation in src/cli/)
  mcp.js          the MCP server an agent talks to (implementation in src/mcp/)
  setup.js        the one-command self-check
extension/      the browser extension (MV3)
  sw/             the service worker, split by responsibility
  popup.html/js   the extension popup
test/           tests — the README says which ones need a browser
tools/          offline checks (injection scope, extension ID consistency)
scripts/        Windows helpers for running the bridge as a service
docs/           disclaimer, security model, privacy, quickstart, this file
```

Three rules keep it that way:

- **No code at the top level.** The root holds `README*`, `LICENSE`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `package.json` — text, not code. Anything executable
  lives in a directory named for what it is.
- **Entry points are npm bins.** `src/cli.js` and `src/mcp.js` are declared as `bin`, so an
  installed copy is invoked as `agent-browser-bridge` / `agent-browser-bridge-mcp` rather than by
  path. From a clone you type `node src/server.js`; from npm you type the command.
- **`test/` and `tools/` stay separate** because they answer different questions: `test/` proves
  behaviour, `tools/` reports on the source itself and is cheap enough to run on every commit.

One note for older notes and habits: the CLI used to be `read.js` in the repository root. It is now
`src/cli.js`.

## Inside src

The three entry files are thin shims (`require('./server/index.js')` etc.) so that `package.json`
bin paths, `npm test` spawn paths and user scripts never change. The implementations:

| Module | Holds |
|---|---|
| `src/server/` | config, token, audit log, per-tab leases, HTTP plumbing, the dispatch queue, update check, and `routes/` with one small function per endpoint; `src/server/index.js` holds the route table |
| `src/actions-registry.js` | the single description of every action: HTTP path, parameters and casts, validation rules, default timeout, MCP tool schema, CLI value options; `src/server/routes/generic.js` runs it |
| `src/cli/` | argument parsing, usage text, output helpers, the update check, and `commands/` with one file per command group; `src/cli/index.js` routes to them |
| `src/mcp/` | tool schemas and instructions (`tools.js`), the tool → bridge call mapping (`handlers.js`), the ensure-the-bridge-is-running step (`ensure.js`) |
| `src/version.js`, `src/config-dir.js` | the two helpers that were duplicated between the server and the CLI (`isNewerVersion`, `getConfigDir`) |
| `src/client.js`, `src/setup.js` | unchanged |

Mutable state that used to be scattered across `server.js` now has one home: `src/server/queue.js`.

## Inside the extension

`extension/sw/` is where the size is, so it is split by responsibility:

| Module | Holds | Imports from |
|---|---|---|
| `inject-*.js` (6 files) | the functions that get serialised into a page: `inject-read` extract/links/markdown/rect/diag, `inject-click` click, `inject-edit` type/key, `inject-run` wait/eval/storage, `inject-mark` indicator/tab-mark, `inject-media` media/fetch | **nothing** |
| `actions-*.js` (6 files) | one function per action, grouped the same way: tags/read/screenshot/session/files/interact | inject-*, config, guards |
| `actions.js` | re-exports `actions-*.js`, so importers keep one path | actions-* |
| `guards.js` | timeouts, frame selection, tab resolution, permission checks | nothing |
| `config.js` | bridge URL, poll timings, browser identity | nothing |
| `marks.js` | the visible "an agent touched this tab" state | inject-mark, config, guards |
| `ws.js` | WebSocket channel to the bridge: reconnect, auth via hello, task push down, result frames up | config |
| `background.js` | task dispatch, poll fallback loop, boot, listeners, error log | config, marks, actions, ws.js |

The dependency direction is one-way and there are no cycles. `background.js` is the only module that
registers event listeners; `actions.js` is the only one that touches a page indirectly.

`extension/sw/package.json` contains one line, `{"type": "module"}`. Chrome already knows these are
modules because the manifest says so; Node does not, and Node is what the offline tests use to load
the whole graph.

### The invariant that matters

**A function in the `inject-*.js` modules must be self-contained.** `executeScript({func})` serialises
the function's own source and evaluates it in the page; module scope does not come with it. Reference a
helper from another module and it compiles, passes review, and throws `ReferenceError` at the moment
a user clicks something.

`tools/check-inject-scope.js` enforces three things, and all three exist because of a real failure:
the function references no module-level name, its source is valid as an expression (so a stray
`export` cannot break serialisation), and no `inject-*.js` module contains an `import` at all.

## Adding an action

Where the pieces live, and which of them are generated:

| Where | What you add | Generated? |
|---|---|---|
| `extension/sw/actions-*.js` | the implementation | no |
| `extension/sw/inject-*.js` | only if the page needs new code to run in it | no |
| `extension/sw/background.js` | a case in `runAction` | no |
| `src/actions-registry.js` | one entry: path, params and casts, validation rules, default timeout, the MCP tool schema and description | — (this is the source) |
| `src/server/index.js` | a row in the route table (the handler is one `makeRoute` line) | handler, from the entry |
| `src/server/config.js` | a name in `CAPABILITIES` | no |
| `src/mcp/handlers.js` | a handler (only when the tool formats its own output) | schema + description, from the entry |
| `src/cli/commands/` + `src/client.js` | a subcommand and a client method, only if it belongs on the CLI; value options are listed in the entry's `CLI_VALUE_OPTS` | no |

The route, the tool schema and the CLI value options all come from the one entry, so adding a
parameter to an action is a single edit; `test/test-registry.js` cross-checks the entry against
the route table, the extension's action functions and the MCP handlers, so a name that only made
it into some of the layers fails offline instead of passing review.

The extension cannot share the registry file (browser ESM, zero-dependency constraint), so its
action function names are locked to the registry by that test rather than by imports. The
definitions that are genuinely different per consumer (an MCP description, a CLI flag name) live
in the entry as explicit fields — the duplication left is chosen duplication, not drift.

## Hard-won constraints

Each of these is a bug that shipped. They are short; the cost of rediscovering them is not.

**Every injection needs a timeout.** A frozen tab's renderer never returns, and an un-timed
`executeScript` hangs the task and the poll loop with it.

**Do not report a timeout for work that succeeded.** `dispatch()` gives the first browser a shorter
budget before trying the next one, on the theory that a tab living elsewhere answers
`no_tab_matched` immediately. It was 8 seconds, and clearing marks took 8.1, so the caller was told
`timeout` while the marks had in fact been cleared. Tasks with no tab to find now get the full
budget, and the cap for the rest is above the extension's own 12-second injection budget.

**Anything that must survive service-worker eviction has to be re-registered on every start, and
the listener is what makes the wake-up happen.** An MV3 service worker is killed when idle. The
keepalive alarm only wakes it because `chrome.alarms.onAlarm` has a listener; drop that
registration and the extension works until its first eviction and then goes silent forever, in every
browser, with no error anywhere. This is also why `test/test-sw-load.js` loads the whole module
graph: a load-time failure shows up in a browser only as "the extension stopped responding".

**`eval` runs the code exactly once.** The first implementation evaluated twice when it could not
get a return value, so a bare `document.querySelector('#x').click()` clicked twice.

**A write action must not execute in every frame.** `allFrames: true` runs the function in each
frame; a picker can only choose which result to believe, it cannot undo the other clicks. click,
type and key probe read-only first, then act in the one frame that matched.

**The extension's requests to the bridge carry no `Origin`.** It holds host permission for
`127.0.0.1:18777`, so its fetches are not CORS requests and Chrome omits the header entirely.
The bridge requires `X-ABB-Token` on every route except `/health`; the extension reads the token
from `chrome.storage.local` (pasted in the popup once) and sends it on every poll and result — and,
on the WebSocket channel, in its first `hello` message, because a browser WebSocket cannot carry
custom headers. A second extension cannot read the token file, so it cannot drive the bridge. See
[SECURITY.md](SECURITY.md) for the trust boundary.

**Editing the extension requires a reload, and `src/cli.js reload` needs the extension to be alive.**
That combination is a deadlock: deploy a broken service worker and the only way back is a human
clicking reload in `chrome://extensions`. Treat any change to `extension/` as something to verify
immediately, and keep `test/test-sw-load.js` green before reloading.

## Conventions

- **No dependencies, no build step.** `dependencies: {}` is enforced in CI. Nothing here needs
  compiling, and a user should be able to read the code that runs on their machine.
- **Code comments are Chinese; docs are English** with a Chinese README. The comments explain
  intent and record traps; keep that tone rather than restating what the line does.
- **Tests are named for the failure they prevent**, not for the function they call. `test-eval.js`
  is about "runs once"; see the [README](../README.md#testing) for which suites need a browser.
- **The risk rails are part of the interface.** `click` refusing destructive-looking buttons and
  `type` not submitting are behaviours, not accidents; they exist so a human stays in the loop, and
  they are documented in the tool descriptions an agent reads.
