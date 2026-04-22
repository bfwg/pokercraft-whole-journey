# Domain Pitfalls

**Domain:** Chrome MV3 extension intercepting encrypted API responses
**Researched:** 2026-04-22

## Critical Pitfalls

Mistakes that cause rewrites or "it just doesn't work" dead ends.

### Pitfall 1: Content Script Cannot Access Page JS Context (World Isolation)

**What goes wrong:** Content scripts run in an isolated world. You cannot call `window.fetch`, monkey-patch XHR, or access Angular's runtime objects from a content script. Your fetch/XHR interceptor simply never fires because it's patching a *different* `window`.

**Why it happens:** MV3 content scripts share the DOM but have a separate JS execution context. The page's `fetch` and the content script's `fetch` are different objects.

**Consequences:** The entire interception strategy fails silently. No errors, just nothing happens.

**Prevention:** Inject a script into the page's MAIN world. Two approaches:
1. `manifest.json` → `"content_scripts"` with `"world": "MAIN"` (Chrome 111+). Simplest, most reliable.
2. Inject a `<script>` element from a content script with `src` pointing to a `web_accessible_resources` file.

Option 1 is strongly preferred — it's declarative and runs before page scripts load if `"run_at": "document_start"`.

**Detection:** Your fetch interceptor never logs anything. The page's network requests proceed untouched.

**Phase:** Must be solved in Phase 1. Everything depends on this.

### Pitfall 2: DPoP Token Generation Cannot Be Reimplemented — Must Reuse App's

**What goes wrong:** You try to generate DPoP tokens yourself using a JWK/ES256 keypair, but the server rejects them because the DPoP proof must use the *same* keypair the app generated at session init (the public key is bound to the session/JWT).

**Why it happens:** DPoP binds a proof-of-possession keypair to the session. The server knows the public key from the initial token exchange. A new keypair = invalid proof.

**Consequences:** All chunked sub-requests return 401. You can decrypt nothing.

**Prevention:** Hook into the app's existing DPoP generation function rather than reimplementing it. Since you're in the MAIN world, find the function that generates DPoP headers (likely produces a JWT with `htu` and `htm` claims) and call it directly for each sub-request. Runtime analysis with breakpoints on the `Authorization`/`DPoP` header setting is the fastest way to locate it.

**Detection:** Sub-requests return 401 or 403 despite correct Bearer token.

**Phase:** Phase 1-2. Must locate and hook the DPoP function before chunking works.

### Pitfall 3: Race Condition — Interceptor Installs After First API Call

**What goes wrong:** The page fires API requests before your MAIN world script has finished patching `fetch`/`XHR`. The initial session list load slips through unpatched.

**Why it happens:** Angular apps often fire API calls during bootstrap. If your script injects even slightly late, the first call is already in flight.

**Consequences:** The first page load works with the original 3-month restriction. User must manually trigger a reload/re-query.

**Prevention:**
- Use `"run_at": "document_start"` + `"world": "MAIN"` in manifest. This runs before any page `<script>` tags execute.
- Patch `window.fetch` and `XMLHttpRequest.prototype.open/send` synchronously at the top of your injected script — no `await`, no dynamic imports before the patch.

**Detection:** First API call in Network tab has no interception; subsequent ones work.

**Phase:** Phase 1. Get injection timing right from the start.

### Pitfall 4: Merging Chunked Responses Incorrectly

**What goes wrong:** You split a 6-month range into 25-day chunks, fire them all, but the merged response has duplicates, wrong `fromTime`/`toTime`, or the `remain` field confuses the app into paginating infinitely.

**Why it happens:** The response schema has `remain` (remaining sessions count), `fromTime`/`toTime` boundaries, and `sessionIds` array. Naive concatenation produces inconsistent metadata.

**Consequences:** Angular app shows duplicate sessions, triggers infinite scroll/pagination loops, or shows wrong date ranges.

**Prevention:**
- Deduplicate `sessionIds` (sessions spanning chunk boundaries may appear in two chunks).
- Set `fromTime` to the earliest chunk's `fromTime`, `toTime` to the latest chunk's `toTime`.
- Set `remain` to `0` — you've already fetched everything. This tells the app there's no more data to load.
- Sort merged sessions in the same order the app expects (likely descending by time).

**Detection:** Duplicate entries in the UI. Infinite loading spinner. Console errors about unexpected data shapes.

**Phase:** Phase 2-3. Core chunking/merging logic.

### Pitfall 5: MV3 Service Worker Dies Mid-Operation

**What goes wrong:** You put chunking logic in the service worker (background script). It goes idle during the sequential API calls and Chrome kills it (30-second idle timeout, 5-minute hard limit).

**Why it happens:** MV3 service workers are ephemeral. They terminate when idle. Long-running operations get killed.

**Consequences:** Some chunks complete, others don't. Partial data returned or silent failure.

**Prevention:** **Don't use the service worker for request logic.** Do everything in the MAIN world injected script. You're already in the page context with access to `fetch`, cookies, and the DPoP function. The service worker should only handle extension lifecycle (install, icon badge, etc.) — not API orchestration.

**Detection:** Requests stop mid-sequence. `chrome://serviceworker-internals` shows worker terminated.

**Phase:** Architecture decision in Phase 1. Don't put business logic in the service worker.

## Moderate Pitfalls

### Pitfall 6: AES-CBC Decryption Key/IV Changes Between Versions

