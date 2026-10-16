## What this changes, and why

<!-- The why matters more than the what: the diff already shows the what. -->

## How I verified it

<!-- The command you ran and what it printed. "node test/test-offline.js passes" is enough for most
     changes; anything touching extension/ needs more than that, because the offline suite cannot
     see the browser. -->

## Checklist

- [ ] `node test/test-offline.js` passes.
- [ ] If I changed `extension/`: `node test/test-sw-load.js` was green **before** I reloaded, and I
      reloaded it to confirm the change behaves in a real browser.
- [ ] New behaviour is covered by a test named for the failure it prevents. Failures of the shape
      "it said ok and did not do it" belong in `test/test-result-semantics.js`.
- [ ] No new dependencies (`dependencies` in package.json is still empty).
- [ ] User-visible behaviour changes are reflected in `README.md` or the relevant file under `docs/`,
      and there is an entry under `[Unreleased]` in `CHANGELOG.md`.
- [ ] I did not reformat or clean up code I was not otherwise changing.

## Related issues

<!-- Fixes #123, or "no issue". -->
