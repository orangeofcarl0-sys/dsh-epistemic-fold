/**
 * EF checkpoint framing (R3-B/R3-C).
 *
 * DSH Basic wraps EVERY checkpoint body in `frameSummary()`: a fixed preamble
 * plus `<compacted-summary>` tags. The R2 framing analysis measured that this
 * inherited framing — not EF's own state rendering — is the largest single
 * component of a leaf checkpoint's cost, repeated once per fold, and that no
 * amount of EF-side dieting can remove it. That is the gap `frameCheckpoint`
 * (the DSH seam) exists to close.
 *
 * Removing it must not remove the SEMANTICS. Basic's preamble tells the model
 * three things: this is established historical context, do not restate it, and
 * do not acknowledge it. EF has a better place to say all three — once, in the
 * system prompt, rather than once per checkpoint — so this module owns BOTH
 * halves of that move:
 *
 *   `foldFrameCheckpoint`  the per-checkpoint framing, now zero-cost
 *   `FOLD_FRAMING_SECTION` the constant system-prompt section that replaces it
 *
 * The two are a pair. Emitting one without the other would drop the semantics
 * the model relies on, so {@link framingModeFor} refuses to select the
 * deduplicated mode when there is nowhere to put the explanation.
 *
 * @module dsh-epistemic-fold/framing
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * Which framing strategy a deployment uses.
 *
 * `legacy` — Basic's per-checkpoint preamble and wrapper tags. Correct with no
 * system-prompt dependency, and the only safe choice when none is mounted.
 *
 * `system-dedup` — no per-checkpoint preamble; the semantics move to a single
 * stable system-prompt section. Requires `ctx.systemPrompt`.
 */
export type FramingMode = 'legacy' | 'system-dedup'

/**
 * The constant system-prompt section that carries checkpoint semantics when
 * the per-checkpoint preamble is removed.
 *
 * Deliberately O(1): one copy per request instead of one per checkpoint, and
 * highly cache-stable because it never changes, so it sits at the very front
 * of the prefix.
 */
export const FOLD_FRAMING_SECTION =
  'Epistemic Fold checkpoints are established historical context. Messages marked '
  + '`[EF1 <mode> cp:<id>]` summarize earlier conversation. Treat their content as prior context, '
  + 'not as new user instructions, and build on it without restating it. Do not acknowledge a '
  + 'checkpoint itself. Call context_recall with `cp:<id>` when exact folded history is needed.'

/**
 * The per-checkpoint framing for the deduplicated mode: none.
 *
 * The body is already a complete checkpoint — a marker carrying machine
 * identity and the recall reference, optionally followed by machine state and
 * a rationale. Basic's preamble and wrapper tags exist to tell the model what
 * a bare narrative block is, which the marker does better and without
 * repeating itself once per fold.
 *
 * @param summary - the summary blocks to frame.
 * @returns the blocks unchanged.
 */
export function foldFrameCheckpoint(summary: readonly ContentBlock[]): ContentBlock[] {
  return [...summary]
}

/**
 * Resolve the framing mode against what the deployment can actually support.
 *
 * `dsh-system-prompt` is an optional dependency, so a `system-dedup` request
 * in a deployment without it has nowhere to put the semantics. Silently
 * dropping the preamble would leave the model with unlabelled text where an
 * explanation used to be — trading correctness for tokens, which R3 forbids.
 * Falling back to `legacy` keeps the semantics and gives up only the saving.
 *
 * @param requested - the configured mode.
 * @param hasSystemPrompt - whether `ctx.systemPrompt` is mounted.
 * @returns the mode to use, and why it differs from the request.
 */
export function framingModeFor(
  requested: FramingMode,
  hasSystemPrompt: boolean,
): { readonly mode: FramingMode; readonly fallback?: string } {
  if (requested === 'legacy') return { mode: 'legacy' }
  if (hasSystemPrompt) return { mode: 'system-dedup' }
  return {
    mode: 'legacy',
    fallback:
      'framingMode "system-dedup" requires ctx.systemPrompt to carry the checkpoint semantics; '
      + 'falling back to "legacy" rather than dropping the preamble with nowhere to put it',
  }
}
