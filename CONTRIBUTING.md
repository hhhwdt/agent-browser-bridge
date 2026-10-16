# Contributing

Thanks for looking. This is a small tool with an unusually sharp edge — it drives a real browser
with the user's own logged-in session — so the bar for a change is less "does it work" and more
"can the person who reads this later tell what it does and what it refuses to do".

If you only read one file before changing something, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
It says where things live, why, and which mistakes this codebase has already made. Most of what is
below is that file's rules restated as things a pull request is checked against.

## Running it

```bash
git clone https://github.com/hhhwdt/agent-browser-bridge
cd agent-browser-bridge
node src/setup.js          # reports which layer is missing and what to do about it
node test/test-offline.js  # 12 suites, no browser, no configuration
```

`node test/test-offline.js` is the fastest honest signal you can get. Keep it green.

Suites that need a real browser are separate and need your own setup:

- `node test/test-live.js` — smoke test that uses the bridge's own address as its test bed, no
  configuration needed, but it does open a background tab and close it again.
- `node test/test-basic.js`, `node test/test-editor.js` — need `test-config.js` pointing at a real
  page. `test-editor.js` enters edit mode and makes the site save a draft; do not run it against a
  page that matters.

## The rules this repository holds itself to

- **No dependencies, no build step.** `dependencies: {}` is verified in CI. `node src/server.js` is
  the whole runtime. A user should be able to read the code that runs on their machine.
- **Code comments are Chinese; documentation is English**, with a Chinese README and Chinese
  versions of the user-facing docs. Comments explain intent and record traps, not what the next line
  does.
- **Tests are named for the failure they prevent**, not for the function they call. `test-eval.js`
  is about "runs exactly once"; `test-result-semantics.js` is about "does not report success for
  work that did not happen".
- **Never report success for work that did not happen.** An action that could not do its job must
  come back with `ok: false` and an error code. A caller that sees `ok` has no reason to look again,
  which makes this the most expensive class of bug in the project. It is why
  `test/test-result-semantics.js` exists.
- **The risk rails are part of the interface.** `click` refusing destructive-looking buttons, `type`
  not submitting, and `close` requiring an explicit `tabId` are behaviour, not accidents. They are
  documented in the tool descriptions an agent reads. Do not "fix" them into convenience.
- **Errors should name the next step.** Compare `frames` and `--frameId` hints in `eval` and
  `screenshot`: when an action fails because the target is not where the caller assumed, say where
  to look.

## Changing the extension

`extension/sw/` is where the size is. Three constraints apply, all of which have already been
violated once:

1. **A function in `injected.js` must be self-contained.** `executeScript({ func })` serialises the
   function's own source into the page; module scope does not travel with it. Referencing a helper
   from another module compiles fine, passes review, and throws `ReferenceError` the moment a user
   clicks something. Run `node tools/check-inject-scope.js` after touching `injected.js` — it is
   also part of the offline suite. Note that the checker does not strip comments, so mentioning
   another function's literal name in a comment reads as a reference; reword the comment instead of
   touching the shared checker.
2. **Every injection needs a timeout.** A frozen tab's renderer never returns, and an untimed
   `executeScript` hangs the task and the poll loop with it. Use the helpers in `guards.js`.
3. **A write action must not run in every frame.** `allFrames: true` runs the function in each frame;
   a result picker can only choose which answer to believe, it cannot undo the other clicks. `click`,
   `type` and `key` probe read-only across frames first and then act in the one frame that matched.
   `eval` now injects into a single frame for the same reason.

**Reloading is a deadlock if you get it wrong.** Editing `extension/` has no effect until the
service worker is reloaded, and `node src/cli.js reload` needs a live extension to receive the
command. Deploy a broken service worker and the only way back is clicking reload in
`edge://extensions` by hand. So: keep `node test/test-sw-load.js` green **before** reloading — it
loads the whole module graph with a stub `chrome` and catches the failures that a browser only
reports as "the extension stopped responding".

## Adding an action

An action is described in five places today:

| Where | What you add |
|---|---|
| `extension/sw/actions.js` | the implementation |
| `extension/sw/injected.js` | only if the page needs new code to run in it |
| `extension/sw/background.js` | a case in `runAction` |
| `src/server.js` | an HTTP route, and a name in `CAPABILITIES` |
| `src/mcp.js` | a tool definition and a handler |
| `src/cli.js` + `src/client.js` | a subcommand and a client method, only if it belongs on the CLI |

That is the weakest part of the design, and it is not an accident: the presentations genuinely
differ (the MCP schema needs descriptions, the CLI needs argument parsing). If you see a clean way to
generate three of those from one description, that is a welcome pull request.

## Pull requests

- Run `node test/test-offline.js` and paste nothing — just make sure it passes. CI runs it on Linux
  and Windows, on Node 18/20/22 and 18/22 respectively.
- If you changed behaviour a user can observe, update the README or the relevant file under `docs/`,
  and add an entry under `[Unreleased]` in `CHANGELOG.md`.
- Add a test named for the failure you are preventing. If the shape of the failure is "it said ok
  and did not do it", it belongs in `test/test-result-semantics.js`.
- Do not add a dependency. If you think one is unavoidable, open an issue first and say what it buys.
- Do not reformat or "clean up" code you are not otherwise changing.

## Reporting a bug

Include the output of:

```bash
node src/cli.js diag
```

It reports the extension version and ID, whether the poll loop is running, the boot count, recent
errors, and the origins you have granted. **Redact hostnames you do not want public** — the site
list is your browsing history. If you use `--json`, the output also contains the granted origin list;
strip it.

Say what you expected, what happened, and which browser and version you are on. If the failure is
"the extension does nothing", include whether `diag` shows the poll loop running.

## Security issues

Do not open a public issue. Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability); see [docs/SECURITY.md](docs/SECURITY.md) for the threat model,
including the gaps that are known and not closed. If private reporting is unavailable to you, open an
issue that says only that you have a security report and how to reach you.

## Translations

`README.zh-CN.md`, `docs/QUICKSTART.zh-CN.md` and `docs/DISCLAIMER.zh-CN.md` are translations of the
English files. The English version is authoritative; when the two disagree, the English one is what
the code does. Corrections to a translation are welcome on their own, without touching the English.
