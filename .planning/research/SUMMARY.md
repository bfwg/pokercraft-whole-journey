# Project Research Summary

**Project:** Pokercraft Date Range Unlocker
**Domain:** Chrome MV3 Extension — API Interception & Request Splitting
**Researched:** 2026-04-22
**Confidence:** MEDIUM-HIGH

## Executive Summary

This project is a minimal Chrome MV3 extension that removes Pokercraft's 3-month date range restriction by intercepting API calls, splitting large date ranges into 25-day chunks, and merging responses transparently. The entire solution lives client-side in ~3 files of vanilla JavaScript with zero build tooling, zero dependencies, and zero backend. Experts build this type of extension using MAIN world script injection (`"world": "MAIN"` in manifest) to monkey-patch `window.fetch`/`XMLHttpRequest` before the Angular app boots.

The recommended approach is straightforward: inject a MAIN world script at `document_start` that patches fetch, splits date ranges into 25-day windows, fires sub-requests using the original fetch (letting the app's own DPoP interceptor generate valid tokens naturally), decrypts/merges responses, and returns a synthetic Response to the app. The date picker restriction is handled separately via DOM-level patching with MutationObserver.

The key risk is **DPoP token acquisition**. Each sub-request needs a valid DPoP proof signed with the session's ephemeral ES256 keypair. The preferred strategy — letting the app's own DPoP interceptor fire naturally when calling `originalFetch()` — depends on how the Angular app attaches DPoP headers. If DPoP is pre-computed or attached at a different layer, you'll need to locate and hook the generation function at runtime. This must be validated first; everything else is low-risk.

## Key Findings

### Recommended Stack

Zero-dependency vanilla JS Chrome MV3 extension. No bundler, no framework, no npm.

**Core technologies:**
- **Chrome MV3 with `"world": "MAIN"`**: Required to access page's JS context for fetch interception
- **Vanilla JavaScript (ES2022+)**: ~200-400 lines total; frameworks add pure overhead
- **Web Crypto API (built-in)**: AES-CBC decryption and potential DPoP signing — no libraries needed

### Expected Features

**Must have (table stakes):**
- Date picker patch — remove 3-month restriction
- Fetch/XHR interception — core mechanism
- 25-day chunk splitting — server rejects large ranges
- DPoP token reuse — sub-requests need valid auth
- Response merging — app expects single unified response
- AES-CBC decryption handling — responses are encrypted

**Should have (differentiators):**
- Request throttling — sequential/batched to avoid rate limits
- Progress indicator — badge showing chunk progress
- Error recovery — partial results on chunk failure

**Defer (v2+):**
- Response caching, other game types, CSV export, extension popup

### Architecture Approach

Three-layer architecture where the MAIN world injected script does all heavy lifting (fetch patching, chunking, merging), a content script handles DOM-level date picker patching, and the service worker is minimal (badge updates only). All business logic stays in the page context — never in the service worker (it dies after 30s idle).

**Major components:**
1. **Injected Page Script** (`inject.js`, MAIN world) — fetch monkey-patch, request splitting, response merging, DPoP reuse
2. **Content Script** (`content.js`, ISOLATED world) — date picker DOM patching via MutationObserver, optional messaging bridge
3. **Service Worker** (`background.js`) — minimal; badge updates, extension lifecycle only

### Critical Pitfalls

1. **World isolation** — Content scripts can't access page's `fetch`/`XHR`. Use `"world": "MAIN"` in manifest, not dynamic injection.
2. **DPoP token binding** — Can't generate new keypair; must reuse app's session-bound keypair. Hook app's DPoP function or let `originalFetch()` trigger it naturally.
3. **Race condition on first load** — Interceptor must install before Angular's first API call. Use `"run_at": "document_start"` with synchronous patching (no async before patch).
4. **Bad response merging** — Deduplicate sessionIds, set `remain: 0`, sort correctly, or app shows duplicates / infinite pagination.
5. **Service worker death** — Never put chunking logic in the service worker. It terminates after 30s idle.

## Implications for Roadmap

### Phase 1: Extension Scaffold & Discovery
**Rationale:** Must validate the two highest-risk unknowns before building anything: (1) does the app use fetch or XHR? (2) where does DPoP attach?
**Delivers:** Working extension that logs all API calls without modifying them. Documented answers to fetch-vs-XHR and DPoP attachment point.
**Addresses:** Manifest setup, MAIN world injection, fetch/XHR discovery
**Avoids:** World isolation pitfall, CSP issues, race conditions

### Phase 2: Request Interception & DPoP Validation
**Rationale:** DPoP is the highest-risk item. Must prove sub-requests get valid DPoP tokens before building chunking logic.
**Delivers:** Transparent passthrough interception of session/list calls. Proof that calling `originalFetch()` with modified URL params produces valid DPoP-authenticated responses.
**Addresses:** Fetch/XHR interception, DPoP token reuse
**Avoids:** DPoP reimplementation trap, interceptor timing issues

### Phase 3: Chunking, Merging & Decryption
**Rationale:** Pure logic phase — low risk once interception is proven. Depends on Phase 2.
**Delivers:** Large date ranges split into 25-day chunks, responses decrypted/merged/re-encrypted, returned transparently to app.
**Addresses:** Date range chunking, response merging, AES-CBC handling, request throttling
**Avoids:** Bad merge (dedup, remain=0), rate limiting, pagination within chunks

### Phase 4: Date Picker Unlock
**Rationale:** Independent of API work. Can start after Phase 1 but logically ships last since the API must handle large ranges before the UI allows them.
**Delivers:** User can select arbitrary date ranges in the picker.
**Addresses:** Date picker patch
**Avoids:** Fragile obfuscation patching (use DOM approach first)

### Phase Ordering Rationale

- Phase 1→2 eliminates the two biggest unknowns (fetch-vs-XHR, DPoP) before investing in logic
- Phase 3 is pure algorithmic work with no unknowns once interception is proven
- Phase 4 is parallel-safe but ships last to ensure the backend can handle what the UI now allows
- All business logic stays in the MAIN world script, avoiding service worker death

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** Runtime analysis required — must determine fetch vs XHR and locate DPoP attachment point via DevTools debugging
- **Phase 2:** DPoP hooking strategy depends on Phase 1 findings; may need `/gsd-research-phase` if Approach A fails

Phases with standard patterns (skip research-phase):
- **Phase 3:** Well-documented patterns — date math, array merging, AES-CBC via Web Crypto API
- **Phase 4:** Standard DOM manipulation with MutationObserver

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Vanilla JS + MV3 is the obvious choice; well-documented APIs |
| Features | HIGH | Feature set derived directly from PROJECT.md constraints |
| Architecture | HIGH | MAIN world injection + fetch patching is the established MV3 pattern |
| Pitfalls | MEDIUM-HIGH | Most pitfalls well-documented; DPoP strategy needs runtime validation |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Fetch vs XHR**: Unknown whether Angular app uses `fetch` or `XMLHttpRequest`. Must determine at runtime in Phase 1. Patch both defensively.
- **DPoP attachment layer**: Unknown whether DPoP tokens are added via fetch wrapper, Angular HttpInterceptor, or pre-computed. Determines whether Approach A (natural generation) works.
- **Date picker restriction mechanism**: Unknown whether it's DOM-level (`min`/`max` attributes) or JS-level (component validation). Determines patching strategy.
- **Chunk pagination**: Unknown whether individual 25-day chunks can exceed the per-request session limit. May need intra-chunk pagination.

## Sources

### Primary (HIGH confidence)
- Chrome MV3 content script worlds — https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Chrome MV3 migration (webRequest removal) — https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests
- Web Crypto API — https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- DPoP RFC 9449 — https://datatracker.ietf.org/doc/html/rfc9449

### Secondary (MEDIUM confidence)
- Angular HttpClient default transport (XHR vs fetch) — varies by Angular version
- Fetch/XHR monkey-patching patterns — community-established technique

---
*Research completed: 2026-04-22*
*Ready for roadmap: yes*
