# Agent Browser Bridge

Let local agents drive your **already-open browser** — in the background, without stealing focus.

A browser extension plus a tiny local server. Agents can read pages, click, type, and wait for UI
across every tab you already have open — including background tabs — while you keep working in
another window. Nothing pops up, nothing steals focus, no mouse movement.

```
┌─────────────┐   HTTP    ┌──────────────┐  long-poll  ┌────────────────┐
│  any agent  │ ────────▶ │  server.js   │ ──────────▶ │   extension    │
│ (CLI / SDK) │ ◀──────── │ 127.0.0.1    │ ◀────────── │ chrome.scripting│
└─────────────┘           └──────────────┘             └────────────────┘
                                                              │
                                                              ▼
                                                    your real browser session
                                                    (logged in, all tabs)
```

## Why

Most browser automation launches a *fresh* browser: no logins, no cookies, no extensions, and a
visible window. That breaks the moment a page needs SSO.

This project does the opposite. It attaches to the browser you already use, so every page is
already authenticated. Operations run through `chrome.scripting.executeScript`, which:

- never activates or switches tabs,
- never moves the mouse or sends synthetic keystrokes,
- works on **background tabs**,
- and is therefore completely invisible to whatever you are doing.

It also handles the awkward realities of real sites: cross-frame editors (TinyMCE inside an
`iframe`), `designMode` documents, lazy-mounted UI, and framework click handlers bound to
`mousedown` rather than `click`.

## Features

| Capability | Notes |
|---|---|
| `read` | Page text, auto-detects the main content region or a WYSIWYG editor frame |
| `links` | Enumerate anchors with index, text and href |
| `click` | Links, and buttons with **risk-based auto-allowance** |
| `type` | Inputs, textareas, `contenteditable`, and `designMode` editors |
| `key` | Synthetic key events for in-page handlers |
| `navigate` | Background tab, waits for the URL to actually commit |
| `wait` | Wait for an element/text to appear or disappear |
| `frames` | Diagnose which frame holds the editor and how it is editable |
| `tabs` / `mark` / `unmark` / `close` | Tab management with a visible "agent is working here" marker |
| `activate` | Bring a tab to the foreground; wakes a frozen tab so it can be injected |
| `diag` | Extension runtime diagnostics: version, polling, SW restarts, errors |
| Multi-browser | Chrome and Edge run side by side, fully isolated, with automatic routing |

### Advanced capabilities

| Capability | Permission | Notes |
|---|---|---|
| `eval` | — | Run JavaScript in the page and get the result back |
| `download` | — | Fetch a URL with the page's login state and return the bytes as base64 |
| `session` | `cookies` (**optional**) | Read the tab's cookies (including httpOnly) plus localStorage/sessionStorage |
| `screenshot` | `debugger` (**required**) | Element / full-page / background-tab capture via CDP |
| `upload` | `debugger` (**required**) | Put local files into a file input via CDP `DOM.setFileInputFiles` |
| `save` | `downloads` (**required**) | Save a URL to disk through the browser's own download stack |

### `save` vs `download`

Both fetch a URL, but they are different tools and the distinction matters:

| | `save` | `download` |
|---|---|---|
| Mechanism | `chrome.downloads.download()` — browser download stack | `fetch()` **inside the page** |
| CORS | **not applicable** | subject to CORS; cross-origin CDNs usually block it |
| Size limit | none | `DOWNLOAD_MAX_BYTES` (20 MB) |
| Bytes travel | straight to disk | through the bridge as base64 |
| Destination | browser download dir (`filename` picks a relative subpath) | any path you choose |
| `blob:` URLs | no | no |

So for media (images, video) use `save`; for "give me the bytes so I can process them" (a CSV
export, a JSON API behind SSO) use `download`.

```bash
# absolute URL
node read.js save --url "https://cdn.example.com/clip.mp4" --filename "clips/clip.mp4"

# relative URL — resolved against the matched tab's own URL
node read.js save --match "example.com/gallery" --url "/media/photo-01.jpg"
```

`save` waits for the download to finish and reports the real on-disk path, so you can tell the user
where the file landed. Same-name files are renamed rather than overwritten unless you pass
`--overwrite`. One caveat: Chrome may adjust the extension to match the server's `Content-Type`
(e.g. a `.md` served as `text/plain` is saved as `.txt`).

Two notes on permissions, both learned from Chrome's own behaviour:

- `debugger` **cannot** be declared as an optional permission — Chrome reports
  *"Permission 'debugger' cannot be listed as optional. This permission will be omitted."* and then
  drops it, so it has to be a required permission. It is what enables `upload` and CDP screenshots,
  and Chrome will show an install-time warning for it. While the debugger is attached the browser
  also shows its "started debugging this browser" infobar; that is expected.
