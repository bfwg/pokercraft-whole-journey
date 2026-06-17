# Codebase Concerns

**Analysis Date:** 2026-06-17

## Reverse-Engineered Site Internals (Critical Fragility)

**The entire extension depends on undocumented PokerCraft implementation details:**
- Issue: All subsystems rely on reverse-engineered API contracts that can break silently on site updates
- Files: `extension/content.js` (entire file)
- Impact: 
  - AES-CBC decryption scheme: key = header `a` stripped of first/last 8 chars, fixed IV `'tE5_yR0~uI2-oP4a'` (`extension/content.js:136`, `146-170`, `176-190`)
  - Request contract: `GET /api/session/list/Holdem?from=<ms>&to=<ms>` (`extension/content.js:319-331`)
  - Response envelope: `{ data: "<hex>" }` with encryption key in header `a` (`extension/content.js:232-245`)
  - 85-day chunk limit hardcoded (`extension/content.js:197-207`)
  - Any PokerCraft API version change breaks the extension silently — users get no error, just degraded behavior

Fix approach: Add request/response validation on load that verifies the API contract still exists. Log to console if shape changes. Create fallback degraded modes that fail loudly rather than silently.

---

## 2026-06 Material Design → MDC Migration (Active Blocker)

**The date-picker unlock is already broken:**
- Issue: PokerCraft migrated from Angular Material to MDC Material; calendar UI structure changed from `mat-calendar` hierarchy to a `mat-select` preset dropdown
- Files: `extension/content.js:519-883` (entire date picker unlock subsystem)
- Symptoms: 
  - Navigation buttons exist but unlock logic targets old Material selectors (`button.mat-calendar-previous-button`, `button.mat-calendar-next-button`)
  - Calendar cell structure no longer matches (was `mat-month-view` → `table` → cells; now is dropdown menu items)
  - Angular component shape changed (no longer `_weeks`, `monthView`, `_dateAdapter`, etc.)
- Workaround: None — users must manually select narrow date ranges
- Risk: Medium/High — date range unlock is a core feature

Fix approach: 
1. Inspect live PokerCraft MDC structure in DevTools
2. Rewrite `findMonthView()`, `findCalendar()`, `unlockCalendar()` for MDC selectors
3. Update event interception in `installClickInterceptor()` to handle dropdown item selection instead of calendar cells

---

## Execution Context Load-Bearing Constraints

**MAIN world + document_start timing are critical and fragile:**
- Issue: Any change to `manifest.json` execution context breaks the entire extension silently
- Files: `extension/manifest.json:11-17` (world/run_at settings), `extension/content.js:1-6` (original capture)
- Load-bearing:
  - `"world": "MAIN"` required to override `window.fetch`, `XMLHttpRequest`, `crypto.subtle.sign` and access `__ngContext__`
  - `"run_at": "document_start"` required to capture pristine originals BEFORE PokerCraft code runs (`originalFetch`, `originalXHROpen/Send/SetRequestHeader`, `originalCryptoSign`)
  - If either changes, hooks no longer intercept properly

Impact: If someone refactors manifest to isolate-world or delays injection, extension silently stops working without any error message.

Fix approach: Add defensive checks in `content.js` that verify original references are captured. Throw visible error on page if not.

---

## Asymmetric Auth Capture Dependency

**Nothing chunk-related works until the app makes at least one real request:**
- Issue: Extension waits for the app to fire a session-list request, then hijacks auth/DPoP from it (`capturedAuth`, `capturedPrivateKey`)
- Files: `extension/content.js:8-12` (state), `15-25` (crypto.subtle.sign hook), `362-374` (fetch capture), `434-442` (XHR capture)
- Problem: 
  - If a user opens the extension, navigates to a narrow date range, and tries to expand it — the first request is never intercepted because it doesn't need chunking
  - Auth remains `null`, so chunking request falls through with log `'Large range detected but no auth captured yet — passing through'` (`extension/content.js:399`, `512-514`)
  - This is a logic bug: we should be able to make a chunked request even on the first wide-range query
- Trigger: User opens extension → clicks "Whole Journey" → immediately tries to select wide date range
- Workaround: User must make any session-list request first (narrow range), then try again

Fix approach: On first intercepted request, proactively make a small proof request (`makeProofRequest()` exists for this) to capture auth before user attempts chunking.

---

## DPoP Key Capture Race Condition

**Private key capture timing is non-deterministic:**
- Issue: `crypto.subtle.sign` hook fires when the app first signs with ECDSA — but this could happen before user requests session data
- Files: `extension/content.js:15-25`, `47-86` (DPoPSigner)
- Problem: If `capturedPrivateKey` is null when chunking starts, `generateDPoP()` throws `'No CryptoKey captured yet'` (`extension/content.js:48-49`)
- Fragility: Key capture depends on app's arbitrary signing order, not guaranteed to occur before session requests

