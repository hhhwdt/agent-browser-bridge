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
   mcp.js ──────────── the tool surface: 17 tools, schemas, descriptions
        │
        │  HTTP to 127.0.0.1:18777 — ALSO how cli.js and client.js talk to it
        ▼
   server.js ───────── the bridge: task queue, browser routing, origin checks
        │
        │  long poll: the extension asks for work, the bridge hands it one task
        ▼
   extension/ ──────── the only part that touches a page
        │
        │  chrome.scripting.executeScript — background tabs, no focus change
        ▼
   the page, with the user's own logged-in session
```

Two things about this shape are worth internalising:

**The extension polls; the bridge never pushes.** A service worker cannot listen on a port, so the
direction is inverted: `GET /poll` is held open for 25 seconds, and a task is answered on that held
response. That is why "the extension is connected" is really "a poll is currently held", why a
browser that stops polling looks offline within 30 seconds, and why one poll carries exactly one
task.

**Only the last hop needs a browser.** Everything above `extension/` is ordinary Node. That is what
makes the offline test suite possible, and it is why the bridge and the MCP server are separate
processes rather than one.

## Layout: what goes where

```
src/            the Node side: the bridge, the library, and three entry points
  server.js       the local bridge
  client.js       the library (main in package.json)
  cli.js          the command line
  mcp.js          the MCP server an agent talks to
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

- **No code at the top level.** Only `README*`, `LICENSE` and `package.json` are there. Anything
  executable lives in a directory named for what it is.
- **Entry points are npm bins.** `src/cli.js` and `src/mcp.js` are declared as `bin`, so an
  installed copy is invoked as `agent-browser-bridge` / `agent-browser-bridge-mcp` rather than by
  path. From a clone you type `node src/server.js`; from npm you type the command.
- **`test/` and `tools/` stay separate** because they answer different questions: `test/` proves
  behaviour, `tools/` reports on the source itself and is cheap enough to run on every commit.

One note for older notes and habits: the CLI used to be `read.js` in the repository root. It is now
`src/cli.js`.

## Inside the extension

`extension/sw/` is where the size is, so it is split by responsibility:

| Module | Holds | Imports from |
|---|---|---|
| `injected.js` | the 14 functions that get serialised into a page | **nothing** |
| `guards.js` | timeouts, frame selection, tab resolution, permission checks | nothing |
| `config.js` | bridge URL, poll timings, browser identity | nothing |
| `marks.js` | the visible "an agent touched this tab" state | injected, config, guards |
| `actions.js` | one function per action the bridge can dispatch | injected, config, guards |
| `background.js` | poll loop, task dispatch, boot, listeners, error log | config, marks, actions |

The dependency direction is one-way and there are no cycles. `background.js` is the only module that
registers event listeners; `actions.js` is the only one that touches a page indirectly.

`extension/sw/package.json` contains one line, `{"type": "module"}`. Chrome already knows these are
modules — the manifest says so — but Node does not, and Node is what the offline tests use to load
the whole graph.

### The invariant that matters

**A function in `injected.js` must be self-contained.** `executeScript({func})` serialises the
function's own source and evaluates it in the page; module scope does not come with it. Reference a
helper from another module and it compiles, passes review, and throws `ReferenceError` at the moment
a user clicks something.

`tools/check-inject-scope.js` enforces three things, and all three exist because of a real failure:
the function references no module-level name, its source is valid as an expression (so a stray
`export` cannot break serialisation), and `injected.js` contains no `import` at all.

## Adding an action

Be aware of the honest answer first: **an action is currently described in five places.**

| Where | What you add |
|---|---|
| `extension/sw/actions.js` | the implementation |
| `extension/sw/injected.js` | only if the page needs new code to run in it |
| `extension/sw/background.js` | a case in `runAction` |
| `src/server.js` | an HTTP route, and a name in `CAPABILITIES` |
| `src/mcp.js` | a tool definition and a handler |
| `src/cli.js` + `src/client.js` | a subcommand and a client method, only if it belongs on the CLI |

That is the weakest part of the design. A registry that generated the tool schema, the route and the
client method from one description would remove three of those edits, and it is the natural next
structural change if the action count keeps growing. It has not been done because the presentations
genuinely differ — the MCP schema needs descriptions, the CLI needs argument parsing — and a
half-generic version would be worse than the duplication.

## Hard-won constraints

Each of these is a bug that shipped. They are short; the cost of rediscovering them is not.

**Every injection needs a timeout.** A frozen tab's renderer never returns, and an un-timed
`executeScript` hangs the task and the poll loop with it.

**Do not report a timeout for work that succeeded.** `dispatch()` gives the first browser a shorter
budget before trying the next one, on the theory that a tab living elsewhere answers
`no_tab_matched` immediately. It was 8 seconds, and clearing marks took 8.1 — so the caller was told
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
Consequences: the server cannot tell the real extension from any other local program, and requiring
an extension origin on `/poll` locks the real extension out. See [SECURITY.md](SECURITY.md) for what
that means for the trust boundary.

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
