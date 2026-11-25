# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability)
rather than opening a public issue. If that option is not available, open an issue that says only
that you have a security report and how to reach you; do not put the details in it.

There is no bug bounty. Expect an acknowledgement within a few days.

## Threat model

This tool exists to let a local program drive your own browser with your own session. It is not a
sandbox, and it does not try to protect you from software you chose to run.

**Defended against**

| Attacker | How |
|---|---|
| A web page you visit | The server rejects any request carrying a non-local `Origin`, so a page cannot drive the bridge with `fetch` or a form post. It also cannot read a response or post a task result. |
| A site that has not been granted | The extension checks the origin against the browser's permission store before every injection. Access is denied until you grant it in the popup. |
| Silent operation | Actions mark the tab (badge, favicon dot, title prefix) and show an in-page indicator. There is no unmarked mode. |
| Result spoofing between browsers | A result is only settled when it comes from the browser the task was sent to — the same rule on `/result` and on WebSocket result frames. |
| An extension that has not asked for host access to the bridge | Such a request is cross-origin, so Chrome attaches an `Origin` of `chrome-extension://<id>`; the server checks that ID against an allowlist and answers 403. |
| A second extension that declares host access to `127.0.0.1:18777` | The bridge generates a shared token on first start and requires `X-ABB-Token` on every route. The real extension reads the token from `chrome.storage.local` (pasted in the popup once). A second extension cannot read the token file, so it cannot drive the bridge. |

**Not defended against**

- **Any process running as you.** The shared token closes the "another extension" hole, but a
  local process running as the same user can read the token file from disk. Treat "can run code
  on this machine as this user" as the trust boundary — the token raises the bar from "any
  extension" to "any process that can read your config directory". If you suspect the token was
  copied, rotate it: `node src/cli.js token --rotate` mints a replacement and prints the two
  steps (restart the bridge, re-paste in each browser's popup).
- **A web page you visit.** Pages cannot read the token file. They can still reach `/health`
  and trigger a `/tabs` dispatch, but they cannot poll for tasks or call any action because
  they cannot send `X-ABB-Token`. The WebSocket channel requires the token in its first
  `hello` message too (sent after the upgrade, since a browser WebSocket cannot carry headers),
  and extension IDs must match the server allowlist, so a page cannot enter the task queue by
  connecting to `ws://127.0.0.1:18777/ws`.
- **The user.** Nobody is protected from the operator of the machine.
- **What a leaked token is worth.** `computer_*` actions do not go through the extension: the bridge
  performs them itself under your account — screen capture, mouse and keyboard input into whatever
  window has focus, clipboard writes, and one-shot PowerShell. The same `X-ABB-Token` that drives a
  tab also drives the machine, so a copied token file is no longer "someone can automate your
  browser", it is "someone can run commands and type into your applications". The `force` gate below
  is a guard rail against an agent acting unasked, not a boundary against whoever holds the token.

## Sharp edges

These are documented behaviour rather than vulnerabilities, but they are the parts worth thinking
about before granting anything:

- `eval` executes JavaScript you (or your agent) pass in, in the page's main world. Whatever it can
  do, it will do, once.
- `session` reads cookies including `httpOnly`, and the `cookies` permission applies to every open
  tab once granted, not only to the sites you authorised.
- `upload` sends local files into a page; `download` and `save` write files to disk using the
  browser's download stack.
- `grab` attaches the debugger and injects a permissive CORS header for one origin for the duration
  of a single call, then detaches.
- `debugger`-backed actions (screenshot, upload, grab) conflict with DevTools on the same tab.
- Desktop actions are gated per call, not per session. Closing a window, killing a process, writing
  the clipboard and any shell command outside the read-only allowlist return `confirm_required`
  until the caller passes `force: true`. There is no separate approval UI — the confirmation is the
  caller's responsibility, so only give `computer_*` tools to an agent you would let type on your
  desktop.
- The persistent desktop host keeps C# interop types and screen metrics loaded in a long-lived
  `powershell.exe`. It inherits the bridge's account and token, runs only the fixed capability
  functions from `src/computer/host/lib/`, and exits when the server closes its stdin. A command that
  exceeds its timeout is not cancelled: the host is killed (`taskkill /T /F`) and restarted, and
  in-flight calls fail with `host_restarted`.
- The desktop write lock (`X-ABB-Agent`) prevents two agents from interleaving mouse and keyboard
  input. It is a coordination mechanism, not an authorisation boundary: any caller with the token may
  claim any agent name, and a batch holds the lock for its whole duration, including long shell
  commands inside it.
- `computer_screen` returns whatever is on screen, password managers included. The bytes go back to
  the caller exactly as captured. For unattended deployments, capture a specific window with `hwnd`
  rather than the whole desktop.
- `computer_key` and `computer_type` use SendInput: the focused application cannot tell them apart
  from your own typing.
- `computer_getValue` (through `computer_act`) returns control text, which may include whatever the
  window is showing — account names, paths, message bodies. It is a read, so it takes no write lock
  and is not gated by `force`; treat the output as sensitive.
- UIA element refs are shared state inside host 0, not per-caller capabilities. Any agent holding the
  token can act on a ref another agent obtained, and refs from a finished task remain valid until the
  TTL expires or the control is rebuilt.
- `desktop-policy.json` is an authorisation decision, not a safety net. Putting an action in
  `allowForce` means that agent may do it unattended with no confirmation; putting `computerShell`
  there (without `shellAllow` or with a broad pattern) is equivalent to handing it a shell. Keep the
  file writable only by the account that runs the bridge, and prefer `deny` plus narrow `shellAllow`
  patterns. `deny` cannot be overridden by `force`.
- `requestId` replay stores the full response in memory for 10 minutes, keyed by agent. A response to
  `getValue` or a screen capture is therefore kept in the server process for that window; the store
  is bounded to 200 entries and is not written to disk.

## Keeping a deployment safe

- Leave the port on loopback. Do not expose it to a network.
- Grant site access per site, and revoke when you are done.
- Leave the `cookies` permission off unless you need it.
- Stop the bridge when you are not using it.

## The extension allowlist, and what it is worth

The server rejects `chrome-extension://` origins whose ID is not on its allowlist. The default entry
is the ID derived from the public key in `extension/manifest.json`; the key is what makes that ID the
same for every install from source, so no configuration is normally needed.

What it buys: an extension that has *not* asked for host access to the bridge gets a 403 instead of
control of the browser. What it does not buy: anything that sends no `Origin`, which includes the
real extension, every local program, and any extension that does declare host access to
`127.0.0.1:18777`. Read the not-defended list above before treating this as a boundary.

`--allow-extension <id>` adds an ID, for a build with a different `key` or a packaged build whose ID
was assigned elsewhere. The server prints a one-line warning naming a rejected ID, `node src/cli.js diag`
reports the extension's own `extensionId` and compares it against the allowlist, and `/health` lists
the IDs currently allowed.

Firefox is untested; its `moz-extension://` origins use a different ID scheme and are rejected unless
added explicitly.
