---
phase: quick-260721-bhw
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - extension/content.js
autonomous: true
requirements:
  - BHW-01-stakes-filter-aware-cache

must_haves:
  truths:
    - "After switching the stakes (chip size) filter in the PokerCraft UI, the app renders the full-journey data that matches the newly selected filter, not the first-seen filter's data."
    - "Each distinct filter signature (all query params except from/to) has its own cached whole-journey result; different filters do not share a cache entry."
    - "Repeated session-list requests with the same filter signature reuse the cache without re-fetching chunks."
  artifacts:
    - "extension/content.js contains a filterSignature(url) helper and Map-keyed wholeJourneyCache / wholeJourneyPromise."
  key_links:
    - "fetch + XHR interceptors pass the current intercepted request URL into ensureWholeJourney(url)."
    - "ensureWholeJourney(url) derives a filter signature and, on cache miss, calls fetchWholeJourney(url, sig) using that exact URL as the chunk base so filter params pass through fetchChunks unchanged."
---

<objective>
Fix the "加载全部历史记录" (load all history) feature so it honors PokerCraft's chip-size / stakes filter. Today the merged whole-journey result is cached as a single global singleton and served to every subsequent session-list request, so after the user switches the stakes filter the app keeps showing the first-seen (unfiltered-at-load-time) data.

The fix keys the cache by a normalized filter signature (all query params except from/to) and uses the current intercepted request's own URL as the chunk base, so any filter param the app sends is passed through transparently — no param names hardcoded, no DOM/Angular coupling.

Purpose: Restore correctness of stakes/currency/game-type filtering while keeping the network-layer, zero-dependency, no-build architecture intact.
Output: Modified extension/content.js (single file).
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@extension/content.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Key the whole-journey cache by filter signature</name>
  <files>extension/content.js</files>
  <action>
Introduce per-filter caching so each distinct filter produces its own merged whole-journey result.

1. Add a helper `filterSignature(url)` near the other URL helpers (around isTargetRequest / parseDateRange, ~lines 371-395). It parses `url` against `window.location.origin`, deletes the `from` and `to` search params, sorts the remaining params by key, and returns a stable string of `parsed.pathname + '?' + sortedParams.join('&')`. Wrap in try/catch returning the raw `url` on parse failure. Rationale: any stakes/currency/game-type filter param the app adds is captured automatically without hardcoding param names, and sorting makes the key order-independent.

2. Replace the singleton globals (currently `let wholeJourneyCache = null;` and `let wholeJourneyPromise = null;`, ~lines 417-418) with two Maps: `wholeJourneyCache` (signature → merged result) and `wholeJourneyPromise` (signature → in-flight de-dupe promise), each initialized to an empty Map. Update the adjacent comment to state the cache is keyed per filter signature.

3. Rewrite `ensureWholeJourney` (~lines 450-459) to accept a `url` argument: compute `sig = filterSignature(url)`; if `wholeJourneyCache` has `sig`, return a resolved promise of that entry; otherwise if `wholeJourneyPromise` has no entry for `sig`, start `fetchWholeJourney(url, sig)`, store the promise under `sig`, and on rejection delete the `sig` entry from `wholeJourneyPromise` (allow retry on the next request); return the stored in-flight promise.

4. Change `fetchWholeJourney` (~lines 461-487) to accept `(baseUrl, sig)`: use the passed `baseUrl` (fall back to the existing default session-list URL constant if falsy) as the chunk base handed to `fetchChunks`, so all filter params on that URL pass through unchanged. On success, store the merged result with `wholeJourneyCache.set(sig, merged)` instead of assigning the old singleton. Keep updating `window.__pokercraftWholeJourney`, adding the `signature: sig` field, so the debug object stays usable. Do NOT read the global `lastTargetUrl` inside this function anymore.
  </action>
  <verify>
    <automated>node --check extension/content.js && grep -q 'function filterSignature' extension/content.js && grep -q 'wholeJourneyCache.set' extension/content.js && grep -q 'wholeJourneyCache = new Map' extension/content.js && grep -q 'wholeJourneyPromise = new Map' extension/content.js</automated>
  </verify>
  <done>filterSignature(url) exists; wholeJourneyCache and wholeJourneyPromise are Maps; ensureWholeJourney(url) and fetchWholeJourney(baseUrl, sig) are signature-aware; node --check passes.</done>
</task>

<task type="auto">
  <name>Task 2: Pass the intercepted request URL into ensureWholeJourney</name>
  <files>extension/content.js</files>
  <action>
Wire both interceptors to drive caching by the actual request's filter params.

1. In the fetch interceptor (~line 555), change the call `await ensureWholeJourney()` to `await ensureWholeJourney(url)` — the `url` local computed at the top of the handler already carries the current request's filter params.

2. In the XHR interceptor's async IIFE (~line 612), change `await ensureWholeJourney()` to `await ensureWholeJourney(xhr._pcUrl)` so the exact intercepted request URL (with its current filter params) drives both the signature and the chunk base.

3. Leave the existing `lastTargetUrl` assignments in place (harmless; still used for logging/debug), but confirm nothing in the whole-journey fetch path still depends on that global for the chunk base — it must now come from the argument.

4. Behavior note (no code needed): switching filters now triggers a fresh fetch for the new signature, so the floating status line (`setWjStatus`) will show "⏳ 加载中…" then "✓ 已加载 N 条" again for that filter. This is expected and acceptable — keep the existing Chinese status text.
  </action>
  <verify>
    <automated>node --check extension/content.js && grep -q 'ensureWholeJourney(url)' extension/content.js && grep -q 'ensureWholeJourney(xhr._pcUrl)' extension/content.js</automated>
  </verify>
  <done>Both interceptors pass the current request URL into ensureWholeJourney; node --check passes; no zero-argument ensureWholeJourney call remains at the two interceptor call sites.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| PokerCraft app ↔ PokerCraft API | Existing boundary; the extension already forges DPoP proofs for its own sub-requests. This change adds no new boundary. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-bhw-01 | Tampering | Filter-signature cache key | low | accept | Signature is derived only from the app's own outbound URL params (from/to stripped, remainder sorted). No user-controlled external input, no new network destination, no new package. No dependency install occurs; zero-dependency, no-build architecture unchanged. |
</threat_model>

<verification>
- `node --check extension/content.js` exits 0 after both tasks.
- Code walkthrough confirms: (a) each distinct filter signature caches independently, (b) the current request's URL is the chunk base so filter params pass through fetchChunks, (c) same-signature repeat requests hit the cache.
- Real-world verification is manual (this extension cannot be exercised headless — DPoP-bound, non-extractable key, session-bound token): the user loads PokerCraft in their logged-in Chrome, reloads the extension at chrome://extensions/, clicks 加载全部历史记录, then switches the chip-size/stakes filter and confirms the displayed data changes to match the selected filter.
</verification>

<success_criteria>
- wholeJourneyCache / wholeJourneyPromise are per-signature Maps; filterSignature(url) exists and strips from/to before sorting params.
- Both fetch and XHR interceptors pass the intercepted request URL into ensureWholeJourney.
- fetchWholeJourney uses the passed URL as its chunk base and no longer relies on the global lastTargetUrl.
- No new dependencies, no manifest.json change, no DOM/Angular coupling introduced.
- node --check passes.
</success_criteria>

<output>
Create `.planning/quick/260721-bhw-hands-size-filter/260721-bhw-SUMMARY.md` when done
</output>
