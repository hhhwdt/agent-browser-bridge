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
| Result spoofing between browsers | `/result` rejects a reply from a browser other than the one the task was sent to. |
| An extension that has not asked for host access to the bridge | Such a request is cross-origin, so Chrome attaches an `Origin` of `chrome-extension://<id>`; the server checks that ID against an allowlist and answers 403. |
| A second extension that declares host access to `127.0.0.1:18777` | The bridge generates a shared token on first start and requires `X-ABB-Token` on every route. The real extension reads the token from `chrome.storage.local` (pasted in the popup once). A second extension cannot read the token file, so it cannot drive the bridge. |

**Not defended against**

- **Any process running as you.** The shared token closes the "another extension" hole, but a
  local process running as the same user can read the token file from disk. Treat "can run code
  on this machine as this user" as the trust boundary — the token raises the bar from "any
  extension" to "any process that can read your config directory".
- **A web page you visit.** Pages cannot read the token file. They can still reach `/health`
  and trigger a `/tabs` dispatch, but they cannot poll for tasks or call any action because
  they cannot send `X-ABB-Token`.
- **The user.** Nobody is protected from the operator of the machine.

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
- Debugger-backed actions (screenshot, upload, grab) conflict with DevTools on the same tab. The
  `debugger` permission is optional: nothing attaches until you grant it in the popup, and those
  three actions decline with a clear message before that.

## Keeping a deployment safe

- Leave the port on loopback. Do not expose it to a network.
- Grant site access per site, and revoke when you are done.
- Leave the `cookies` and `debugger` permissions off unless you need them.
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
