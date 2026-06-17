# External Integrations

**Analysis Date:** 2026-06-17

## Overview

This extension intercepts and extends PokerCraft's own API calls. It has **no backend of its own** and makes **no external HTTP calls** to third-party services. All integration is reverse-engineered from PokerCraft's network traffic.

## PokerCraft API Integration

**Target Endpoint:**
- `GET https://my.pokercraft.com/api/session/list/Holdem`
- Query parameters: `from` (timestamp ms), `to` (timestamp ms), `currency` (USD)
- Matched via `isTargetRequest()` at line 319-331 in `extension/content.js`

**Authentication:**
- Type: DPoP-bound (Demonstration of Proof-of-Possession)
- Headers required: `authorization` (bearer token) + `dpop` (signed JWT)
- Flow:
  1. App makes first `/api/session/list/Holdem` request with its own auth
  2. Extension hooks `XMLHttpRequest.setRequestHeader` (line 408) and `window.fetch` (line 347) to capture both headers
  3. Extension extracts app's ECDSA private key via `crypto.subtle.sign` hook (line 15)
  4. Extension extracts public JWK from app's DPoP token header via `DPoPSigner.extractFromToken()` (line 34-45)
  5. Extension generates fresh DPoP tokens using captured key for subsequent chunk requests

**Why DPoP binding matters:**
- DPoP tokens are bound to a specific (method, URL, timestamp, JTI) tuple via ECDSA signature
- Extension cannot mint tokens from scratch; it must use the captured private key
- This is why the extension requires at least one app-initiated request before chunking works

**Captured Material:**
- `capturedAuth` (line 10): `{ authorization: "<bearer-token>" }`
- `capturedPrivateKey` (line 11): Non-extractable `CryptoKey` (ECDSA, live reference)
- `dpopSigner.jwk` (line 31): Public key material extracted from first DPoP token

## Request/Response Envelope

**Request Interception:**
- Destination URL is matched and parsed (line 319-339)
- Date range `from`/`to` is extracted and checked for size
- If range > 85 days AND auth is captured, request is replaced by chunking engine
- Otherwise, request passes through to original implementation

**Response Envelope (Encrypted):**
```json
{
  "data": "<hex-encoded-aes-cbc-ciphertext>"
}
```

**Response Headers:**
- Header `a`: AES key material (32-char string)
  - Key derivation: Strip first 8 and last 8 characters → UTF-8 encode → use as AES-CBC key
  - Mirrors the app's own `decode.js` decryption scheme
  - Example: `"a": "xxxxxxxx<actual-16-chars>xxxxxxxx"` → AES key is the 16-char middle section

## Encryption/Decryption

**Algorithm:** AES-CBC with PKCS7 padding

**Fixed IV (Initialization Vector):** `'tE5_yR0~uI2-oP4a'` (16 UTF-8 bytes)
- Line 136 in `extension/content.js`: `const DECRYPT_IV = 'tE5_yR0~uI2-oP4a';`
- Used for both decryption (line 146-170) and re-encryption (line 176-190)

**Decryption Path:**
1. Response header `a` carries the key material
2. `decryptResponse(headerA, hexData)` (line 146-170):
   - Extract key: `headerA.substring(8, headerA.length - 8)`
   - Convert to UTF-8 bytes
   - Import as AES-CBC `CryptoKey`
   - Decrypt hex data using fixed IV
   - Remove PKCS7 padding
   - Parse resulting JSON

**Re-encryption Path:**
1. Chunked responses are merged via `mergeResponses()` (line 262-282)
2. Merged JSON is re-encrypted via `encryptData(keyStr, plaintext)` (line 176-190):
   - Uses same key extraction and fixed IV
   - Returns hex-encoded ciphertext
   - Wrapped in `{ data: "<hex>" }` envelope with header `a` set
3. App receives re-encrypted response as if it came from PokerCraft API
4. App's own decryption layer decrypts transparently

**Why re-encryption is critical:**
- PokerCraft app expects encrypted responses from its own server
- Extension must maintain that contract or app fails to parse
- Degraded fallback: If no encryption key seen, plaintext is returned (line 470)

## Chunking Protocol

**Server Limit:** PokerCraft API caps date ranges at ~85 days

**Chunking Strategy:**
- `splitDateRange(fromMs, toMs, chunkDays = 85)` (line 197-207): Splits range into 85-day chunks
- Each chunk is fetched separately with fresh DPoP token
- Requests spaced 300ms apart (line 256) to avoid rate limiting