Fix approach: Fall back to proof request to capture key if missing when chunking begins.

---

## No Encryption Key Fallback Degradation

**If response encryption key is never seen, results are sent plaintext:**
- Issue: Extension caches encryption key in `lastHeaderA` on first chunk response; if first chunk is unencrypted, all merged results are sent unencrypted
- Files: `extension/content.js:193` (lastHeaderA), `386-397` (fetch re-encrypt), `464-471` (XHR re-encrypt)
- Problem: Plaintext fallback (`extension/content.js:394-397`, `469-471`) means the app's decryption layer expects a decrypted envelope, but if app code changed and now requires encryption, this will break silently
- Impact: User sees no sessions (app expects `{ data: "<encrypted>" }` with header `a`, gets `{ vm: [] }` plaintext)

Fix approach: 
1. On first chunk, verify encryption key exists; if not, fail loudly with user-facing error
2. Never send plaintext fallback — require encryption or return error

---

## Hardcoded Fixed IV (Cryptographic Weakness)

**AES-CBC uses a constant IV across all requests:**
- Issue: IV `'tE5_yR0~uI2-oP4a'` is hardcoded in code, re-used for every encryption
- Files: `extension/content.js:136` (constant), `150`, `178`
- Problem: AES-CBC with fixed IV is cryptographically weak — each message should have a random IV
- Risk: Low immediate (within browser sandbox), but if a user's profile is dumped or endpoint is compromised, multiple messages using same IV + plaintext patterns can leak information
- Context: This mirrors PokerCraft's own implementation (reverse-engineered from their `decode.js`), so changing it would break compatibility

Fix approach: No fix without breaking compatibility. Document as "inherited from PokerCraft's own implementation; change only if PokerCraft changes first."

---

## DOM Coupling to Input Attributes

**Date range expansion reads live DOM input attributes:**
- Issue: Whole Journey expansion depends on reading `min`/`max` off `input[matStartDate]` and `input[matEndDate]`
- Files: Referenced in `CLAUDE.md` section 4, but not explicitly called in current `content.js` (logic was removed in prior refactor)
- Missing: No `getEarliestMs()` or `getLatestMs()` functions visible in current code, but CLAUDE.md describes them
- Risk: Fragile coupling — if PokerCraft changes input selector or attribute name, range detection breaks

Fix approach: Add defensive DOM selectors with fallback to fixed dates. Add logging for when fallback activates.

---

## Untestable in Automation

