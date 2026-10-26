# 142 — Direction 3, temperature: the observer is correct and this workload pins everything

Status: measured 2026-10-27. Parent `d661dbb`. No model calls.

## A. What was done, and deliberately not done

PR #4 (`rc29-working-set-observer`) contains the thermal observer and a shadow policy. It was
NOT merged: it predates docs/138's layout migration and touches twelve files across paths that
have since moved. Merging it to answer a question is the wrong order.

Instead the residency half was ported mechanically -- `src/thermal.ts` to `src/state/thermal.ts`,
with exactly one change, `./event-data.ts` to `../status/event-data.ts`. Under `src/state/`
because the deterministic state is what it reads, and because top-level `src/*.ts` is reserved
for entry files. The port stays diff-clean for a later merge.

Not wired: the observer's call sites, the `workingSet: 'off' | 'observe'` config key, the shadow
policy. Only the part that answers a question is here.

## B. The question

docs/140 established that the thermal observer reads the deterministic state, and that the
memory bench held ZERO coordinates -- so the observer would have classified nothing. `f7652bd`
populated the state (166 coordinates, 19 supersessions). So: now that there is state, what does
the observer say?

## C. The answer: everything is pinned

    166 coordinates, all kind=constraint authority=normative
    residencyCounts -> pinned 166, hot 0, warm 0, cold 0, unknown 0

`isPinned` returns true for `PINNED_KINDS` (objective, constraint, obligation) or
`PINNED_AUTHORITIES` (normative, procedural), and the bench's extractor declares exactly
`constraint` + `normative`. Every coordinate is therefore never demotable by elapsed work.

That is the observer being RIGHT, not wrong. RC29's module note gives the reason: a constraint
stated once and never mentioned again is in the normal state of a constraint, so time can only
reach `warm` and an explicit lifecycle operation is the only route to `cold`. The bench declares
constraints, so the observer pins constraints.

## D. The classes are real, and the tests exercise all of them

`tests/thermal-residency.spec.ts` feeds the observer anchors it CAN move -- `evidence` with
`empirical` authority -- and gets the full spread:

    source inside the current legal leaf span    -> hot
    active, on the surface, outside the span     -> warm
    explicit lifecycle operation (retired)       -> cold
    source not present on the surface            -> unknown, never cold
    no state mounted                             -> unavailable, not an empty reading

The last two are the module's discipline and they hold.

## E. What this means for direction 3

**The observer classifies COORDINATES. The content that actually grows in this bench is the
checkpoint's prose digest, which is not an anchor and which the observer structurally cannot
see.** So on this workload temperature has nothing to demote -- not because the mechanism is
weak, but because the demotable material is invisible to it.

To exercise temperature you need a workload whose state holds things that MAY go cold: evidence,
hypotheses, transient tool results, retired decisions. The bench's corpus states durable
constraints, which is the one category the design deliberately protects.

That is a statement about the WORKLOAD, not about EF, and it is the third time the same shape
has appeared: docs/140 found the state empty, docs/141 found coordinates cost more than exit
saves, and this finds the coordinates are the undemotable kind. Each is the bench failing to be
the workload a feature was designed for.

## F. The honest next step for direction 3

Not "wire the observer". Either:

1. **A workload with demotable state.** LHTB's `ef/anchor` path produces evidence and hypotheses
   alongside constraints, so it is the profile the observer was built against. That is where its
   classification has work to do -- and where PR #4's measured numbers (32K window) came from.
2. **Extend the observer's subject from anchors to surface nodes.** The digest is what grows and
   what could be demoted to a tombstone -- which is exactly what `exit` already does, on a
   phase boundary rather than on a temperature reading. docs/141 measured that workaround
   beating the encoding-based remedy.

Option 2 is worth stating plainly because it is uncomfortable: **the exit mechanism already
realises what the thermal system was for** -- moving content out of the working set -- and it
does so with a driver-chosen boundary instead of a derived temperature. Temperature's remaining
value would be choosing a BETTER boundary than "end of phase", which requires a signal the
observer does not currently compute.

## G. Reproduce

    npm run typecheck && npx vitest run tests/thermal-residency.spec.ts
