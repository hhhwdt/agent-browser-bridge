# Edge Add-ons submission package

Everything needed to publish to the Edge Add-ons store, which is free (no registration fee) and
where the optional `debugger` permission keeps the justification simple. Chrome Web Store is not
planned; see the README for that argument.

## Before you start

- A Microsoft account with a Partner Center developer account for Edge Add-ons. Registration is
  free. This is the only account the process needs.
- The `debugger` permission is optional since 1.9.0, so the store's permission review covers
  required permissions (`tabs`, `scripting`, `storage`, `alarms`, `downloads`) only.

## Step 1: pack

Zip the **contents** of `extension/` so `manifest.json` sits at the root of the zip, not inside a
folder:

```powershell
Compress-Archive -Path extension\* -DestinationPath agent-browser-bridge.zip -Force   # Windows
# zip -r agent-browser-bridge.zip extension                                          # macOS / Linux, then rename
```

The manifest keeps its `key` field; Chromium derives the published extension ID from it, so the
store version keeps the ID `nbopjoejgialcnmjcefaciebicahjhpp` — the same ID the server allowlist
expects. Verify this after the listing is published; if it ever changes, the user just adds the new
ID in that one line.

## Step 2: upload

1. Sign in at the Edge Add-ons portal (partner.microsoft.com/dashboard/microsoftedge).
2. "Create new extension" → upload the zip.
3. In Overview → submit for review after filling the listing below.

Review is normally days, not hours. The listing is public; price is free; there is no fee at any
step.

## Listing fields

| Field | Value |
|---|---|
| Display name | Agent Browser Bridge |
| Short description | `appDesc` from the manifest (`_locales/en/messages.json`) |
| Long description | see below |
| Category | Developer Tools |
| Language | English (default) |
| Website | the GitHub repo URL |
| Support email | your email |
| Privacy policy | link to `docs/PRIVACY.md` in the repo (raw HTML or rendered GitHub page) |

Long description (copy as-is):

> Agent Browser Bridge lets a local agent you control read and operate tabs in your own browser —
> in the background, without switching tabs or stealing focus. It pairs with a small bridge server
> on your machine (`npm i -g @hhhwdt/agent-browser-bridge`).
>
> - Read page text, links, and frames from tabs you authorise, one site at a time or all sites
> - Click, type, and scroll with a visible cursor and staged confirmation for destructive actions
> - Screenshots, downloads, upload of local files, and media fetching with anti-hotlink headers
> - Site access is denied by default and granted per site from this popup; nothing is authorised at
>   install time
> - No telemetry, no external requests beyond the local bridge and the URLs you ask it to fetch

## Permission justifications

Copy each line into the store's per-permission field. Keep them short; say what the user gets, not
what the API does.

| Permission | Justification |
|---|---|
| `tabs` | Find the tab a request targets, open or close tabs on request, and show which tabs are being operated on. |
| `scripting` | Inject the read/click/type functions into the tab the user addresses. |
| `storage` | Store the site grants, token and error log. |
| `alarms` | Keep the connection to the local bridge alive when the browser suspends the service worker. |
| `downloads` | Save files through the browser's own download stack (`save` action). |
| Optional `cookies` | The `session` action reads cookies of tabs the user has authorised, so the agent can carry an authenticated session. Off until the user grants it. |
| Optional `debugger` | Powers full-page and background-tab screenshots, filling local files into an upload control, and brief per-call media fetching that bypasses CORS. Off until the user grants it. |
| Optional host `http://127.0.0.1:18777/*` | Required to talk to the local bridge server; that is the only required host entry. |

Single-use policy questions: "Does this extension collect or transmit personal data?" No page
content is collected or sent anywhere except to the user's own local bridge and the URLs the user
asks it to fetch. Point to `docs/PRIVACY.md`.

## Screenshots

At least one 1280×800 or 640×480 PNG. Useful set:

1. The popup: bridge online, site list, optional-permissions row.
2. A page being read while the browser stays elsewhere (show the bridge terminal output).
3. The visible cursor on a page during a click/type flow.

## After publication

- Update "no store version" claims if any are left: Chrome has no listing, Edge does.
- Users install from the store like any other extension; no unpacked load needed. The extension ID
  stays the same thanks to the manifest `key`, so the server allowlist keeps working.
- The store version updates only when *you* upload a new zip; the npm package does not auto-update
  it. Draft a note in the CHANGELOG when extension code changes.
