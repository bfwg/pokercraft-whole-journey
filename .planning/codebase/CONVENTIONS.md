# Coding Conventions

**Analysis Date:** 2026-06-17

## Naming Patterns

**Files:**
- Single lowercase with `.js` extension: `content.js`, manifest file `manifest.json`
- Script files in harness: `.mjs` (ES modules): `diag.mjs`, `auth-probe.mjs`, `extract-ls.mjs`

**Functions:**
- camelCase for all function names: `makeProofRequest()`, `decryptResponse()`, `isTargetRequest()`, `generateDPoP()`, `splitDateRange()`
- Utility functions are lowercase/camelCase: `log()`, `hexToBytes()`, `bytesToHex()`
- Private/internal functions follow same camelCase: `patchDatePicker()`, `unlockCalendar()`, `findMonthView()`

**Variables:**
- camelCase for all variables and constants: `capturedAuth`, `capturedPrivateKey`, `lastHeaderA`, `originalFetch`
- const for module-level state references: `const originalFetch = window.fetch.bind(window)`, `const dpopSigner = new DPoPSigner()`
- Instance properties: `this.jwk`, `this._pcMethod`, `this._pcHeaders`
- Naming indicates state purpose: `capturedAuth`, `lastHeaderA`, `debounceTimer`, `enabledCells`

**Types/Classes:**
- PascalCase for classes: `DPoPSigner`, `Request`, `Response`, `ProgressEvent`, `URL`, `Map`, `Set`
- No type annotations (vanilla JavaScript — types inferred from usage)
- Object properties/field names follow camelCase: `{ authorization, dpop }`, `{ from, to, days }`

## Code Style

**Formatting:**
- No explicit formatter configured (no `.prettierrc`, `.eslintrc`, or similar)
- Indentation: 2 spaces (observed throughout `content.js`)
- Line length: varies; most lines under 100 characters except long comments
- Semicolons: present on most statements; optional for some (dangling ones omitted on object literals)
- Brace style: K&R (opening brace on same line)

**Linting:**
- No linter or formatter detected (no ESLint, Prettier, Biome config)
- Code style is maintained manually

## Import Organization

**Module references (content.js has NO import/export):**
- All code runs in the global scope of a content script
- References to browser APIs are implicit: `window.*`, `document.*`, `XMLHttpRequest`, `crypto.subtle`
- Original references saved at module start via immediate assignment:
  ```javascript
  const originalFetch = window.fetch.bind(window);
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalCryptoSign = crypto.subtle.sign.bind(crypto.subtle);
  ```
- Rationale: `document_start` injection (`manifest.json:16`) requires capturing originals before app code installs its own hooks

**Harness modules (ES6 imports in `.mjs` files):**
- `diag.mjs`: `import { chromium } from 'playwright'; import fs from 'fs'; import path from 'path';`
- `auth-probe.mjs`: Similar imports from Playwright + Node.js stdlib

## Error Handling

**Patterns:**
- try/catch with fallback behavior (no throw unless critical):
  ```javascript
  try {
    const [headerB64] = dpopToken.split('.');
    // base64url decode
    const padded = headerB64.replace(/-/g, '+').replace(/_/g, '/');
    const header = JSON.parse(atob(padded));
    this.jwk = header.jwk;
    log('Extracted JWK from DPoP header:', JSON.stringify(this.jwk));
  } catch (err) {
    log('Failed to extract JWK from DPoP token:', err.message);
  }
  ```
- Errors logged but not re-thrown when they indicate degraded (but functional) operation
- Throw new Error() only for unrecoverable conditions (lines 49, 52):
  ```javascript
  if (!capturedPrivateKey) {
    throw new Error('No CryptoKey captured yet');
  }
  ```
- Fallback on XHR chunking failure (line 507): `originalXHRSend.call(xhr, body)` — reverts to passthrough if merging fails

- null-check guards before accessing properties:
  ```javascript
  if (!capturedAuth?.authorization) {
    log('Cannot make proof request — no auth captured yet...');
    return;
  }
  ```

## Logging

**Framework:** `console.log()` (no external library)

**Patterns:**
- Controlled via DEBUG flag (line 313): `const DEBUG = false;`
- To enable: set to `true` and reload extension from `chrome://extensions/`
- All logs prefixed with `[PokerCraft Whole Journey]` (line 316):
  ```javascript
  function log(...args) {
    if (DEBUG) console.log('[PokerCraft Whole Journey]', ...args);
  }
```
- Exposed via `window.__pokercraftUnlocker.log` for DevTools console access
- Logs include context: `log('Chunk ${i + 1}/${chunks.length}:', message)` (line 249, similar patterns)
- No external logging service; logs appear only in extension DevTools console

## Comments

