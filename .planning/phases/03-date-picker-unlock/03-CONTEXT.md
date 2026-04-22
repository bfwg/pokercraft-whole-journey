# Phase 3: Date Picker Unlock - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Remove the 3-month date range restriction from the Pokercraft calendar popup so users can select arbitrary start dates. The chunking engine (Phase 2) already handles the API-level splitting — this phase only addresses the UI restriction.

</domain>

<decisions>
## Implementation Decisions

### Date Restriction Removal Strategy
- The calendar popup has fully disabled (unclickable) date cells beyond 3 months
- Approach: DOM attribute removal — use MutationObserver to watch for disabled date cells, remove the disabled attribute/class to make them clickable
- Must ensure that clicking a formerly-disabled date triggers Angular's date selection logic (not just visual enablement)
- Prefer DOM-level patching over Angular config override — more resilient to app updates

### Persistence
- MutationObserver must survive SPA navigation within Pokercraft (re-apply when calendar is re-rendered)
- OpenCode's discretion on exact MutationObserver configuration (subtree, childList, attributes)

### OpenCode's Discretion
- Exact DOM selectors for disabled date cells (requires runtime inspection of calendar HTML)
- Whether to also remove visual styling (greyed-out appearance) or just enable click handling
- User feedback on large range selection (none needed — chunking handles it transparently)
- How to ensure Angular processes the click event correctly after re-enabling

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `extension/content.js`: Already has MAIN world injection at `document_start`, MutationObserver patterns not yet present but easy to add
- Content script already patches `window.fetch` and `XMLHttpRequest` — date picker patching is additive

### Established Patterns
- Angular Material calendar component (from research: `mat-date-formats`, `_calendar`, `_calendarEl` strings found in main.js)
- CSS custom properties: `--timeline-filter-calendar-*` found in embedded CSS
- App uses heavily obfuscated Angular — DOM inspection at runtime is the reliable approach

### Integration Points
- Add MutationObserver to existing `content.js` — no new files needed
- Calendar popup appears dynamically in DOM — observer must watch for its insertion

</code_context>

<specifics>
## Specific Ideas

- Calendar cells are fully disabled (unclickable), not just visually greyed
- The app likely uses Angular Material datepicker with a `maxDate` or `dateFilter` binding
- Removing `disabled`, `aria-disabled`, and related CSS classes from calendar cells should re-enable them
- May also need to dispatch synthetic click/change events if Angular doesn't pick up native clicks on re-enabled elements

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-date-picker-unlock*
*Context gathered: 2026-04-22*
