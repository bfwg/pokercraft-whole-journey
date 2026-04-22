---
phase: 02-chunking-response-merging
plan: 01
subsystem: api
tags: [xhr-interception, date-chunking, response-merging, aes-cbc, dpop, web-crypto]

requires:
  - phase: 01-extension-scaffold-request-interception
    provides: XHR/fetch interception, DPoP signer, auth capture
provides:
  - Date range chunking engine (splitDateRange)
  - Sequential chunk fetching with DPoP auth (fetchChunks)
  - Response merging with deduplication (mergeResponses)
  - AES-CBC decryption/re-encryption of API responses
  - Transparent XHR response injection for Angular/Zone.js
affects: [03-date-picker-ui]

tech-stack:
  added: [Web Crypto API (AES-CBC)]
  patterns: [decrypt-merge-reencrypt pipeline, synthetic XHR response with ProgressEvent for Angular compatibility]

key-files:
  created: []
  modified: [extension/content.js]

key-decisions:
  - "API responses are AES-CBC encrypted — must decrypt before merge and re-encrypt after"
  - "IV truncated to 16 bytes (Web Crypto requirement) matching node-forge behavior"
  - "Chunk size 85 days instead of 25 — API limit is ~3 months, conservative 85 days minimizes requests"
  - "Data structure is { vm: [...sessions] } not { sessionIds: [...] } — merging on vm array"
  - "XHR response injection uses captured onload/onreadystatechange + ProgressEvent for Angular/Zone.js compatibility"

patterns-established:
  - "Decrypt-merge-reencrypt: all API response manipulation follows decrypt → process → re-encrypt pattern"
  - "Angular XHR compat: synthetic responses must use ProgressEvent and capture/replay handler references"

requirements-completed: [SPL-01, SPL-02, SPL-03, MRG-01, MRG-02, MRG-03, MRG-04]

duration: 45min
completed: 2026-04-22
---

# Phase 2 Plan 1: Chunking Engine & Response Merging Summary

**85-day date range chunking with AES-CBC decrypt/merge/re-encrypt pipeline and Angular-compatible XHR response injection**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-04-22T21:20:00Z
- **Completed:** 2026-04-22T22:05:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Large date ranges automatically split into 85-day chunks, fetched sequentially with DPoP auth, and merged transparently
- AES-CBC encrypted API responses properly decrypted before merging and re-encrypted after
- Verified live on Pokercraft: 91-day range → 2 chunks → 357 + 22 = 379 sessions merged and displayed correctly
- Angular/Zone.js compatible XHR response injection using ProgressEvent and handler capture

## Task Commits

Each task was committed atomically:

1. **Task 1: Add chunking engine and response merging** - `8bdf436` (feat) + `3552258` (fix: decrypt/re-encrypt, IV length, data structure, chunk size, Angular XHR compat)
2. **Task 2: Verify chunking works on live Pokercraft site** - human-verify checkpoint, approved by user

## Files Created/Modified
- `extension/content.js` - Added splitDateRange, fetchChunks, mergeResponses, decryptResponse, encryptResponse; modified XHR/fetch interceptors for chunking

## Decisions Made
- API responses are AES-CBC encrypted — added decrypt/re-encrypt pipeline using Web Crypto API
- Changed chunk size from 25 to 85 days (API limit is ~3 months, 85 days is conservative and minimizes requests)
- Data structure uses `{ vm: [...] }` not `{ sessionIds: [...] }` — merging on vm array
- XHR injection captures onload/onreadystatechange handlers before async work, replays with ProgressEvent for Angular/Zone.js

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] API responses are AES-CBC encrypted**
- **Found during:** Task 1 (post-commit testing)
- **Issue:** Plan assumed plaintext JSON responses; actual API responses are encrypted with AES-CBC
- **Fix:** Added decryptResponse() and encryptResponse() using Web Crypto API
- **Files modified:** extension/content.js
- **Verification:** Live test confirmed decryption and re-encryption working
- **Committed in:** 3552258

**2. [Rule 1 - Bug] IV was 32 bytes, Web Crypto needs 16**
- **Found during:** Task 1 (post-commit testing)
- **Issue:** Web Crypto AES-CBC requires 16-byte IV but API provides 32 characters
- **Fix:** Truncated IV to first 16 characters (matches node-forge behavior)
- **Files modified:** extension/content.js
- **Committed in:** 3552258

**3. [Rule 1 - Bug] Wrong data structure assumed**
- **Found during:** Task 1 (post-commit testing)
- **Issue:** Plan assumed `{ sessionIds: [...] }` but actual structure is `{ vm: [...sessions] }`
- **Fix:** Updated mergeResponses to merge on vm array
- **Files modified:** extension/content.js
- **Committed in:** 3552258

**4. [Rule 1 - Bug] XHR response injection incompatible with Angular/Zone.js**
- **Found during:** Task 1 (post-commit testing)
- **Issue:** Simple dispatchEvent didn't work; Angular's Zone.js patches XHR and expects specific event patterns
- **Fix:** Capture onload/onreadystatechange handlers before async, replay with ProgressEvent, add getAllResponseHeaders/responseURL
- **Files modified:** extension/content.js
- **Committed in:** 3552258

---

**Total deviations:** 4 auto-fixed (4 bugs)
**Impact on plan:** All fixes necessary for correctness. Encryption and data structure were undiscoverable without live testing. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Chunking and merging fully functional on live site
- Ready for Phase 3 (Date Picker UI) — users can now get full history, just need UI to select arbitrary date ranges

---
*Phase: 02-chunking-response-merging*
*Completed: 2026-04-22*
