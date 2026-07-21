---
phase: quick-260721-bhw
plan: 01
subsystem: extension
tags: [chrome-extension, mv3, content-script, fetch, xhr, caching, pokercraft]

# Dependency graph
requires: []
provides:
  - Per-filter-signature caching for the "加载全部历史记录" (Whole Journey) feature
  - filterSignature(url) helper that normalizes a session-list URL into a from/to-stripped, sorted-param cache key
affects: [extension/content.js whole-journey subsystem]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cache keyed by normalized filter signature (Map<signature, result>) instead of a single global singleton, so any filter param the app adds is respected automatically without hardcoding param names."

key-files:
  created: []
  modified:
    - extension/content.js

key-decisions:
  - "Signature derivation strips only from/to and sorts the rest — no param names hardcoded, so future PokerCraft filter params (new game types, currencies, etc.) are covered without code changes."
  - "The intercepted request's own URL (not a remembered lastTargetUrl global) is now the chunk base, so filter params always match the request that triggered the fetch."

requirements-completed: [BHW-01-stakes-filter-aware-cache]

coverage:
  - id: D1
    description: "filterSignature(url) helper strips from/to and sorts remaining query params into a stable cache key"
    requirement: "BHW-01-stakes-filter-aware-cache"
    verification:
      - kind: other
        ref: "node --check extension/content.js; grep -q 'function filterSignature' extension/content.js"
        status: pass
    human_judgment: false
  - id: D2
    description: "wholeJourneyCache and wholeJourneyPromise are Maps keyed by filter signature instead of singleton globals"
    requirement: "BHW-01-stakes-filter-aware-cache"
    verification:
      - kind: other
        ref: "grep -q 'wholeJourneyCache = new Map' / 'wholeJourneyPromise = new Map' extension/content.js"
        status: pass
    human_judgment: false
  - id: D3
    description: "ensureWholeJourney(url) and fetchWholeJourney(baseUrl, sig) are signature-aware; fetch and XHR interceptors pass the intercepted request's own URL"
    requirement: "BHW-01-stakes-filter-aware-cache"
    verification:
      - kind: other
        ref: "grep -q 'ensureWholeJourney(url)' and 'ensureWholeJourney(xhr._pcUrl)' extension/content.js"
        status: pass
    human_judgment: false
  - id: D4
    description: "After switching the stakes/chip-size filter in PokerCraft's UI, the displayed data matches the newly selected filter (not the first-seen filter's cached data)"
    verification: []
    human_judgment: true
    rationale: "This extension cannot be exercised headless (DPoP-bound, non-extractable key, session-bound token per CLAUDE.md). Real-world confirmation requires the user's own logged-in Chrome session: reload the extension, click 加载全部历史记录, then switch the stakes filter and confirm the data changes."

# Metrics
duration: 6min
completed: 2026-07-21
status: complete
---

# Quick Task 260721-bhw: Filter-Signature-Aware Whole-Journey Cache Summary

**Whole-journey cache in extension/content.js is now keyed by a normalized filter signature (Map, from/to stripped and remaining params sorted) instead of a single global singleton, so switching the stakes/currency/game-type filter fetches and renders that filter's own data.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-21T08:22:00-07:00
- **Completed:** 2026-07-21T08:22:42-07:00
- **Tasks:** 2 completed
- **Files modified:** 1

## Accomplishments
- Added `filterSignature(url)` helper: parses the URL, deletes `from`/`to`, sorts the remaining params, and returns a stable `pathname + '?' + sortedParams` string (try/catch falls back to the raw URL on parse failure).
- Replaced the singleton `wholeJourneyCache` / `wholeJourneyPromise` globals with `Map`s keyed by filter signature, so each distinct filter (stakes, currency, game type) gets its own cached merged result and its own in-flight de-dupe promise.
- Rewrote `ensureWholeJourney(url)` to derive the signature from the passed URL, check the cache Map, and start/reuse a per-signature in-flight fetch (deleting the promise entry on rejection to allow retry).
- Rewrote `fetchWholeJourney(baseUrl, sig)` to use the passed `baseUrl` (falling back to the existing default URL constant) as the chunk base for `fetchChunks`, so all filter params on the intercepted request pass through unchanged to every chunk request. It now stores results via `wholeJourneyCache.set(sig, merged)` and adds `signature: sig` to the `window.__pokercraftWholeJourney` debug object. It no longer reads the global `lastTargetUrl`.
- Wired both interceptors: the fetch handler now calls `ensureWholeJourney(url)` using its already-computed `url` local, and the XHR handler's async IIFE now calls `ensureWholeJourney(xhr._pcUrl)` using the exact intercepted request URL. Both drive the cache signature and the chunk base from the actual in-flight request rather than a remembered global.

## Task Commits

Each task was committed atomically:

1. **Task 1: Key the whole-journey cache by filter signature** - `9cd7ade` (feat)
2. **Task 2: Pass the intercepted request URL into ensureWholeJourney** - `78e1b2f` (fix)

_No plan-metadata commit included per orchestrator instruction — docs artifacts are committed separately by the orchestrator._

## Files Created/Modified
- `extension/content.js` - Added `filterSignature(url)`; converted `wholeJourneyCache`/`wholeJourneyPromise` to per-signature `Map`s; made `ensureWholeJourney`/`fetchWholeJourney` signature-aware; wired both fetch and XHR interceptors to pass the intercepted request's URL.

## Decisions Made
- Kept the existing `lastTargetUrl` assignments in the interceptors (still used for logging/debug) but confirmed the whole-journey fetch path no longer depends on that global for its chunk base — it now comes exclusively from the `ensureWholeJourney(url)` argument, per the plan's explicit instruction.
- Left the Chinese status-line text (`⏳ 加载中…`, `✓ 已加载 N 条`, etc.) unchanged; switching filters now re-triggers this same sequence for the new signature, which is expected per the plan's behavior note.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required. Real-world verification is manual per CLAUDE.md/plan `<verification>`: this extension cannot be exercised headless (DPoP-bound, non-extractable key, session-bound token). The user must reload the extension at `chrome://extensions/`, click `📥 加载全部历史记录` in their logged-in PokerCraft session, then switch the chip-size/stakes filter and confirm the displayed data changes to match the selected filter.

## Next Phase Readiness
- `extension/content.js` whole-journey subsystem now respects any filter param PokerCraft's UI sends (stakes, currency, game type) without hardcoded param names or DOM/Angular coupling.
- No new dependencies, no `manifest.json` changes.
- Manual real-world confirmation (stakes filter switch) is the only remaining verification step, and is out of scope for this automated executor per CLAUDE.md's "cannot be exercised in headless automation" constraint.

---
*Phase: quick-260721-bhw*
*Completed: 2026-07-21*

## Self-Check: PASSED
- FOUND: extension/content.js
- FOUND: 9cd7ade (Task 1 commit)
- FOUND: 78e1b2f (Task 2 commit)
- FOUND: .planning/quick/260721-bhw-hands-size-filter/260721-bhw-SUMMARY.md
