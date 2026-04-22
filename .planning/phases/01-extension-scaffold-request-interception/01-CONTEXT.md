# Phase 1: Extension Scaffold & Request Interception - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

A working Chrome MV3 extension that intercepts Pokercraft API calls to `/api/session/list/Holdem` and proves that authenticated sub-requests with valid DPoP tokens can be made. No chunking or merging — just prove interception and auth work.

</domain>

<decisions>
## Implementation Decisions

### DPoP Acquisition Strategy
- Primary approach: hook into the app's DPoP interceptor chain so sub-requests automatically get valid tokens
- DPoP must be present on all sub-requests — not optional
- If hooking the app's chain fails, fallback to extracting the ES256 CryptoKey and signing DPoP JWTs manually
- Phase 1 proof: just one manually triggered sub-request returning a valid authenticated response
- Strategy for patch-timing vs DPoP-wrapper tradeoff: OpenCode's discretion (see note below)

### Fetch vs XHR Approach
- Patch BOTH window.fetch and XMLHttpRequest proactively — don't guess which one Angular uses
- Patch at `document_start` before the app loads to guarantee complete interception
- Save references to original fetch/XHR before patching for passthrough of non-target requests
- **Note:** Patching before app load means originalFetch bypasses the app's DPoP wrapper. OpenCode must figure out the right strategy (e.g., capture app-wrapped fetch later, or handle DPoP manually for sub-requests)

### Request Matching Logic
- Match exact path `/api/session/list/Holdem` — not a broad pattern
- Require both `from` and `to` query parameters to be present before intercepting
- Verify request domain is `my.pokercraft.com`
- Non-matching requests pass through completely unmodified

### Debug Output Style
- All console logs prefixed with `[Pokercraft Unlocker]` for easy DevTools filtering
- Logging always on (no toggle needed for Phase 1 — it's a dev tool)
- No extension badge for Phase 1
- Log key events: interception detected, date range parsed, DPoP status, sub-request result

### OpenCode's Discretion
- Exact patch timing strategy to balance early interception vs DPoP wrapper access
- Internal code structure (single file vs modular)
- Error handling patterns
- How to locate and call the app's DPoP generation function if direct hooking is needed

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `decode.js`: AES-CBC decryption reference (key from response header `a`, IV `tE5_yR0~uI2-oP4aL6kS8jD1fG3hH9z1`). Not directly used in the extension but documents the encryption protocol.
- `main.94912d4608d7e262.js`: Target app. Obfuscated with string array rotation (`a30_0x5bf0()`). Contains config `sessionHands: { size: 0x4e20, month: 0x3 }` (possibly dead code).

### Established Patterns
- App uses obfuscated Angular with DPoP per-request token generation (ES256)
- API auth: Bearer JWT + DPoP header + Cloudflare cookies
- DPoP JWT payload includes `htm` (method), `htu` (URL), `iat` (timestamp), `jti` (unique ID)
- Response encryption: AES-CBC, key derived from response header `a` (strip first/last 8 chars)

### Integration Points
- Content script injects into `my.pokercraft.com` in MAIN world
- Intercepts at `window.fetch` and `XMLHttpRequest.prototype.open/send` level
- Extension operates within existing browser session (uses browser's cookies and JWT)

</code_context>

<specifics>
## Specific Ideas

- The curl example from the user shows the exact headers needed: authorization (Bearer JWT), dpop, loc, cookies (__cf_bm, _cfuvid), plus standard browser headers
- DPoP JWT uses ES256 with JWK containing P-256 curve public key in the header
- API endpoint format: `GET https://my.pokercraft.com/api/session/list/Holdem?from={ms_timestamp}&to={ms_timestamp}&currency=USD`

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-extension-scaffold-request-interception*
*Context gathered: 2026-04-22*
