/**
 * Subagent-based recall — EXPERIMENTAL, off by default.
 *
 * ## The failure this exists for
 *
 * A direct `context_recall` is a document fetch: the caller names a checkpoint and gets
 * its content, up to one page. Measured over nine cells of the 4.1F round (docs/66):
 *
 *   57% of recall/search calls returned a MARKER with no content
 *   34% of context_search calls returned hits: []
 *   32% of context_recall calls re-opened a checkpoint already opened, up to 10x the
 *       same id, and one cell repeated the SAME depth on the SAME id four times
 *   4 of 9 cells ever recovered the task instruction, once each
 *
 * The archive was never the problem: `depth: "exact"` returned the instruction
 * character-for-character. The problem is that the caller must NAME what it wants using
 * an opaque id, and a document fetch has no size control — a large checkpoint is pulled
 * into the live surface page by page, and the surface then folds again.
 *
 * ## What this does instead
 *
 * Retrieval becomes a bounded QUERY. The caller states a GOAL; a subagent reads the
 * archive (descriptors, search, exact pages) and returns only what answers the goal,
 * plus a short list of what ELSE it saw that the caller may want next. Two consequences:
 *
 *   - the answer is bounded by a reply budget, not by the size of what it read, so a
 *     50,000-token checkpoint can yield a 500-token answer;
 *   - the caller never needs a checkpoint id, because the subagent does the locating.
 *
 * ## The non-goal half
 *
 * Not every recall need is known in advance, so every run returns a `further` list:
 * material the subagent saw that the goal did not ask for, as candidate questions. In
 * SURVEY mode (no goal) that list IS the answer — it is how a caller discovers what is
 * in an archive it has never read.
 *
 * ## Gating
 *
 * `subagentRecall` is false by default, and the tools are only registered when it is on.
 * The direct `context_recall` changes behaviour ONLY under the same flag, so a default
 * deployment cannot observe this feature at all.
 *
 * @module dsh-epistemic-fold/subagent-recall
 */

// ---------------------------------------------------------------- the surface
//
// One barrel over five modules — telemetry, the size gate, descriptors, the
// bounded loop, and the LLM transport — so this file is the feature's public
// face and nothing else. EVERY export that used to be defined here is
// re-exported, which is what keeps tools.ts, engine.ts, eval/tau2/bridge-host.ts
// and tests/subagent-recall.spec.ts importing from the same path unchanged.

export * from "./recall-telemetry.ts"
export * from "./gate.ts"
export * from "./descriptors.ts"
export * from "./recall-loop.ts"
export * from "./recall-transport.ts"
