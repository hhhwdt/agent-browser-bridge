# Privacy

Agent Browser Bridge collects nothing and sends nothing to the author or to any third party. There
is no telemetry, no analytics, no crash reporting, no account, and no server operated by this
project.

The short version: **everything stays on your machine, and it only leaves your browser when a
program on your machine asks for it.** That program is the point of the tool, so read the rest with
that in mind.

## What the extension reads

Only when a local program sends it a request, and only for the tab that request names:

- page content: text, links, HTML structure, frame layout, screenshots
- page state: an element's position, computed style, or the result of JavaScript the caller supplies
- storage: cookies (including `httpOnly`) and localStorage / sessionStorage, only if you granted the
  optional `cookies` permission
- tab metadata: titles, URLs, favicon, discarded state

No page is read in the background, on a timer, or because a page loaded. Nothing is read from a tab
the caller did not target.

## Where the data goes

To the local program that asked for it, over `127.0.0.1`. That is the entire data flow. Nothing is
sent to the internet, and nothing is uploaded by this project.

The bridge requires a shared token, so a second extension cannot drive it. However, a local
process running as the same user can read the token file from disk. See [SECURITY.md](SECURITY.md).

## What is stored, and where

| What | Where | Lifetime |
|---|---|---|
| Marked tab IDs (so marks can be cleared later) | `chrome.storage.local` | until the tab closes or you clear marks |
| Service worker boot count and timestamp (diagnostics) | `chrome.storage.local` | until you remove the extension |
| Last 25 runtime errors (returned by the `diag` action) | `chrome.storage.session` | until the browser closes |
| Site grants and the optional `cookies` grant | the browser's own permission store | until you revoke them in the popup |
| In-flight tasks and results | the bridge process's memory | until the task completes or times out |
| Startup lines | `logs/browser-bridge.log`, if you started the server with `restart-server.ps1` | until you delete the file |
| Shared token | `%APPDATA%\agent-browser-bridge\token` (Windows) or `~/.config/agent-browser-bridge/token` | until you delete the file |
| Audit log (action metadata only) | `%APPDATA%\agent-browser-bridge\audit.jsonl` (Windows) or `~/.config/agent-browser-bridge/audit.jsonl` | rotates at 10 MB |
| Update check cache | `%APPDATA%\agent-browser-bridge\update-check.json` (Windows) or `~/.config/agent-browser-bridge/update-check.json` | 24 hours |
| Files you download or save | your browser's download folder | until you delete them |

Page content is never written to disk by the extension or the server. Results are held in memory
only while a request is in flight.

## Permissions and why they exist

| Permission | Why |
|---|---|
| `tabs` | find the tab a request targets, and open or close tabs |
| `scripting` | inject the read/click/type functions into that tab |
| `storage` | the mark list and error log above |
| `alarms` | keep the service worker polling after the browser suspends it |
| `debugger` (optional, off by default) | screenshots, putting files into an upload control, and fetching media that blocks CORS |
| `downloads` | saving files through the browser's download stack |
| `cookies` (optional, off by default) | the `session` action |
| host permission for `127.0.0.1:18777` | talking to the local bridge |
| site access (optional, granted per site) | reading and operating a page at all; denied until you grant it |

## Changes

Material changes to this file will be described in the repository's commit history.