**Chunk Request Example:**
```
GET /api/session/list/Holdem?from=1625702400000&to=1654291200000&currency=USD
Headers:
  authorization: <captured-bearer-token>
  dpop: <freshly-generated-jwt>
```

**DPoP Generation:**
- `DPoPSigner.generateDPoP(method, url)` (line 47-86)
- Constructs JWT header with ECDSA algorithm + captured JWK
- Payload includes:
  - `htm`: HTTP method (GET)
  - `htu`: HTTP URL (without query params)
  - `iat`: Current timestamp (seconds)
  - `jti`: Unique request ID (`crypto.randomUUID()`)
- Signs with captured private key using ECDSA + SHA-256
- Returns signed JWT token

## Session Merging

**Merge Strategy:**
- `mergeResponses(responses, originalFromMs, originalToMs)` (line 262-282)
- Concatenates sessions from all chunk responses
- De-duplicates by `sessionId` (handles both `vm` array and `sessionIds` properties)
- Returns merged result as `{ vm: [...] }`

**Supported Response Shapes:**
- Shape 1: `{ vm: [...sessions] }`
- Shape 2: `{ sessionIds: [...] }`
- All sessions deduplicated by `sessionId` property

## Date Picker UI Integration

**No API calls — DOM manipulation only**

**Affected UI Element:**
- Angular Material datepicker (mat-datepicker)
- Material Design Components version (MDC Material — post-2024 PokerCraft update)
- Note: This replaced an earlier calendar-unlock approach that relied on older Angular Material API, which broke when PokerCraft migrated to MDC

**DOM Coupling Points:**
1. Input fields (for fallback date bounds):
   - `input[matStartDate]`: Custom range start (min attribute used as fallback)
   - `input[matEndDate]`: Custom range end (max attribute used as fallback)
   - Read at line 370 (getEarliestMs/getLatestMs helpers, not in visible content.js snippet)

2. Calendar popup detection:
   - Selector: `.mat-datepicker-popup` or `mat-datepicker-content`
   - Detected via `MutationObserver` watching `document.body` (line 831-882)

3. Calendar state extraction:
   - Angular component instances accessed via `__ngContext__` array on DOM nodes
   - `MatCalendar` component: Has `monthView`, `_currentView`, `_minDate`, `_maxDate` properties
   - `MatMonthView` component: Has `_weeks`, `selectedChange`, `_dateAdapter` properties
   - See component detection functions (line 542-582)

**Unlock Behavior:**
- Removes HTML `disabled` attribute from navigation buttons
- Removes CSS class `mat-calendar-body-disabled` from date cells
- Removes `aria-disabled` attribute
- Clears `_minDate`/`_maxDate` restrictions in Angular component state
- Prevents clicks on future-date cells by re-disabling them if Angular leaves them enabled

## Fallback Behavior

**When Auth Not Yet Captured:**
- Line 376-399: Large-range requests pass through untouched
- Logged: "Large range detected but no auth captured yet — passing through"
- This allows the first app request to complete normally

**When No Encryption Key Seen:**
- Line 470: Merged response returned as plaintext JSON
- Logged: "Warning: no encryption key available, returning plaintext"
- App may fail to decrypt if it always expects encryption, or may handle plaintext fallback

**When Chunking Fails:**
- Line 507: Falls back to original XHR send
- Logged: "Chunking failed, falling back to original request: [error]"
- Allows partial/incomplete requests rather than total failure

## Manual Testing & Debugging

**Exposed Utilities (line 285):**
```javascript
window.__pokercraftUnlocker = {
  makeProofRequest,           // Test sub-request with captured auth
  debugFetchChunk,           // Fetch single 7-day chunk and show raw/decrypted response
  dpopSigner,                // DPoP signer instance
  splitDateRange,            // Test range chunking
  mergeResponses,            // Test response merging
  patchDatePicker,           // Force calendar unlock (if mounted)
  log                        // Logging function
}
```

**Example DevTools Usage:**
```javascript
// Check if auth is captured
window.__pokercraftUnlocker.makeProofRequest()

// Fetch and decrypt a single chunk
const data = await window.__pokercraftUnlocker.debugFetchChunk()

// Test range splitting
const chunks = window.__pokercraftUnlocker.splitDateRange(
  Date.now() - 365*24*60*60*1000, Date.now()
)
```

**Logging:**
- Enabled: Set `const DEBUG = true;` at line 313
- All output prefixed with `[PokerCraft Whole Journey]`

---

*Integration audit: 2026-06-17*
