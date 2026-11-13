# EF-R3 — confirm completion decision memo

## Current state

- 54 planned, **23 valid**, **1 unresolved** (`T13-s2-B0-r1`), **30 never-started**.
- Missing by template: `{"T13":4,"T14":9,"T15":9,"T16":9}`.
- T14-T16 have no valid cells. The 23-cell subset is task-type biased.

## Completion is conditional

1. A representative transport health probe must pass (long B0 summary/primary payloads, not a short hello).
2. A new explicit authorization must name the new manifest SHA-256 and envelope.
3. The completion pins the **effective R2 config**: hint 400, legacy framing, retain 0.04, 16k. This keeps it comparable with the 23 valid cells.
4. The execution order is interleaved across T13-T16 so another stop cannot erase an entire template.
5. Any transport failure stops the run; the failed attempt is marked transport-failed, not an arm outcome. No automatic retry.

## The alternative is a new campaign, not a merge

If the intended 800 hint or the shipped product preset is wanted, that is a different treatment. It must be a new, explicitly labelled campaign and must not be pooled with the 23 valid R2 cells.

## Termination is a valid outcome

If the health probe fails or the route cannot be qualified, the correct decision is to keep the confirm partial, record that the completion could not be run, and stop consuming. Repeated retries are not a completion strategy.

Manifest: `eval/e2e/out/manifest-e2e-r3-confirm-completion-1.json` (SHA-256 `e0627f0c979d04d9a97c203f54eeaecf6d1387396cf09351320fedc545053477`), executionAuthorized=false.