**What goes wrong:** The hardcoded AES key (from response header `a`) or IV changes when Pokercraft deploys a new `main.*.js`. Your extension breaks silently — decryption produces garbage.

**Prevention:** Extract the decryption key dynamically at runtime rather than hardcoding. Hook the app's own decryption function, or read header `a` from each response. The IV should also be extracted from the app's code at runtime if possible. If hardcoded, add a health check: if decrypted JSON fails `JSON.parse`, alert the user that the extension needs updating.

**Detection:** `JSON.parse` throws on decrypted response. Garbled text in decrypted output.

**Phase:** Phase 2. Build decryption to be resilient.

### Pitfall 7: Patching the Date Picker in Obfuscated Code is Fragile

**What goes wrong:** You find the date picker restriction by searching for `0x3` (3 months) in the obfuscated JS and patch it. Next deploy, the obfuscation rotates variable names and hex offsets. Your patch targets stale code.

**Prevention:** Two approaches (use both):
1. **Runtime DOM patch:** Instead of patching JS, remove `min`/`max` attributes from the date picker input elements via a MutationObserver. Angular Material date pickers use standard `<input>` elements with `min`/`max`.
2. **Monkey-patch the Angular component:** If DOM patching isn't sufficient (the component may validate internally), intercept at the point where the date range is passed to the API call — you're already intercepting fetch, so just override the `from`/`to` query params regardless of what the picker sends.

**Detection:** Date picker still restricts selection despite extension being active.

**Phase:** Phase 1-2. Try DOM approach first; fall back to fetch param override.

### Pitfall 8: CORS / CSP Blocks Injected Scripts

**What goes wrong:** The site's Content-Security-Policy blocks your injected `<script>` tag or inline script execution.

**Prevention:** Using `"world": "MAIN"` in manifest with `"content_scripts"` bypasses CSP entirely — Chrome injects it as an extension-privileged script, not a page script. If you must use the `<script src>` injection method, the file must be in `web_accessible_resources` and CSP `script-src` must allow it (Chrome extensions get an exception for `web_accessible_resources`). Prefer the manifest `"world": "MAIN"` approach.

**Detection:** Console shows CSP violation errors. Script doesn't execute.

**Phase:** Phase 1 — choose the right injection method.

### Pitfall 9: Parallel Chunk Requests Trigger Rate Limiting

**What goes wrong:** You fire 10+ chunk requests simultaneously. The server (or Cloudflare) rate-limits or blocks you.

**Prevention:** Send chunk requests sequentially or with a small concurrency limit (2-3 at most). Add a small delay (200-500ms) between requests. This is slower but reliable.

**Detection:** Requests return 429 or Cloudflare challenge pages.

**Phase:** Phase 2-3. Chunking implementation.

## Minor Pitfalls

### Pitfall 10: `web_accessible_resources` Exposes Files to All Sites

**What goes wrong:** You set `"matches": ["<all_urls>"]` in `web_accessible_resources`, allowing any site to detect/probe your extension.

**Prevention:** Scope to `"matches": ["https://my.pokercraft.com/*"]` only.

**Phase:** Phase 1 — manifest setup.

### Pitfall 11: Forgetting to Handle Pagination in Chunk Responses

**What goes wrong:** Each chunk request itself might return paginated results (if a 25-day chunk has more sessions than the page size). You only get the first page of each chunk.

**Prevention:** Check if the API response's `remain` > 0 for individual chunks. If so, paginate within each chunk before moving to the next. Alternatively, use smaller chunk sizes (e.g., 7 days) to stay under any per-request session limit.

**Detection:** Missing sessions in the middle of date ranges. `remain` > 0 in individual chunk responses.

**Phase:** Phase 2-3.

### Pitfall 12: Communication Between MAIN World Script and Extension

**What goes wrong:** You need the MAIN world script to communicate with the content script (for settings, status). Using `window.postMessage` but forgetting to filter by origin/source, causing conflicts with the page's own postMessage usage.

**Prevention:** Use a unique message type/channel identifier (e.g., `{ type: "POKERCRAFT_DECODER", ... }`). Always check `event.source === window` and verify the message structure. Alternatively, use `CustomEvent` on `document` with a namespaced event name.

**Detection:** Messages get swallowed or cause errors in the page's own message handlers.

**Phase:** Phase 1 if cross-context communication is needed.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Script injection & fetch interception | World isolation (#1), timing (#3), CSP (#8) | Use `"world": "MAIN"` + `"run_at": "document_start"` in manifest |
| DPoP token reuse | Reimplementation fails (#2) | Hook app's existing DPoP function via runtime analysis |
| Chunking & merging | Bad merge (#4), rate limiting (#9), pagination (#11) | Sequential requests, deduplicate, set `remain: 0` |
| Date picker unlock | Fragile obfuscation patching (#7) | DOM-level patch via MutationObserver |
| Architecture | Service worker misuse (#5) | All logic in MAIN world script, service worker is minimal |
| Decryption | Key/IV changes (#6) | Extract dynamically, validate with JSON.parse |

## Sources

- Chrome MV3 content script world documentation (HIGH confidence — well-documented API)
- DPoP RFC 9449 binding semantics (HIGH confidence)
- MV3 service worker lifecycle behavior (HIGH confidence — widely reported)
- AES-CBC and response merging pitfalls (MEDIUM confidence — project-specific, based on decode.js context)
