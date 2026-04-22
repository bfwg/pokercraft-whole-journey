# Technology Stack

**Project:** Pokercraft Date Range Unlocker
**Researched:** 2026-04-22

## Recommended Stack

This is a single-purpose Chrome extension with no backend, no UI framework, and no build pipeline needed. Keep it minimal.

### Core Platform
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Chrome Extension Manifest V3 | MV3 | Extension platform | Required; MV2 is deprecated and removed from Chrome Web Store |
| Vanilla JavaScript (ES2022+) | — | All extension code | No framework needed for this scope; content scripts + service worker only |

### Extension Components
| Component | File(s) | Purpose | Why |
|-----------|---------|---------|-----|
| Service Worker | `background.js` | Coordinate request interception, manage chunk splitting logic | MV3 replaces background pages with service workers |
| Content Script | `content.js` | Inject into Pokercraft pages, patch date picker, monkey-patch fetch/XHR | Only way to access page JS context and intercept network calls from the page |
| Injected Script | `inject.js` | Runs in page context (MAIN world) to intercept fetch/XHR directly | Content scripts run in isolated world; to patch `window.fetch` you must inject into MAIN world |

### Crypto
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Web Crypto API (built-in) | — | AES-CBC decryption of API responses | Built into browser, no library needed; the existing `decode.js` already uses this pattern |
| Web Crypto API (built-in) | — | DPoP token handling (ES256/ECDSA) | If we need to generate DPoP tokens ourselves; otherwise hook the app's own generation |

### Dev Tools
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| None (no bundler) | — | — | Extension is <5 files of vanilla JS; a bundler adds complexity with zero benefit |

## What NOT to Use

| Technology | Why Not |
|------------|---------|
| **Webpack/Vite/Rollup** | Unnecessary for <5 vanilla JS files. Adds build step, source map complexity, debugging friction. Only justified if you add TypeScript or npm dependencies — you won't. |
| **React/Vue/Svelte** | No popup UI beyond maybe a simple toggle. Zero rendering needs. |
| **TypeScript** | Scope is tiny (~200-400 lines total). Type safety overhead not justified. If you want types, use JSDoc `@type` comments with VS Code inference. |
| **CRXJS / Plasmo / WXT** | Extension framework overhead for a 3-file extension is absurd. These are for complex extensions with multiple pages, state management, etc. |
| **node-forge / crypto-js** | Web Crypto API handles AES-CBC and ECDSA natively. No npm crypto libraries needed. |
| **axios / got** | Content script intercepts `fetch`; no HTTP client library needed. |
| **chrome.declarativeNetRequest** | MV3's declarative API is for blocking/redirecting by rules. We need to **read, split, and merge** request/response bodies programmatically. Must use fetch interception in page context instead. |
| **chrome.webRequest** | MV3 removed blocking webRequest for extensions (only available to enterprise policy-installed). Cannot modify response bodies anyway. |

## Architecture Decision: MAIN World Injection

**Critical:** Content scripts run in an isolated world. They share the DOM but NOT `window.fetch`, `XMLHttpRequest`, or any JS globals with the page.

To intercept the Angular app's API calls, you MUST inject a script into the MAIN world:

```json
// manifest.json
{
  "content_scripts": [{
    "matches": ["https://my.pokercraft.com/*"],
    "js": ["inject.js"],
    "world": "MAIN",
    "run_at": "document_start"
  }]
}
```

**Confidence: HIGH** — This is the standard MV3 pattern. The `"world": "MAIN"` field was added in Chrome 111+ (2023) specifically for this use case.

## Architecture Decision: Fetch Monkey-Patching

The inject script overrides `window.fetch` before the Angular app loads:

```javascript
const originalFetch = window.fetch;
window.fetch = async function(url, options) {
  if (typeof url === 'string' && url.includes('/api/session/list/Holdem')) {
    // Parse date range, split into 25-day chunks
    // Make multiple originalFetch calls
    // Merge responses, return single Response
    return mergedResponse;
  }
  return originalFetch.apply(this, arguments);
};
```

**Why fetch not XHR:** Angular's HttpClient uses fetch in modern builds. Verify at runtime — if XHR, patch `XMLHttpRequest.prototype.open/send` instead. Patch both to be safe.

## Architecture Decision: DPoP Token Strategy

Two options, in order of preference:

1. **Hook the app's DPoP generator (preferred):** Find where the app creates DPoP tokens and expose/call that function for each chunk request. Avoids reimplementing ES256 signing. Since we're in MAIN world, we can access any global or module-level function the app exposes.

2. **Reimplement DPoP signing:** Use Web Crypto API to sign JWTs with ES256. Only if the app's generator can't be hooked. The private key must be extractable from the app's runtime (it's generated client-side per session).

**Confidence: MEDIUM** — Strategy 1 depends on how the obfuscated app structures its DPoP logic. May need runtime debugging to locate.

## Manifest V3 Permissions

```json
{
  "manifest_version": 3,
  "name": "Pokercraft Date Unlocker",
  "version": "1.0",
  "permissions": [],
  "host_permissions": ["https://my.pokercraft.com/*"],
  "content_scripts": [{
    "matches": ["https://my.pokercraft.com/*"],
    "js": ["inject.js"],
    "world": "MAIN",
    "run_at": "document_start"
  }]
}
```

Minimal permissions. No `storage`, `tabs`, `webRequest`, or other APIs needed. The MAIN world script does everything.

## Installation

```bash
# No installation. No npm. No build.
# Load unpacked extension from the project directory.
```

## File Structure

```
/
├── manifest.json        # Extension manifest
├── inject.js            # MAIN world script: fetch patch + date picker patch + chunk logic
└── icons/               # Optional extension icons
```

That's it. Possibly a second content script if you need isolated-world ↔ MAIN-world messaging, but try to keep everything in the MAIN world script first.

## Sources

- Chrome MV3 content script worlds: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#isolated_world (HIGH confidence)
- `"world": "MAIN"` support: Chrome 111+, stable since March 2023 (HIGH confidence)
- Web Crypto API AES-CBC: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/decrypt (HIGH confidence)
- DPoP spec (RFC 9449): ES256 signed JWT proof-of-possession tokens (HIGH confidence)
- Training data for MV3 patterns (MEDIUM confidence — verified against Chrome docs)