- `cookies` **can** be optional, so it is: `session` stays off until you grant it from the popup,
  and returns `permission_not_granted` until then. Everything else keeps working.

## Requirements

- Node.js 18+
- Chrome or Edge (Chromium 102+; MV3)

## Install

**1. Start the bridge**

```bash
node server.js          # listens on 127.0.0.1:18777 only
```

On Windows you can use the helper script instead:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-server.ps1
```

**2. Load the extension**

- Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/`
- Edge: `edge://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/`

**3. Grant site access**

Nothing is authorized by default. Click the extension icon and grant the sites you want it to
operate on — either one hostname at a time, or "authorize all sites".

The extension requests no host permission up front; access is granted through the browser's own
permission prompt, so you stay in control.

The same popup has a **授予 / Grant** button for the optional `cookies` permission. Requesting a
permission that the manifest does not declare as optional throws
*"Only permissions specified in the manifest may be requested"*, so the popup only ever asks for
`cookies`.

At install time Chrome will warn about `debugger` (required, for `upload` and CDP screenshots).
The host permissions are still denied by default — no site access is granted until you approve it.

## Usage

### CLI

```bash
node read.js tabs
node read.js read  --match "example.com/page"
node read.js links --match "example.com/page"
node read.js click --match "example.com/page" --text "Next page"
node read.js type  --match "example.com/page" --value "hello"
node read.js wait  --match "example.com/page" --selector "#editor"
node read.js navigate --url "https://example.com/other"

# advanced (need opt-in permissions)
node read.js eval       --match "example.com/page" --code "document.title"
node read.js screenshot --match "example.com/page" --out shot.png --selector "table"
node read.js session    --match "example.com/page" --name SESSION
node read.js upload     --match "example.com/page" --file /path/to/report.pdf
node read.js download   --match "example.com/page" --url "/export.csv" --out data.csv
```

### Client library

Zero dependencies, no CLI needed:

```js
const { createClient } = require('./client.js');

const ab = createClient();                       // 127.0.0.1:18777
if (!(await ab.isReady())) await ab.waitUntilReady(15000);

const page = await ab.read({ match: 'example.com' });
console.log(page.text);

await ab.click({ match: 'example.com', text: 'Next page' });
await ab.wait({ match: 'example.com', selector: '#loaded' });
```

### HTTP

Every capability is a plain endpoint, so any language or tool can drive it:

```
GET  /health                 service status, apiVersion, capabilities, connected browsers
GET  /tabs?browser=edge
POST /read     { match | url | tabId, selector?, includeLinks?, frameId? }
POST /links    { match | url | tabId, selector?, text?, frameId? }
POST /click    { match | url | tabId, selector | text | href, index?, allowNonLink?, dryRun? }
POST /type     { match | url | tabId, value, selector?, method?: text|html, clear? }
POST /key      { match | url | tabId, key, selector?, ctrl?|shift?|alt? }
POST /navigate { url, newTab?, active?, match? | tabId? }
POST /wait     { match | url | tabId, selector | text, state?: appear|disappear, timeoutMs? }
POST /frames   { match | url | tabId }
POST /mark     { match | url | tabId, text? }
POST /unmark   { match | url | tabId, all? }
POST /close    { tabId }
POST /reload
```

Call `/health` first and check `apiVersion` and `capabilities` — that is the contract for
forward compatibility.

## Click safety

Automation should not be able to destroy data by accident. Non-link elements are classified:

| Element | Label | Behavior |
|---|---|---|
| `<a href>` | any | allowed |
| button-like | 编辑 / 插入 / Cancel / … | **allowed** — no flag needed |
| button-like | 删除 / 提交 / Publish / Save / … | **blocked** — requires `allowNonLink: true` |
| other (container `div`) | any | blocked — requires `allowNonLink: true` |

Use `dryRun: true` to get the classification (`isLink`, `isButtonLike`, `destructive`, `blocked`)
**without clicking anything** — useful for an agent to decide before acting.

Risk classification is a guardrail against accidents, not a substitute for asking the user before
irreversible or shared-document actions.

## Seeing which tabs are being operated on

Two markers are applied to every tab an agent touches, so you can tell at a glance which pages
are in use:

1. **Favicon dot** — the site's icon is redrawn on a canvas with a colored dot composited into the
   corner, and written back to every `<link rel="icon">`. The dot is colored by operation type
   (read = blue, click = green, type = amber, navigate = purple).
2. **Title prefix** — a `🤖 ` prefix is added to the tab title.

Marks are cleared three ways:

1. **Automatically** — the injected page code schedules its own cleanup (3 minutes by default).
   This matters because a frozen background tab cannot be injected into: a page-side timer fires
   as soon as you switch back to that tab, so marks never become permanent residue.
