<!-- refreshed: 2026-06-17 -->
# Architecture

**Analysis Date:** 2026-06-17

## System Overview

PokerCraft Whole Journey is a single-file Manifest V3 Chrome extension that intercepts PokerCraft's API requests to defeat the ~3-month date-range limit on session history. The entire application logic lives in one injected script (`extension/content.js`, ~900 lines) running in the page's MAIN execution world.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                         PokerCraft Web App                              │
│                  (Angular + Material Date Picker)                       │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│              content.js - Four Cooperating Subsystems                   │
│  `extension/content.js`                                                 │
├───────────────────┬─────────────────┬────────────────┬─────────────────┤
│ DPoP Auth Capture │ Interception    │ Chunking +     │ Date Picker     │
│ (lines 1-90)      │ (lines 345-517) │ Encryption     │ Unlock          │
│                   │                 │ (lines 195-282)│ (lines 519-883) │
│ • Hooks           │ • Fetch hook    │                │                 │
│   crypto.subtle   │ • XHR hooks     │ • splitDate    │ • Calendar      │
│ • Stores          │ • Detects range │   Range()      │   mutation obs  │
│   CryptoKey &     │ • Routes to     │ • fetchChunks()│ • Removes       │
│   auth headers    │   chunking      │ • Decryption/  │   disabled attr │
│                   │                 │   Encryption   │ • Click         │
│                   │                 │ • mergeData()  │   interceptor   │
└───────────────────┴─────────────────┴────────────────┴─────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  PokerCraft API Layer   │
                    │  /api/session/list/*    │
                    └─────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File | Lines |
|-----------|----------------|------|-------|
| DPoP Auth Capture | Intercept crypto.subtle.sign, capture private key and auth headers on first request | `extension/content.js` | 1-90 |
| DPoPSigner Object | Generate fresh DPoP JWT proofs using captured key for sub-requests | `extension/content.js` | 29-87 |
| Request Interception | Hook fetch/XHR, detect target requests, route to chunking if range > 85 days | `extension/content.js` | 345-517 |
| Chunking Engine | Split date ranges, fetch 85-day chunks in parallel, decrypt responses | `extension/content.js` | 195-260 |
| Encryption/Decryption | AES-CBC encrypt/decrypt response bodies using key from header `a` | `extension/content.js` | 133-190 |
| Response Merge | Deduplicate sessions across chunks by sessionId | `extension/content.js` | 262-282 |
| Date Picker Unlock | Detect/patch Angular Material calendar, remove disabled restrictions, intercept clicks | `extension/content.js` | 519-883 |

## Pattern Overview

**Overall:** Transparent network-layer proxy with DOM-coupled UI unlock.

**Key Characteristics:**
- **Single-file monolith**: All code in `extension/content.js` with no external dependencies
- **MAIN world injection**: Runs in page context with full access to `window.fetch`, `XMLHttpRequest`, `crypto.subtle.sign`, and Angular component instances
- **Opportunistic auth capture**: Waits for app's first request to harvest DPoP material, then uses it for sub-requests
- **85-day chunking**: PokerCraft's backend limit is 85 days; requests > 85 days split, fetch, merge, re-encrypt
- **Transparent to app**: Intercepted responses are re-encrypted with original key and header, so app decryption layer works unchanged
- **Always-on date expansion**: Rewrites `from`/`to` query params at network layer regardless of UI state

## Layers

**Layer 1: Original API Capture (lines 1-90)**
- Purpose: Intercept and store the page's real crypto.subtle.sign, fetch, XMLHttpRequest methods before PokerCraft app code runs
- Location: `extension/content.js`, lines 1-6 (immediate save), line 15-25 (hook crypto.subtle.sign)
- Contains: Saved original function references, auth/key state variables, DPoPSigner class
- Depends on: Nothing (runs first via `"run_at": "document_start"`)
- Used by: Fetch hook, XHR hook, chunking engine

**Layer 2: DPoP Auth Capture (lines 15-90)**
- Purpose: Grab app's ECDSA private key and session token from first request
- Location: `extension/content.js`, lines 15-25 (crypto hook), lines 29-87 (DPoPSigner)
- Contains: `crypto.subtle.sign` hook, `DPoPSigner` class with `extractFromToken()` and `generateDPoP()` methods
- Depends on: Saved original crypto.subtle.sign
- Used by: Fetch hook (auth header capture), chunking engine (DPoP token generation)

**Layer 3: Request Interception (lines 345-517)**
- Purpose: Detect target requests (`GET /api/session/list/Holdem`), parse date range, route to chunking or pass through
- Location: `extension/content.js`, lines 347-403 (fetch hook), lines 414-517 (XHR hooks)
- Contains: `isTargetRequest()`, `parseDateRange()`, `isLargeRange()` helpers, fetch/XHR method replacements
- Depends on: Saved original fetch/XHR, DPoP auth capture, chunking engine
- Used by: Browser fetch/XHR callsites

**Layer 4: Chunking + Encryption (lines 195-282)**
- Purpose: Split large date ranges into 85-day chunks, fetch each with separate DPoP token, decrypt/merge/re-encrypt responses
- Location: `extension/content.js`, lines 197-207 (splitDateRange), lines 209-260 (fetchChunks), lines 262-282 (mergeResponses)
- Contains: Crypto utility functions (hexToBytes, bytesToHex, encryptData, decryptResponse), chunking logic
- Depends on: Saved original fetch, DPoP token generation, AES-CBC crypto
- Used by: Fetch/XHR interception layer

**Layer 5: Date Picker Unlock (lines 519-883)**
- Purpose: Detect Angular Material calendar popup, remove disabled restrictions on past dates, intercept clicks to force selection
- Location: `extension/content.js`, lines 542-567 (Angular component detection), lines 590-678 (unlock logic), lines 680-825 (click interceptor), lines 827-883 (MutationObserver)
- Contains: `patchDatePicker()` (init), `unlockCalendar()` (unlock state), `installClickInterceptor()` (event handling), DOM search helpers
- Depends on: Angular's `__ngContext__` on DOM elements, Material component internals
- Used by: Browser's DOM mutation events

## Data Flow

### Primary Request Path (Session History)

1. **App fires XHR session-list request** (`extension/content.js:414-419`)
   - App calls `XMLHttpRequest.open('GET', url, ...)`
   - Hook logs method/URL and stores in `xhr._pcMethod`, `xhr._pcUrl`

2. **App sets headers via setRequestHeader** (`extension/content.js:408-412`)
   - App calls `xhr.setRequestHeader('Authorization', token)` and `xhr.setRequestHeader('DPoP', dpopToken)`
   - Hook captures headers to `xhr._pcHeaders` and calls original

3. **App sends request** (`extension/content.js:421-517`)
   - App calls `xhr.send(body)`
   - Interception hook runs, checks if this is a target request via `isTargetRequest()` and `parseDateRange()`

4. **Auth capture (first request only)** (`extension/content.js:434-442`)
   - If `capturedAuth` is null and headers present: store authorization header, extract JWK from DPoP token via `DPoPSigner.extractFromToken()`
   - Sets global `capturedAuth` and `dpopSigner.jwk` for all future sub-requests

5. **Date range evaluation** (`extension/content.js:444-450`)
   - Check if range is > 85 days via `isLargeRange()` AND auth is captured
   - If yes, proceed to chunking; otherwise fall through to original request

6. **Chunking + Merging** (`extension/content.js:448-505`)
   - Call `splitDateRange(fromMs, toMs)` to split into 85-day chunks
   - Call `fetchChunks(baseUrl, chunks)` to request each chunk with fresh DPoP tokens via original fetch
   - Each chunk response: extract key from header `a`, decrypt via `decryptResponse()`, collect results
   - Call `mergeResponses(responses)` to deduplicate sessions by sessionId
   - Re-encrypt merged result with `encryptData()` using last-seen key

7. **Fabricate XHR response** (`extension/content.js:474-505`)
   - Define `readyState`, `status`, `statusText`, `responseText`, `response` as getters returning mock values
   - Override `getResponseHeader()` to return header `a` (enables app's decryption)
   - Fire `onreadystatechange` event (property call + dispatched), `onload` event, `onloadend` event
   - Angular/Zone.js listens via both mechanisms; both must fire for change detection

8. **App receives response** 
   - App's native response handlers fire (from step 7)
   - App's HTTP client deserializes response body (encrypted JSON)
   - App's `decode.js` layer decrypts via same key extraction logic
   - App's data binding updates with merged session list

### Fetch Path (Fallback)

- Same flow but on fetch call; capture auth from init headers if present
- Response is a `new Response()` object with status 200, merged data, re-encrypted if key available
- App handles transparently

### Date Picker Unlock Path

1. **App opens date range picker** 
   - Angular renders `mat-datepicker-popup` in CDK overlay pane
   
2. **bodyObserver detects new DOM node** (`extension/content.js:831-879`)
   - MutationObserver sees popup added to DOM
   - Calls `unlockCalendar(popup)` after 150ms (Angular render settle)
   - Installs sub-observer on popup for month navigation re-renders

3. **unlockCalendar() removes disabled state** (`extension/content.js:590-678`)
   - Finds prev/next nav buttons, removes HTML `disabled` attr and CSS class
   - Finds all date cells with `mat-calendar-body-disabled` class where date <= today, removes class
   - Disables future date cells to prevent selection
   - Calls `installClickInterceptor(popup)`

4. **Click interceptor installed** (`extension/content.js:680-825`)
   - Listens on capture phase (before Angular's handler) for button/cell clicks
   - On nav button click: clears `_minDate`/`_maxDate` on calendar component so Angular navigates freely
   - On date cell click (cells we unlocked): finds cell data in `_weeks`, sets `enabled = true`, lets Angular handler run
   - Fallback: if cell data not found, force selection via `selectedChange.emit()` or selection model API

5. **Month navigation** (`extension/content.js:736-738`)
   - Angular handles navigation (now that restrictions cleared)
   - DOM re-renders new month
   - Sub-observer fires, calls `unlockCalendar()` again with new cells

**State Management:**
- **Global capturedAuth**: `{ authorization: string }` — set once on first request, never changes
- **Global capturedPrivateKey**: Live reference to app's non-extractable ECDSA CryptoKey — set once, never changes
- **Global dpopSigner.jwk**: Public key material extracted from first DPoP token — set once, reused for all sub-requests
- **Global lastHeaderA**: Last-seen encryption key from response header `a` — updated per chunk, used for re-encryption
- **Per-XHR state**: `_pcMethod`, `_pcUrl`, `_pcHeaders` stored on xhr object — scoped to single request

## Key Abstractions

**DPoPSigner (lines 29-87):**
- Purpose: Encapsulates ECDSA JWT generation using captured key + extracted public key material
- Stores: `this.jwk` (public key from app's first DPoP token)
- Provides: `extractFromToken(dpopToken)` (parse header, extract jwk), `generateDPoP(method, url)` (forge new JWT)
- Pattern: Stateful singleton; methods are async and depend on `capturedPrivateKey` being set

**Response Envelope (lines 232-245):**
- Purpose: Wraps session data with AES-CBC encryption, carries key in HTTP response header
- Format: `{ data: "<hex>" }` (always encrypted on wire), header `a` contains key material
- Decryption: Extract key by stripping first 8 and last 8 chars of header `a`, AES-CBC with fixed IV `'tE5_yR0~uI2-oP4a'`
- Re-encryption: Take key from last chunk, re-encrypt merged data, send back with same header

**Session Merge (lines 262-282):**
- Purpose: Concatenate and deduplicate sessions from multiple chunks
- Dedup key: `sessionId` property (handles both `vm` array shape and `sessionIds` array shape)
- Returns: `{ vm: [deduped_sessions] }` — matches app's expected format

**Date Cell Model (lines 757-771):**
- Purpose: Represents a single calendar cell in Angular Material date picker
- Properties: `value` (day of month), `enabled` (boolean), others (marker, ariaLabel, etc.)
- Unlock pattern: Find cell in `_weeks` array, set `enabled = true` before click handler runs
- Fallback: Use selection model API if cell data not found

## Entry Points

**Manifest Injection (manifest.json:11-17):**
- Location: `extension/manifest.json`
- Triggers: Browser loads PokerCraft tab
- Responsibilities: Specifies `extension/content.js`, `"world": "MAIN"`, `"run_at": "document_start"`
- Why MAIN: Needed to override native fetch/XHR/crypto and read Angular internals
- Why document_start: Needed to capture originals before PokerCraft app code runs

**Script Initialization (lines 887-898):**
- Location: `extension/content.js`, lines 887-898
- Triggers: Script evaluation (immediate on injection)
- Responsibilities: Wait for document.body, call `patchDatePicker()`, enable date picker observer
- Entry point for date picker unlock subsystem

**Manual Debug Exports (line 285):**
- Exposed on `window.__pokercraftUnlocker` in DevTools console
- Exposes: `makeProofRequest()`, `debugFetchChunk()`, `dpopSigner`, `splitDateRange()`, `mergeResponses()`, `patchDatePicker()`, `log()`
- Purpose: Allows user to manually test DPoP token generation, chunk fetching, decryption without triggering app requests

## Architectural Constraints

- **Execution world: MAIN required** — Must run in page's JavaScript context to override native APIs. Isolated content scripts cannot access or modify `window.fetch`, `XMLHttpRequest`, or `crypto.subtle.sign`.

- **Run timing: document_start critical** — Must install hooks *before* PokerCraft app code runs, so original function references are captured. Missing this breaks everything downstream.

- **Non-extractable CryptoKey** — App uses `crypto.subtle.generateKey()` with `extractable: false`. Extension cannot copy the key; must keep live reference and use `originalCryptoSign()` with that key. If reference is lost (e.g., page reload), extension must wait for next key generation.

- **Session-bound auth** — DPoP token is bound to authorization header which is bound to HTTP session. Cannot be reused across tabs or profiles. If user logs out/in, extension re-captures on next request.

- **85-day server limit** — Reverse-engineered from PokerCraft's backend. Requests > 85 days fail or are truncated. Chunking is mandatory for long ranges, not optional.

- **AES-CBC + fixed IV** — Decryption scheme mirrors app's `decode.js`. Any changes to PokerCraft's encryption break extension. IV is hardcoded as 16-char string `'tE5_yR0~uI2-oP4a'`; web crypto requires exactly 16 bytes.

- **DOM coupling for date picker** — Only way to unlock calendar without reverse-engineering minified Angular code. Reads `min`/`max` attrs off `input[matStartDate]`/`input[matEndDate]`, falls back to fixed dates if not present. Fragile but version-agnostic (only matches Material CSS classes, not Angular component names).

- **Angular event dual-trigger** — Must fire both `onreadystatechange` property and `dispatchEvent('readystatechange')` because Angular/Zone.js listens via both. Missing either one breaks change detection.

- **No permissions required** — Extension intentionally has empty `permissions` array. Only uses content-script match pattern on PokerCraft domain.

## Anti-Patterns

### Over-eager DPoP token reuse

**What happens:** Extension generates DPoP token once, tries to reuse for multiple requests.
**Why it's wrong:** Each DPoP token includes `iat` (timestamp) and `jti` (unique ID). Server expects fresh token per request. Reuse causes 401 auth failures.
**Do this instead:** Line 219 — generate fresh token in loop for each chunk via `dpopSigner.generateDPoP()`.

### Skipping header 'a' re-attachment

**What happens:** Merge and re-encrypt response, but forget to set response header `a`.
**Why it's wrong:** App's decryption layer reads header `a` to extract AES key. Without it, decryption fails and app receives garbage.
**Do this instead:** Line 391, 467 — always include `'a': lastHeaderA` in response headers or getAllResponseHeaders() return value.

### Calling originalCryptoSign instead of app's key

**What happens:** Try to generate DPoP JWT using a new key generated locally instead of captured key.
**Why it's wrong:** DPoP is bound to app's session. Server verifies signature with app's public key. Local key signature fails 401.
**Do this instead:** Line 77-80 — always use captured `capturedPrivateKey` and JWK extracted from app's token.

### Mixing readyState event patterns

**What happens:** Fire `onreadystatechange` property but forget to dispatch `readystatechange` event (or vice versa).
**Why it's wrong:** Angular listens via both mechanisms. If one fires without the other, change detection may skip, UI doesn't update.
**Do this instead:** Lines 492-505 — always call property handler AND dispatch event for readystatechange, onload, onloadend.

---

*Architecture analysis: 2026-06-17*
