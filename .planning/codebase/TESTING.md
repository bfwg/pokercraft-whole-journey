# Testing Patterns

**Analysis Date:** 2026-06-17

## Test Framework

**Status:** No automated test framework. Testing is fully manual — there are no unit tests, integration tests, or CI pipelines.

**Rationale:** 
- Extension runs in a content-script context (`manifest.json` `"world": "MAIN"` with `"run_at": "document_start"`)
- Logic depends on runtime state captured from the live PokerCraft app (DPoP tokens, encryption keys, Angular component instances)
- These cannot be mocked or stubbed in headless automation (per CLAUDE.md: "This extension cannot be exercised in headless automation: the API auth is DPoP-bound with a non-extractable key + session-bound token, so a copied profile always 401s, and recent Chrome blocks remote-debugging the live profile")
- Testing requires a real logged-in Chrome session

**Harness:** `.pw-harness/` directory (local development only, gitignored)
- Purpose: Diagnose UI regressions when PokerCraft updates
- Tools: Playwright (`playwright@^1.61.0`) + `classic-level@^3.0.0`
- Usage: Developer runs Playwright scripts against a copied Chrome profile to inspect DOM and capture state
- Workflow: See `.pw-harness/diag.mjs` — launches browser, auto-drives to custom date picker, polls DOM every 2 seconds for 5 minutes, saves snapshots

## Test File Organization

**No test files.** Code is in `extension/content.js` only.

**Diagnostic harness files (development only):**
- `diag.mjs` — Main diagnostic launcher; captures custom-range picker DOM structure
- `auth-probe.mjs` — Probes authentication state (captured from live requests)
- `extract-ls.mjs` — Extracts session data from captured responses
- Output artifacts: `diag-latest.json`, `diag-customrange.json`, `diag-customrange.html`

## Manual Testing Strategy

**Testing is performed in the user's live Chrome session. Three approaches:**

### 1. DevTools Console Testing

**Entry point:** `window.__pokercraftUnlocker` (exposed at line 285 of `content.js`)

**Available functions:**
```javascript
window.__pokercraftUnlocker.makeProofRequest()       // Fetch 7-day session list with auth
window.__pokercraftUnlocker.debugFetchChunk()        // Decrypt and log a single chunk response
window.__pokercraftUnlocker.dpopSigner               // Access DPoP token generator (debug)
window.__pokercraftUnlocker.log                      // Manual logging function
window.__pokercraftUnlocker.splitDateRange()         // Test date range chunking
window.__pokercraftUnlocker.mergeResponses()         // Test session deduplication
window.__pokercraftUnlocker.patchDatePicker()        // Reapply date picker unlock
```

**Test procedure:**
1. Open PokerCraft at https://my.pokercraft.com
2. Open DevTools (F12 → Console tab)
3. Navigate to Sessions history (app makes initial API request, auth is captured)
4. Run test functions:
   ```javascript
   // Test auth capture:
   window.__pokercraftUnlocker.dpopSigner.jwk  // Should be non-null after first app request
   
   // Test chunking logic:
   const chunks = window.__pokercraftUnlocker.splitDateRange(
     new Date('2020-01-01').getTime(),
     new Date('2023-12-31').getTime()
   );
   console.log(chunks.length);  // Should be ~15 chunks for 4-year range
   
   // Test a full request:
   const result = await window.__pokercraftUnlocker.makeProofRequest();
   console.log(result);  // { status: 200, length: <hex_len>, data: {...} }
   ```

### 2. Enable Logging to DevTools

**To enable all extension logs:**
1. Edit `extension/content.js`, line 313:
   ```javascript
   const DEBUG = true;  // Change from false to true
   ```
2. Go to `chrome://extensions/`, find "PokerCraft Whole Journey", click reload button
3. DevTools Console will now show all extension logs prefixed `[PokerCraft Whole Journey]`

**Log output shows:**
- Auth capture events: "Captured auth headers from XHR request"
- Chunk processing: "Chunk 1/15: 2020-01-01 → 2020-03-26 — 42 sessions"
- Decryption status: "Chunk 1/15: decrypted OK"
- Date picker unlock: "Unlocked 31 past date cells", "Unlocked nav button: ..."
- Errors: "Failed to extract JWK from DPoP token: ..."

### 3. Playwright Diagnostic Harness

**Setup:**
```bash
cd /Users/fanjin/bfwg/pokercraft-whole-journey/.pw-harness
npm install  # Installs playwright and classic-level
```

**Usage:**
```bash
# Inspect the custom date picker UI (without extension)
node diag.mjs

# Test the extension fix against the UI
LOAD_EXT=1 node diag.mjs

# Test a specific URL
URL='https://my.pokercraft.com/session/list' node diag.mjs
```

