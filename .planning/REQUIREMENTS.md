# Requirements: Pokercraft Date Range Unlocker

**Defined:** 2026-04-22
**Core Value:** Users can view and analyze their full poker session history across any time period, not just the last 3 months.

## v1 Requirements

### Extension Infrastructure

- [x] **EXT-01**: Extension loads as Chrome MV3 with valid manifest
- [x] **EXT-02**: Content script injects into MAIN world at `document_start` on `my.pokercraft.com`
- [x] **EXT-03**: Extension logs interception activity to browser console for debugging

### Request Interception

- [x] **INT-01**: Extension monkey-patches fetch/XHR to intercept calls matching `session/list/Holdem`
- [x] **INT-02**: Extension detects when `from`/`to` URL params span more than 25 days
- [x] **INT-03**: Requests with date ranges <= 25 days pass through unmodified

### Request Splitting

- [x] **SPL-01**: Date range exceeding 25 days is split into consecutive 25-day chunk requests
- [x] **SPL-02**: Chunk requests execute sequentially with max 2-3 concurrent requests
- [x] **SPL-03**: Progress indicator shows chunk fetch status (console or extension badge)

### DPoP Token Handling

- [x] **DPOP-01**: Extension hooks into app's DPoP token generator to obtain valid per-request tokens for sub-requests
- [x] **DPOP-02**: Fallback: if hook fails, extension extracts CryptoKey and signs DPoP tokens manually (ES256)

### Response Merging

- [x] **MRG-01**: All chunk responses' sessionIds arrays are merged with deduplication
- [x] **MRG-02**: Merged result has correct fromTime (earliest) and toTime (latest) across all chunks
- [x] **MRG-03**: Merged result sets `remain: 0` to prevent app pagination loops
- [x] **MRG-04**: Merged response is returned to app transparently (app treats it as a single response)

### Date Picker Unlock

- [ ] **DPK-01**: 3-month date range restriction is removed from the Pokercraft date picker UI
- [ ] **DPK-02**: Date picker patching uses DOM-level approach (MutationObserver) for resilience against app updates

## v2 Requirements

### Multi-Game Support

- **GAME-01**: Support other game type endpoints beyond Holdem (e.g., PLO, Short Deck)
- **GAME-02**: Game type detection from URL pattern

### Enhanced UX

- **UX-01**: Popup UI showing extension status and statistics
- **UX-02**: Options page for configuring chunk size and concurrency

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full JS deobfuscation | Only need targeted patching, not full understanding |
| Standalone Node.js tool | Chrome extension approach chosen |
| Server-side proxy | Working within browser context |
| Chrome Web Store publication | Personal use tool |
| Other poker sites | Pokercraft-specific |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXT-01 | Phase 1 | Complete |
| EXT-02 | Phase 1 | Complete |
| EXT-03 | Phase 1 | Complete |
| INT-01 | Phase 1 | Complete |
| INT-02 | Phase 1 | Complete |
| INT-03 | Phase 1 | Complete |
| DPOP-01 | Phase 1 | Complete |
| DPOP-02 | Phase 1 | Complete |
| SPL-01 | Phase 2 | Complete |
| SPL-02 | Phase 2 | Complete |
| SPL-03 | Phase 2 | Complete |
| MRG-01 | Phase 2 | Complete |
| MRG-02 | Phase 2 | Complete |
| MRG-03 | Phase 2 | Complete |
| MRG-04 | Phase 2 | Complete |
| DPK-01 | Phase 3 | Pending |
| DPK-02 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-04-22*
*Last updated: 2026-04-22 after initial definition*