**When to Comment:**
- Function purpose and complex logic paths documented
- DOM structure reverse-engineered from PokerCraft diagnostics (lines 522-540):
  ```javascript
  /**
   * DOM structure (from diagnostics):
   *   div.cdk-overlay-pane.mat-datepicker-popup
   *     mat-datepicker-content
   *       mat-calendar
   *         mat-calendar-header
   *           button.mat-calendar-previous-button (prev month)
   *   ...
   */
  ```
- Architecture overview in CLAUDE.md (project file; not in code)
- Rationale for subtle design decisions (line 726-735, nav button handling):
  ```javascript
  // If the button is disabled (HTML attr), Angular's handler won't fire.
  // Remove disabled so the click reaches Angular's handler.
  if (navBtn.disabled) {
    navBtn.disabled = false;
    navBtn.classList.remove('mat-button-disabled');
  }
  // DON'T stopPropagation — let Angular handle the navigation inside Zone.js
  ```

**JSDoc/TSDoc:**
- Minimal usage; not enforced
- Comments use markdown-style formatting where present:
  ```javascript
  /**
   * Find the MatMonthView component instance from the calendar popup.
   */
  function findMonthView(popup) {
    // ...
  }
  ```

## Function Design

**Size:**
- Small, focused functions (most < 50 lines)
- Exceptions: `unlockCalendar()` (89 lines, line 590-678) and `installClickInterceptor()` (145 lines, line 680-825) handle complex DOM manipulation
- Rationale: Date picker reverse-engineering required detailed state management

**Parameters:**
- Explicit, descriptive names: `makeProofRequest()` takes none; `decryptResponse(headerA, hexData)`
- Objects passed for logical grouping: `{ authorization, dpop }` captured auth
- URL strings passed as-is; parsed internally with `new URL()`

**Return Values:**
- Most functions return data directly: `mergeResponses()` returns `{ vm: [...] }`
- Async functions return Promises: `generateDPoP()`, `decryptResponse()`, `encryptData()`
- Null returned as signal (no error): `extractFromToken()` returns undefined on success, logs and continues on parse failure
- Passthrough fallback on error (XHR path): returns without calling originalXHRSend on interception success, falls back to originalXHRSend on error

## Module Design

**Exports:**
- No explicit export syntax (content.js is a content script, runs in MAIN world)
- Subsystems exposed via `window.__pokercraftUnlocker` (line 285):
  ```javascript
  window.__pokercraftUnlocker = { makeProofRequest, dpopSigner, log, splitDateRange, mergeResponses, debugFetchChunk, patchDatePicker };
  ```
- Enables manual testing in DevTools console: `window.__pokercraftUnlocker.makeProofRequest()`
- Members: functions for testing (`makeProofRequest`, `debugFetchChunk`), utilities (`dpopSigner`, `log`, `splitDateRange`, `mergeResponses`), and setup (`patchDatePicker`)

**Barrel Files:**
- Not applicable (single-file extension)

## State Management

**Module-level state (initialized at load):**
- `capturedAuth` (line 10): null → { authorization, dpop } after first app request
- `capturedPrivateKey` (line 11): null → live CryptoKey reference after first app signature
- `dpopSigner` (line 89): singleton instance, initialized once
- `lastHeaderA` (line 193): null → encryption key from last response header
- `wholeJourneyEnabled` (referenced in CLAUDE.md): defaults to true, controlled via `window.__pokercraftUnlocker.setWholeJourney(false)`

**Instance state (XHR interception):**
- `xhr._pcMethod`, `xhr._pcUrl`, `xhr._pcHeaders` (lines 415-419): tracked per-request for interception logic
- `xhr._dateClickInterceptor` (line 682): flag to prevent duplicate listener installation
- `popup._wasDisabled` (line 648): marks calendar cells that were unlocked for click handling

**Closure state (patchDatePicker):**
- `calendarObserver`, `debounceTimer`, `bodyObserver` (lines 828-831): scoped to patchDatePicker function, alive for extension lifetime

## Control Flow Patterns

**Async/await:**
- All crypto and fetch operations wrapped in async: `async function makeProofRequest()`, `async function fetchChunks()`
- Error handling via try/catch within async functions
- No Promise.then() chains (await preferred)

**Event listeners:**
- MutationObserver for calendar popup detection (line 831): reacts to DOM changes
- Click interceptor in capture phase (line 822): `addEventListener(..., true)` ensures runs before Angular's handlers
- Event dispatching (lines 495, 500, 505): manual dispatch of `readystatechange`, `load`, `loadend` because XHR response is synthesized

**Timing:**
- setTimeout for debouncing (line 853): 150ms debounce on calendar re-unlock after navigation
- 300ms delay between chunk requests (line 256): `await new Promise((r) => setTimeout(r, 300))` to avoid overwhelming server
- setTimeout retry for month navigation re-render (line 737): 200ms before re-unlocking calendar

---

*Convention analysis: 2026-06-17*