**What it does:**
- Launches user's Chrome profile (with live DPoP key and session auth)
- Auto-navigates to custom date picker (or lets you click manually)
- Polls page DOM every 2 seconds for up to 5 minutes
- Saves snapshots to `.pw-harness/diag-latest.json`:
  ```json
  {
    "url": "https://my.pokercraft.com/...",
    "sfFound": true,
    "inputs": [...],
    "buttons": [...],
    "overlayPanes": [...],
    "calDayButtons": 42,
    "sampleCalButtons": [...],
    "isCustomRange": true
  }
  ```
- On custom-range detection, also saves `diag-customrange.json` and `diag-customrange.html`

**Failure indicators:**
- `isCustomRange: false` — picker didn't render (check URL, login)
- `calDayButtons: 0` — picker rendered but calendar didn't load
- Button `aria-disabled: true` — dates are still disabled (unlock logic didn't run)

## Mocking & Stubbing

**Not used.** Extension directly hooks browser APIs that cannot be easily stubbed in tests:
- `window.fetch` — Real network requests; can't mock without affecting extension logic
- `XMLHttpRequest.prototype.{open,send,setRequestHeader}` — Must intercept real XHR to capture auth
- `crypto.subtle.sign` — Captures live non-extractable CryptoKey; can't be simulated

**Workaround for local testing:**
- Use `window.__pokercraftUnlocker.debugFetchChunk()` in DevTools console to inspect live responses without making a full request
- Use `makeProofRequest()` to verify DPoP token generation and auth flow
- Manually verify date picker unlock by navigating calendar and checking that disabled cells become clickable

## Test Coverage Gaps

**Areas NOT tested (manual verification only):**

| Component | Gap | Risk | Mitigation |
|-----------|-----|------|------------|
| DPoP token generation | No unit tests; only verified against live API | Token generation breaks silently if crypto.subtle API changes | Check DevTools logs; run `makeProofRequest()` in console |
| AES-CBC decryption | No unit tests; only verified against real encrypted responses | Decryption breaks if PokerCraft changes key derivation (stripping first/last 8 chars of header `a`) | Check logs for "decrypted OK" or "Failed to decrypt" |
| XHR interception edge cases | Not tested: multiple simultaneous requests, requests with custom request bodies, XHR abort | Edge-case requests may not be intercepted correctly | Enable DEBUG and check XHR interception logs |
| Date picker unlock | Manual verification only; depends on Angular Material version | Calendar unlock breaks when PokerCraft updates Material library | Run diagnostic harness (`LOAD_EXT=1 node diag.mjs`) to capture new DOM |
| Chunking logic | Verified via console `splitDateRange()`; not tested with varying date ranges | Edge cases (1-day range, 1-year range, exact 85-day boundary) not exercised | Run `splitDateRange()` in console with test dates |
| Merge deduplication | Verified via console; not tested with duplicate session IDs across chunks | If PokerCraft returns same sessionId in overlapping chunks, logic may fail | Enable DEBUG and check merge logs for dedupe counts |

## Test Execution Flow

**From user perspective:**

1. **Install extension** (Chrome Web Store or manual via `chrome://extensions/` → Load unpacked)
2. **Log into PokerCraft** (https://my.pokercraft.com with active account)
3. **Navigate to Sessions → Date filter → Custom range**
4. **Try to select a date > ~90 days ago** — if the calendar disables it, the extension isn't working
5. **Check DevTools Console (F12):**
   - If DEBUG is true, look for `[PokerCraft Whole Journey]` logs
   - Successful chunking: "Chunk 1/N: ... — X sessions"
   - Failed interception: "Large range detected but no auth captured yet — passing through"
6. **If date picker is disabled or data doesn't load:**
   - Open DevTools Console and run: `window.__pokercraftUnlocker.makeProofRequest()`
   - Check status code (should be 200)
   - If 401 or error: auth not captured (run makeProofRequest after app makes a real request)

## Regression Detection

**How to detect a regression (when PokerCraft updates):**

1. **Date picker no longer unlocks:**
   - Run `.pw-harness/diag.mjs` to capture new DOM structure
   - Compare `diag-latest.json` button/cell classes with old captures in CLAUDE.md
   - Update selectors in `unlockCalendar()` if Material components changed

2. **API responses decrypt incorrectly:**
   - Enable DEBUG, run `makeProofRequest()`, check logs for "decrypted OK" or "Failed to decrypt"
   - If fails: check if header `a` key derivation (strip first/last 8 chars) still valid by comparing encrypted vs. plaintext responses in Network tab

3. **Auth capture fails (401 errors):**
   - Check if `authorization` or `dpop` header names changed
   - Run DevTools Console: `window.__pokercraftUnlocker.dpopSigner.jwk` — should be non-null
   - If null: auth header capture logic in XHR hook (line 434-441) needs updating

## CI/CD Integration

**No CI/CD pipeline.** Extension is manually packaged and released:
```bash
cd extension && zip -r ../pokercraft-whole-journey.zip . -x ".*"
```

Per CLAUDE.md: "There is nothing to build or compile."

---

*Testing analysis: 2026-06-17*
