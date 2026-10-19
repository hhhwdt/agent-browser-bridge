# Quickstart

From nothing to an agent driving your browser. Six steps, one of which is a click you have to make
yourself.

[简体中文](QUICKSTART.zh-CN.md) · English

---

## Before you start

- **Node.js 18 or newer.** The bridge and the MCP server both run on Node and have no dependencies.
- **Chrome, Edge, or another Chromium browser.**
- Read [DISCLAIMER.md](DISCLAIMER.md) first. Short version: anything on this machine that can reach
  the bridge port can act in your browser with your logged-in session, including while you are not
  watching.

## 1. Get the code

```bash
git clone https://github.com/hhhwdt/agent-browser-bridge.git
cd agent-browser-bridge
```

## 2. Run the self-check

```bash
node src/setup.js
```

It walks the layers — Node, the bridge, the extension, site grants, the MCP registration — and says
which one is missing and what to do next. Run it again after each step below; it is idempotent. The
last thing it does is open a background tab, read it and close it, so a clean run means the whole
path works. It only reads: where a command is needed it prints it rather than changing your
configuration.

## 3. Load the extension

- Chrome: `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked** → pick
  this repo's `extension/` folder.
- Edge: `edge://extensions` → **Developer mode** → **Load unpacked** → same folder.

The extension appears with a puzzle-piece icon. Pin it to the toolbar if you like.

> There is no extension-store listing, and there will not be one: the tool needs the `debugger`
> permission, runs code that a local program supplies at runtime, and asks for site access — a
> combination store policies treat as remote code execution and remote control. Loading unpacked is
> the supported path.

## 4. Grant the sites you want it to work on

Click the extension icon. Nothing is authorised yet — this is the step no program can do for you,
because the browser requires a real click from you.

- Type a hostname (e.g. `confluence.example.com`) and press **授权 / Grant**, or
- Press **授权所有站点 / Grant all sites** if you would rather not repeat this.

Optional: if you need the `session` tool (reading cookies and web storage), press **授予 / Grant** in
the "optional permissions" row. Leave it off otherwise.

## 5. Paste the bridge token

The bridge generates a shared token on first start. The extension needs it to prove its identity.

1. Find the token file (the bridge prints its path on start):
   - Windows: `%APPDATA%\agent-browser-bridge\token`
   - macOS/Linux: `~/.config/agent-browser-bridge/token`
2. Copy the token (64-character hex string).
3. Paste it into the "Bridge token" field in the extension popup and press **保存 token / Save token**.

Or run `node src/cli.js token --show` to print the token.

## 6. Add the MCP server

From the repository root — the shell fills in the path, so there is nothing to type or hard-code:

```bash
claude mcp add -s user browser -- node "$PWD/src/mcp.js"      # macOS, Linux, Git Bash
claude mcp add -s user browser -- node "%CD%\src\mcp.js"      # Windows cmd
```

`-s user` means every project gets it, not just this folder. For a different MCP host, or if you
would rather not touch your global config, a project `.mcp.json` works too, with a relative path:

```json
{
  "mcpServers": {
    "browser": { "command": "node", "args": ["src/mcp.js"] }
  }
}
```

`node src/setup.js --install` does the registration for you if you prefer, and falls back to
printing the manual command.

You do **not** need to start the bridge service. The MCP server starts it on first use if the port
is dead, and leaves it running afterwards.

## 7. Check it works

Ask the agent to call `browser_status`. It should come back with the online browsers and the
extension version. Then ask for something real:

> List my open tabs, then read the one whose URL contains `confluence` and summarise it.

If the agent reports `extension_not_connected`, the extension is not loaded or not enabled.
If it reports `permission_denied`, step 3 did not cover that site.

## 8. Tell it how to behave

The MCP server sends its own working rules when an agent connects (list tabs first, open new tabs in
the background, close what you opened, clear marks when done, ask before irreversible actions). You
do not need to repeat those in your prompt. What is still worth saying is what *you* want: which
sites it may touch, and what counts as an action it must ask about first.

---

## When something is wrong

```bash
node src/mcp.js --list-tools     # the tool list and their required arguments
node test/test-offline.js         # 9 suites, no browser, no configuration — the fastest signal
node test/test-live.js            # opens a background tab and exercises the real browser
node src/cli.js diag            # extension version, id, connection, recent errors
```

| Symptom | Cause |
|---|---|
| `bridge_unavailable` | Port 18777 is dead and could not be started. Run `node src/server.js` to see why. |
| `extension_not_connected` | The extension is not loaded, or is loaded in a different browser profile. |
| `permission_denied` | That site was never granted. Step 3. |
| `permission_not_granted` | The `session` tool needs the optional `cookies` permission. |
| `token_required` | The bridge is running but the extension has no token. Paste the token into the popup (step 5). |
| `tab_unresponsive` | That tab's renderer is frozen. Run `activate` then retry, or use `--auto-activate`. |
| Everything times out | Check `node src/cli.js diag` — most often the wrong browser or a dead extension. |

## What is where

| File | What it is |
|---|---|
| `extension/` | the browser extension (MV3) |
| `src/server.js` | the local bridge, `127.0.0.1:18777`, no dependencies |
| `src/mcp.js` | the MCP server — this is what your agent talks to |
| `src/client.js` | client library, if you would rather call the bridge from your own code |
| `src/cli.js` | the same thing from the command line |
| `scripts/` | Windows helpers: autostart at logon, start/restart the bridge |
| `test/` | see [README](../README.md#testing) for which need a browser |

---

## Handing it to someone else

Four things, in order. **Two cannot be automated**: the browser insists that loading an extension
and granting a site are done by a human click. That is the browser's security model, not a shortcut
this tool skipped.

1. **They get the code.** `git clone https://github.com/hhhwdt/agent-browser-bridge.git`, or send
   them the folder as a zip.
2. **They load the extension.** `chrome://extensions` (or `edge://extensions`) → developer mode →
   load unpacked → the `extension/` folder. Their click, not yours.
3. **They grant the sites** they want an agent to touch, from the extension popup.
4. **Register the MCP server.** `node src/setup.js --install` does it and prints the manual command
   if it cannot.

Then have them run `node src/setup.js`: it checks all four layers and names the one that is missing.

Two things worth saying up front, because both surprise people:

- **The extension is not in a store, and will not be.** Chrome nags about developer-mode extensions
  at every start. That is the price of the `debugger` permission plus executing code a local program
  supplies at run time — a combination store review treats as remote code execution and remote
  control.
- **It drives their real, logged-in browser.** Anything they are signed into is reachable by whatever
  local program can reach the bridge port. [DISCLAIMER.md](DISCLAIMER.md) is short; send it along.

For a version with **no path anywhere**, publish to npm first: they then run
`npm i -g agent-browser-bridge` and use the command names — `agent-browser-bridge` for the bridge,
`agent-browser-bridge-setup` for the self-check above, `agent-browser-bridge-mcp` for step 4 — with
no clone and no path to copy. The package carries `extension/`, so step 2 still works: the
self-check prints the folder to load.
