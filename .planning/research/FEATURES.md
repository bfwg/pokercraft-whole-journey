# Feature Landscape

**Domain:** Chrome extension — API request interceptor for Pokercraft date range unlocking
**Researched:** 2026-04-22

## Table Stakes

Features the extension must have or it's useless. These come directly from the core value prop.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Date picker patch | Without this, user can't select ranges > 3 months | Medium | Must locate restriction in obfuscated Angular code at runtime; inject content script to override |
| Fetch/XHR interception | Core mechanism — intercept `session/list/Holdem` calls | Medium | Manifest V3 uses service workers; intercept via content script monkey-patching `fetch`/`XMLHttpRequest.prototype` |
| Date range chunking (25-day splits) | Server rejects large ranges; chunking is the entire point | Low | Pure date math — split `[from, to]` into consecutive 25-day windows |
| DPoP token reuse from app | Each sub-request needs a valid DPoP; can't generate independently without private key | High | Must hook into app's own token generation or extract the CryptoKey from the app's scope. This is the hardest part. |
| Response merging | App expects one response; must stitch chunk responses into unified shape | Medium | Merge `sessionIds` arrays, adjust `fromTime`/`toTime` bounds, set `remain` correctly |
| AES-CBC response decryption handling | Responses are encrypted; merged result must match expected format | Low-Med | Extension can either: (a) let each chunk decrypt naturally through app's pipeline then merge, or (b) decrypt chunks itself using known key/IV from `decode.js` |
| Transparent injection | App must not know splitting happened — no UI glitches, no console errors | Medium | Merged response must be structurally identical to a single native response |
| Manifest V3 packaging | Chrome Web Store and modern Chrome require MV3 | Low | Standard boilerplate; service worker + content script |

## Differentiators

Nice-to-have features that improve UX but aren't required for core functionality.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Progress indicator | Large date ranges = many chunks; user should see it's working, not frozen | Low | Badge text on extension icon showing "3/12" chunk progress |
| Request caching | Avoid re-fetching already-retrieved date ranges on page reload | Low | Cache chunk responses in `chrome.storage.local` keyed by date range |
| Error recovery / partial results | If chunk 7/12 fails, show the 6 that succeeded rather than failing entirely | Medium | Retry failed chunks; surface partial data with warning |
| Extension popup with status | Show current state: active/inactive, last query stats, session validity | Low | Simple popup HTML — not critical but polished |
| Rate limiting / request throttling | Avoid hammering API with 20 parallel requests; prevent potential IP blocking | Low | Sequential or batched (3-4 concurrent) chunk requests with small delays |
| Support for other game types | `session/list/PLO`, `session/list/ShortDeck`, etc. | Low | Same interception logic, different URL path. Defer per project scope. |
| Export to CSV | Users wanting to analyze in spreadsheets | Low-Med | Nice but out of core scope |

## Anti-Features

Things to deliberately NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Standalone DPoP token generation | Requires extracting or reverse-engineering the ES256 private key; fragile, likely breaks on app updates | Hook into the app's existing token generation by intercepting at the right layer |
| Full main.js deobfuscation | 3.6MB obfuscated file; massive effort, breaks on every app update | Targeted runtime patching — find the date restriction at runtime via DOM observation or minimal static analysis |
| Proxying through external server | Adds infrastructure, latency, trust issues, potential ToS violations | Everything stays client-side in the browser |
| Automatic session refresh | JWT expires ~6h; auto-refreshing auth is complex and likely requires credentials | Operate within active session; if JWT expires, user refreshes page naturally |
| Chrome Web Store publication | Review process, ongoing maintenance, potential rejection for modifying third-party sites | Distribute as unpacked extension / CRX for personal use |
| UI overhaul of Pokercraft | Tempting to "fix" other things while in there | Stay laser-focused on date range unlocking only |
| Multi-browser support (Firefox/Safari) | Different extension APIs, different manifest formats | Chrome only; revisit only if there's demand |

## Feature Dependencies

```
Date picker patch ──────────────────────────────→ User can select arbitrary ranges
                                                          │
Fetch/XHR interception ─→ Date range chunking ─→ DPoP token reuse ─→ Parallel sub-requests
                                                                              │
                                                          Response merging ←──┘
                                                                │
                                                   Transparent injection back to app
```

**Critical path:** DPoP token reuse is the linchpin. If the extension can't get valid DPoP tokens for sub-requests, the entire chunking approach fails. This must be prototyped first.

## MVP Recommendation

Prioritize (in build order):

1. **Fetch interception proof-of-concept** — Verify you can intercept and modify `session/list/Holdem` requests in a content script
2. **DPoP token acquisition** — Prove you can obtain valid DPoP tokens for fabricated sub-requests (this is the highest-risk item)
3. **Chunking + merging logic** — Pure logic, low risk once interception works
4. **Date picker patch** — Locate and override the 3-month restriction in the UI
5. **Request throttling** — Sequential requests with small delay to avoid triggering rate limits

Defer:
- **Caching** — Premature optimization; add after core works
- **Progress indicator** — Polish; add after core works
- **Other game types** — Explicitly out of scope per PROJECT.md
- **Export** — Not part of core value prop

## Sources

- PROJECT.md constraints and context (HIGH confidence — first-party)
- Chrome Manifest V3 extension architecture (HIGH confidence — well-documented)
- Fetch/XHR interception patterns in content scripts are standard practice (HIGH confidence)
- DPoP token mechanism complexity assessment based on project context describing ES256 per-request tokens (MEDIUM confidence — needs runtime validation)