2. **From the toolbar** — click the extension icon and press **清除所有标记**.
3. **From the CLI**:

```
node read.js mark   --match "example.com/page" --text "processing"
node read.js unmark --match "example.com/page"
node read.js unmark                      # clear all
```

Pass `ttlMs` to `mark` to change the auto-expire window (`0` = never expire).

Note on the favicon: the link's `type` attribute **must** be updated to `image/png` when swapping
in a PNG data URL. Leaving it as `image/x-icon` makes the browser fail to decode it and silently
fall back to the original icon.

## Frozen tabs

Browsers freeze long-idle background tabs. A frozen renderer does not respond to
`chrome.scripting.executeScript`, so operations against it hang. The bridge handles this in two
ways:

- Every injection is wrapped in a timeout, so an unresponsive tab fails fast with
  `tab_unresponsive` instead of hanging the task (and, before this, the whole polling loop).
- `activate` brings the tab to the foreground, which wakes it. Use it when a tab must be operated
  on and `read`/`click`/`type` keep returning `tab_unresponsive`:

```
node read.js activate --match "example.com/page"
```

`activate` changes what the user is looking at, so it is a disruptive operation — call it only
when needed, and restore the previously active tab afterwards if the user was working elsewhere.

## Frame handling

WYSIWYG editors commonly live in an `iframe`, and older ones (TinyMCE) mark the document
`designMode = 'on'` instead of using a `contenteditable` attribute. Injections therefore run
across all frames and pick the best result by scoring:

1. the frame matching an explicitly requested `selector`,
2. an editable frame (where the editor lives),
3. otherwise the frame with the most text.

If a page is ambiguous, run `frames` to see every frame's id, editability and size, then pass
`frameId` explicitly.

## Multi-browser isolation

Chrome and Edge each maintain their own long-poll connection and task queue. A task carries its
target browser and the extension rejects anything addressed elsewhere, so one browser can never
execute another's work. When you do not specify a browser, the bridge tries each connected browser
in turn and uses the one that actually contains the matching tab.

## Security model

- Binds to `127.0.0.1` only. No LAN or internet exposure.
- Validates the `Origin` header and rejects requests from ordinary web pages, preventing a
  malicious site from driving the extension via CSRF.
- Site access is enforced by the browser's permission system and is **denied by default**. The
  install manifest requests no host permissions beyond the local bridge.
- **Cookie access is opt-in and off by default.** `session` needs the `cookies` permission, which is
  declared as *optional* and only requested when you press the button in the popup. Until granted it
  fails with `permission_not_granted`.
- **`debugger` is a required permission**, because Chrome forbids it being optional. It powers
  `upload` and CDP screenshots, and shows up as an install-time warning. If you do not want the
  extension holding it, remove those two actions — nothing else depends on it.
- Read operations have no side effects. Write operations are risk-classified and logged back to the
  caller with what was actually clicked or typed.
- No telemetry and no external network calls. The only outbound request is `download`, which fetches
  the URL *you* pass, with the tab's login state; `eval` runs the code *you* pass.
- Because `eval`, `session` and `download` hand you powerful primitives, treat anything that can
  reach the local bridge (any local process) as able to use them once granted. Bind carefully and do
  not expose port 18777 beyond loopback.
- `type` with `method: 'html'` sanitizes input: strips `script`/`iframe`/`style`, `on*` handlers and
  `javascript:` URLs.

## Testing

```bash
cp test-config.example.js test-config.js   # then edit it

node test-basic.js          # 33 assertions: reads, writes, routing, errors
node test-multibrowser.js   # 12 assertions: Chrome/Edge isolation (needs both)
node test-interaction.js    # 10 assertions: click classification + wait (dry-run only)
node test-editor.js         # WYSIWYG editor path (enters edit mode; creates a draft)
```

Tests operate on a page you configure, create and close their own tabs, and leave your active tab
untouched.

> `test-editor.js` enters the page's edit mode, which makes the site auto-save a draft. Point it at
> a scratch page, not production content.

## Project layout

```
extension/            MV3 extension (Chrome + Edge)
server.js             local bridge server (no dependencies)
client.js             reusable client library
read.js               CLI wrapper around client.js
test-*.js             test suites
start-server.ps1      Windows helper
restart-server.ps1    Windows helper (reload server changes)
```

## Limitations

- The browser must be running with the extension enabled.
- A page must have been loaded at least once; never-rendered content cannot be read.
- `key` dispatches synthetic events — they trigger in-page handlers but do not produce text and
  cannot trigger browser-level shortcuts. Use `type` for text.
- Editing UIs that only mount when the tab is visible require the tab to be foregrounded once.
- Not affiliated with any browser vendor; uses only documented extension APIs.

## License

MIT — see [LICENSE](LICENSE).
