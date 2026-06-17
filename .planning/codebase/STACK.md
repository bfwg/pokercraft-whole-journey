# Technology Stack

**Analysis Date:** 2026-06-17

## Languages

**Primary:**
- JavaScript (ES2020+) - Content script logic in `extension/content.js`

**Secondary:**
- JSON - Manifest configuration

## Runtime

**Environment:**
- Chrome / Chromium (Manifest V3 extension)
- No Node.js required for shipped extension

**Execution Context:**
- Manifest V3 content script injected into `https://my.pokercraft.com/*`
- Injection world: `MAIN` (required to override page globals)
- Injection timing: `document_start` (before PokerCraft app code runs)

## Frameworks

**None.** This is a plain JavaScript extension with no build step, no bundlers, and no npm dependencies in the shipped code. All Web APIs are native browser APIs.

## Web APIs Used

**Cryptography:**
- `crypto.subtle.sign` - ECDSA signature generation (hooked to capture app's key)
- `crypto.subtle.importKey` - AES key import for decryption/encryption
- `crypto.subtle.decrypt` - AES-CBC decryption
- `crypto.subtle.encrypt` - AES-CBC encryption
- `crypto.randomUUID()` - DPoP token generation

**Network:**
- `window.fetch` - HTTP requests (hooked to intercept and synthesize responses)
- `XMLHttpRequest` - XHR interception (app's primary transport)
- `URL` / `URLSearchParams` - Query string parsing and construction

**DOM:**
- `MutationObserver` - Calendar popup detection and month navigation detection
- `Element.querySelector` / `querySelectorAll` - Date picker DOM traversal
- `__ngContext__` - Angular component instance extraction from DOM nodes

**Encoding:**
- `TextEncoder` / `TextDecoder` - UTF-8 string/bytes conversion
- `atob` / `btoa` - Base64 encoding for JWT construction

## Key Dependencies

**None in shipped extension.**

**Development only (`.pw-harness/`):**
- `playwright` ^1.61.0 - Browser automation for testing/diagnostics
- `classic-level` ^3.0.0 - Local LevelDB storage for test harness

## Configuration

**Extension Config:**
- File: `extension/manifest.json`
- Manifest version: 3
- Content script: `extension/content.js`
- Permissions: None (intentional — extension needs no Chrome permissions)
- Match pattern: `https://my.pokercraft.com/*`

**Runtime Toggles:**
- DEBUG flag: Line 313 in `extension/content.js` — set `const DEBUG = true;` to enable console logging (prefixed `[PokerCraft Whole Journey]`)
- Whole Journey toggle: `window.__pokercraftUnlocker.setWholeJourney(false)` disables date range expansion at runtime

## Platform Requirements

**Development:**
- Chrome or Chromium browser (for extension loading)
- DevTools console access (for testing utilities via `window.__pokercraftUnlocker`)

**Production (User):**
- Chrome or Chromium-based browser with Manifest V3 support
- Must be logged into `my.pokercraft.com` with valid PokerCraft account
- Cannot be packaged as headless automation (DPoP auth requires interactive session with real keys)

## Extension Initialization

**Execution order (critical):**
1. Line 1-6: Save original references (`originalFetch`, `originalXHROpen/Send/SetRequestHeader`, `originalCryptoSign`)
2. Line 15-25: Hook `crypto.subtle.sign` for ECDSA key capture
3. Line 347-403: Hook `window.fetch` for request interception
4. Line 408-517: Hook `XMLHttpRequest.open/send/setRequestHeader` for request interception
5. Line 887-898: Start calendar unlock observer via `patchDatePicker()`

**Why this order matters:**
- Original references must be saved before any app code runs (hence `"run_at": "document_start"`)
- Hooks must be in place before the PokerCraft app makes its first request
- Calendar observer is installed last (after page loads enough for `document.body` to exist)

## Testing Infrastructure

**Diagnostic Tools (Development):**
- `.pw-harness/diag.mjs` - Automated diagnostics (Playwright harness)
- `.pw-harness/extract-ls.mjs` - Extract session list data
- `.pw-harness/auth-probe.mjs` - Probe authentication/DPoP flow
- Manual testing: `window.__pokercraftUnlocker` exposes internal functions (line 285)

**No automated test suite:** Extension is tested manually in real logged-in Chrome against live PokerCraft site.

---

*Stack analysis: 2026-06-17*