**Extension cannot be tested in headless/CI environments:**
- Issue: API auth is DPoP-bound with session-specific token + non-extractable CryptoKey
- Files: All of `extension/content.js` (depends on live browser auth)
- Problem:
  - Copied Chrome profiles always 401 on API calls (session + key don't transfer)
  - Recent Chrome versions block remote-debugging of logged-in profiles
  - No way to simulate DPoP signing without the real key
- Consequence: No automated testing possible; all verification must be manual in user's live profile

Fix approach: None without reimplementing auth (not feasible). Document requirement: "Manual testing only in logged-in PokerCraft profile; use DevTools console `window.__pokercraftUnlocker` API."

---

## Observable Errors vs. Silent Failures

**Chunking errors fall back silently without user notification:**
- Issue: Chunk fetch errors log to console (behind DEBUG flag) but silently pass through to original request
- Files: `extension/content.js:227-229` (log skipped chunk), `251-253` (catch error, log, continue), `506-509` (XHR fallback), `398-400` (fetch passthrough)
- Problem: If all chunks fail due to auth expiry, user sees a timeout or no data without understanding why
- User experience: Extension gives no visible signal that chunking failed or that a degraded fallback occurred

Fix approach:
1. Expose errors via `window.__pokercraftUnlocker` API
2. Log persistent errors to a visible DOM element or browser console group
3. If chunking completely fails (all chunks error), emit a user-visible warning

---

## Missing Initialization Guard

**Script assumes document.body exists; race condition on very early page load:**
- Issue: Init logic checks `if (document.body)` but doesn't guard against other race conditions
- Files: `extension/content.js:887-898`
- Problem: If Angular attaches date-picker elements before `patchDatePicker()` runs, early pickers won't be unlocked
- Risk: Low (unlikely given document_start timing), but possible on slow page load

Fix approach: Add `MutationObserver` for date-picker elements added during the wait-for-body phase.

---

## Test Coverage Gaps

**No test suite exists:**
- What's not tested: 
  - DPoP token generation and signature validity
  - AES-CBC decryption/re-encryption round-trip
  - Session merging de-duplication (edge cases: mixed vm/sessionIds shapes, null values)
  - Date range chunking boundary conditions (ranges exactly divisible by 85, ranges < 1ms, etc.)
  - XHR event firing order (readystatechange, load, loadend) — must match app expectations
  - Calendar navigation state mutations (_minDate/_maxDate clearing)
  - Edge case: auth captured from fetch path, then XHR request fires
- Files: No test files exist in repo
- Risk: High — cryptographic and state management errors can cause silent data loss or infinite loops

Fix approach: 
1. Create `extension/content.test.js` with unit tests for decryption, chunking, merging
2. Create headless playwright test harness (limited scope — only test non-auth logic)
3. Create manual test checklist for auth/DPoP flows (mark as "requires live profile")

---

## No Error Recovery Mechanism

**Chunking failure cascades without graceful degradation:**
- Issue: If `fetchChunks()` fails mid-stream (e.g., auth expires after chunk 3 of 10), remaining chunks are skipped and incomplete data is returned
- Files: `extension/content.js:209-260` (fetchChunks loop)
- Problem: Merged response is sent with only 3 chunks' data, user doesn't know other chunks were lost
- Example: User expands range to 10 years, extension fetches 12 chunks, auth expires on chunk 6 — user gets 5 months of data silently

Fix approach: 
1. Retry failed chunks (with backoff) before giving up
2. If retry exhaustion reached, fail loudly: return error to app, don't send partial data
3. Expose retry count/state via `window.__pokercraftUnlocker` debug API

---

## Chrome Permission Requirements Are Empty But Implied

**Extension relies on implicit permissions that aren't enforced:**
- Issue: `manifest.json` has empty `permissions` array, but the content script requires network access to `my.pokercraft.com`
- Files: `extension/manifest.json:19`
- Problem: If manifest was updated to add `host_permissions`, it might break or require user interaction
- Context: Current setup works because of the `matches` pattern in content_scripts

Fix approach: Add comment explaining why permissions must stay empty. Document that host access comes from `matches` pattern only.

---

## Missing `computeEffectiveRange()` Function

**CLAUDE.md references a function that doesn't exist in code:**
- Issue: CLAUDE.md section 4 mentions `computeEffectiveRange()` and `getEarliestMs()`/`getLatestMs()` functions, but they're not in `content.js`
- Files: CLAUDE.md (lines 45, referenced but not in `content.js`)
- Problem: Either the functions were removed in a prior refactor, or the documentation is stale
- Impact: Whole Journey expansion logic is undocumented in code

Fix approach: 
1. If functions should exist, implement them with DOM input selectors
2. If they were removed, update CLAUDE.md to match current implementation

---

## Large Single-File Code Organization

**All logic crammed into one 899-line script:**
- Issue: `content.js` contains DPoP crypto, request interception, chunking, encryption, and Angular component manipulation in one file
- Files: `extension/content.js` (all)
- Problem: Hard to test individual subsystems, difficult to debug which layer is failing
- Risk: Low functional impact, high maintenance burden

Fix approach: No refactor needed immediately (it's a small enough codebase), but document subsystem boundaries clearly in comments.

---

## Missing Env/Version Info for Debugging

**No way to detect PokerCraft version or API version:**
- Issue: When extension breaks on a PokerCraft update, there's no version info logged
- Files: `extension/content.js`
- Problem: User reports "it's broken" but extension has no way to detect if site changed

Fix approach: On first session request, capture and log:
- PokerCraft app version (if present in page scripts/attributes)
- API response shape (schema detection)
- PokerCraft Angular version (if accessible)

---

## Captured Auth Persistence Across Page Reloads

**Auth is stored in global scope, lost on page reload:**
- Issue: `capturedAuth` and `capturedPrivateKey` are script-scoped, not persisted
- Files: `extension/content.js:8-11`
- Problem: Each page reload forces re-capturing auth from scratch; first wide-range request after reload fails silently
- Workaround: User makes narrow request first

Fix approach: No fix needed (by design — auth is page-scoped for security). Document this limitation.

---

## Missing Diagnostic Export

**No way to export debug state for diagnostics:**
- Issue: When troubleshooting, users can only access `window.__pokercraftUnlocker` methods individually
- Files: `extension/content.js:285` (incomplete __pokercraftUnlocker export)
- Problem: Hard to collect full diagnostic snapshot

Fix approach: Add `window.__pokercraftUnlocker.getState()` that returns:
```json
{
  "authCaptured": bool,
  "keyCapture": bool,
  "jwkPresent": bool,
  "lastHeaderA": "...",
  "debugLogs": [...]
}
```

---

*Concerns audit: 2026-06-17*
