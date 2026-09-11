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
| An extension that has not asked for host access to the bridge | Such a request is cross-origin, so Chrome attaches an `Origin` of `chrome-extension://<id>`; the server checks that ID against an allowlist and answers 403. This is a speed bump, not a wall — see below. |

**Not defended against**

- **Any process running as you.** The bridge has no authentication. A local process can poll
  `/poll`, receive tasks, and call every action. This is by design: a same-user process can read
  your browser profile and its cookies directly anyway, so a token would add friction without
  adding protection. Treat "can run code on this machine as this user" as the trust boundary.
- **Anything that can omit `Origin`.** Requests without an `Origin` header are accepted, because
  that is how local scripts talk to the bridge. Two consequences worth knowing:
  - A page you visit can reach `/health`, trigger a `/tabs` dispatch, and — because `/poll` cannot
    tell callers apart either — hold the poll slot so the next task is delivered to that connection
    instead of the extension. The task cannot be read, but it is consumed and the caller waits for a
    timeout.
  - **An extension that declares host access to `127.0.0.1:18777` looks exactly like the real one**,
    because its fetches stop being CORS requests and Chrome omits `Origin`. It can then drive every
    action, borrowing this extension's `cookies` and `debugger` permissions without ever being
    granted them.

  This is the honest limit of the design: over loopback HTTP, caller identity cannot be established
  without a shared secret, and the extension cannot be given one automatically because extensions
  cannot read files. A token pasted into an options page once would close it; so would moving the
  extension-to-bridge leg onto native messaging, where the browser itself vouches for the extension
  ID. Neither is implemented.
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
- `debugger`-backed actions (screenshot, upload, grab) conflict with DevTools on the same tab.

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
