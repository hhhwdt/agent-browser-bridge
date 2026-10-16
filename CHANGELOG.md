# Changelog

Notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

1.7.0 is the first version prepared for distribution. Earlier version numbers (1.4.x–1.6.x) were
development iterations of a tool that was not published; their changes are not itemised, because
reconstructing them from the code alone would be guesswork.

## [Unreleased]

Eight defects that all had the same shape: the tool reported success for work that did not happen.

### Fixed

- The extension registered its boot block twice, so `bootstrap()` ran twice per service-worker
  start and `diag`'s "SW starts" counter doubled — the counter used to judge whether the worker is
  being recycled.
- `links --selector` returned `ok` with zero links when the selector matched nothing, because the
  page-side `selector_not_found` error was dropped on the way out. `linksInPage` also never reported
  `selectorMatched`, so the frame scorer fell back to the first frame and links inside an `iframe`
  could not be found at all.
- `grab` reported `ok` for a download that was interrupted, and for one that never registered. `save`
  already returns `error: 'interrupted'` for the first case.
- `unmarkTask` counted promise rejections, which `removeBadge` and `hideIndicator` never produce, so
  the "N tabs did not respond" note never appeared and marks left behind in a frozen tab were never
  reported.
- `session --key` returned a single value before the 4000-character truncation ran, so one large key
  came back whole.
- `eval` injected with `allFrames`, so side-effecting code ran once per frame while only one result
  was reported — the rule `click`, `type` and `key` already follow.
- `screenshot --selector` measured an element inside an `iframe` in that frame's own coordinates and
  used them as the CDP clip, cropping the wrong region. Sub-frames now measure through
  `DOM.getFrameOwner` / `DOM.getBoxModel`, whose coordinates are already relative to the main frame;
  when the frame cannot be measured, the action reports `element_not_found` instead of a wrong crop.
- `waitForTabUrl` accepted a prefix match, so navigating to a URL that the current address merely
  extends returned the pre-navigation URL.

### Added

- `test/test-result-semantics.js`: 41 assertions covering the eight fixes above, so silent success
  cannot come back unnoticed. `test/test-sw-load.js` also asserts the extension boots exactly once.
- `tools/check-package.js`: fails if the tarball contains a file git does not track. `npm pack`
  includes `README*` no matter what `.gitignore` or `files` say, which is how a local ops document
  full of absolute paths would have been uploaded.
- `tools/check-version.js`: `package.json` and `extension/manifest.json` must carry the same version.
- Windows CI job, a tag-triggered release workflow, `prepublishOnly` gating the offline suite,
  CONTRIBUTING, this changelog, issue and pull-request templates.
- Errors that point at the next step: `eval` and `screenshot` name `frames` / `--frameId` when the
  target is not in the main frame; `links` names `frames` when a selector matches nothing.

## [1.7.0] - 2026-10-15

### Changed

- `extension/` split into `extension/sw/` by responsibility: `injected.js` (page functions),
  `guards.js` (timeouts, frame selection, permissions), `config.js`, `marks.js`, `actions.js`,
  `background.js`.
- Tests moved to `test/`, the source-level checkers to `tools/`, and the repository root now holds
  only `README*`, `LICENSE`, `CHANGELOG.md` and `package.json`.
- `src/setup.js` walks every setup step and reports which one is missing.

### Added

- Offline test suite, runnable with no browser and no configuration, plus CI on Node 18, 20 and 22.
