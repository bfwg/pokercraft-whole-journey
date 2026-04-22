# Roadmap: Pokercraft Date Range Unlocker

## Overview

Three phases deliver a Chrome extension that unlocks Pokercraft's full session history. Phase 1 builds the extension scaffold and proves that fetch interception + DPoP token acquisition work (the two biggest risks). Phase 2 adds chunking and response merging logic on top of the proven interception layer. Phase 3 removes the date picker restriction so users can actually select large date ranges.

## Phases

- [ ] **Phase 1: Extension Scaffold & Request Interception** - MV3 extension that intercepts API calls with valid DPoP tokens
- [ ] **Phase 2: Chunking & Response Merging** - Split large date ranges into 25-day chunks and merge results transparently
- [ ] **Phase 3: Date Picker Unlock** - Remove 3-month restriction from the Pokercraft date picker UI

## Phase Details

### Phase 1: Extension Scaffold & Request Interception
**Goal**: A working Chrome extension that intercepts Pokercraft API calls and can make authenticated sub-requests with valid DPoP tokens
**Depends on**: Nothing (first phase)
**Requirements**: EXT-01, EXT-02, EXT-03, INT-01, INT-02, INT-03, DPOP-01, DPOP-02
**Success Criteria** (what must be TRUE):
  1. Extension installs in Chrome and activates on `my.pokercraft.com` without errors
  2. All `session/list/Holdem` API calls are logged to console with their date range parameters
  3. Requests with date ranges <= 25 days pass through and return correct data unmodified
  4. A manually triggered sub-request with a modified date range returns a valid authenticated response (proving DPoP works)
**Plans:** 1/2 plans executed

Plans:
- [ ] 01-01-PLAN.md — Extension scaffold with fetch/XHR interception
- [ ] 01-02-PLAN.md — DPoP token acquisition and proof sub-request

### Phase 2: Chunking & Response Merging
**Goal**: Large date ranges are automatically split into 25-day chunks, responses merged, and returned to the app as a single result
**Depends on**: Phase 1
**Requirements**: SPL-01, SPL-02, SPL-03, MRG-01, MRG-02, MRG-03, MRG-04
**Success Criteria** (what must be TRUE):
  1. A 90-day date range request triggers multiple 25-day chunk sub-requests (visible in console logs)
  2. All chunk responses are merged into one result with deduplicated sessionIds, correct fromTime/toTime, and remain=0
  3. The app displays all sessions from the full date range as if it were a single response
  4. Progress of chunk fetching is visible (console logs or extension badge)
**Plans**: TBD

Plans:
- [ ] 02-01: TBD

### Phase 3: Date Picker Unlock
**Goal**: Users can select arbitrary date ranges in the Pokercraft date picker, not just the last 3 months
**Depends on**: Phase 1
**Requirements**: DPK-01, DPK-02
**Success Criteria** (what must be TRUE):
  1. User can select a start date more than 3 months in the past in the date picker
  2. Date picker patching survives page navigation within Pokercraft (MutationObserver re-applies)
**Plans**: TBD

Plans:
- [ ] 03-01: TBD

## Progress

**Execution Order:** 1 → 2 → 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Extension Scaffold & Request Interception | 1/2 | In Progress|  |
| 2. Chunking & Response Merging | 0/? | Not started | - |
| 3. Date Picker Unlock | 0/? | Not started | - |
