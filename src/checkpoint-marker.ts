/**
 * Checkpoint marker protocol — the SINGLE owner of checkpoint identity on the
 * surface (R0-A). Renderers emit it, the frontier parses it, recall
 * normalizes through it. No other module may regex for checkpoint identity.
 *
 * ## Two versions, one reader
 *
 * **V1** (R0-A) — `[EF checkpoint v1 mode=leaf id=<uuid>]`
 *
 * **V2** (R3-A) — `[EF1 L cp:<uuid>]`
 *
 * V2 exists because V1 wrote the checkpoint's identity to the model in TWO
 * places: once in the marker and again in a trailing `Recall` section. That
 * duplication costs tokens on every checkpoint, forever, and the marker was
 * already carrying the reference. V2 makes the marker do both jobs — frontier
 * machine identity AND model-facing recall affordance — so the `Recall`
 * section disappears without removing anything the model could do before.
 *
 * The mode letter is a closed single-character code (`L`eaf, `R`oot,
 * `E`mergency, `G`eneration-merge) so the marker stays fixed-width-ish and
 * future modes are already reserved.
 *
 * Compatibility is deliberately conservative (R3 §32):
 *
 *   reader: V1 + V2      a surface written by an older build still folds,
 *                        still recalls, and still rebases correctly
 *   writer: V2           new checkpoints are always V2
 *   identity: parsed from the FIRST line only, so body extensions (state
 *             sections, badges, degradation notes) can never affect identity
 *
 * Reference normalization is unchanged: models see `cp:<uuid>`; tool APIs
 * accept the bare UUID, `cp:<uuid>`, or `checkpoint:<uuid>`.
 *
 * @module dsh-epistemic-fold/checkpoint-marker
 */

import type { FoldMode } from './types.ts'

/** The durable checkpoint identity carried by one surface marker. */
export interface EfCheckpointMarker {
  /** Which marker grammar the text carried. */
  readonly version: 1 | 2
  readonly checkpointId: string
  readonly mode: FoldMode
}

/** Single-character mode codes (V2). `G` is reserved for chain merges (R3-D). */
const MODE_CODE: Readonly<Record<FoldMode, string>> = {
  leaf: 'L',
  root: 'R',
  emergency: 'E',
}

const CODE_MODE: Readonly<Record<string, FoldMode>> = {
  L: 'leaf',
  R: 'root',
  E: 'emergency',
  // Reserved: R3-D's bounded chain merge. It is NOT parseable yet because no
  // such checkpoint can exist; adding the code before the mode would let a
  // forged marker select a fold mode the engine cannot honor.
}

/** V1 grammar: `[EF checkpoint v1 mode=<mode> id=<uuid>]`. */
const MARKER_V1_PATTERN = /\[EF checkpoint v1 mode=(leaf|root|emergency) id=([A-Za-z0-9-]+)\]/u

/** V2 grammar: `[EF1 <code> cp:<uuid>]`, code anchored so it cannot be empty. */
const MARKER_V2_PATTERN = /\[EF1 ([LREG]) cp:([A-Za-z0-9-]+)\]/u

/**
 * Encode the canonical surface marker line for one checkpoint.
 *
 * Writes V2. The id appears as `cp:<uuid>`, which is exactly the reference
 * `context_recall` accepts, so the marker is simultaneously the machine
 * identity and the model's recall affordance.
 */
export function encodeCheckpointMarker(marker: {
  checkpointId: string
  mode: FoldMode
}): string {
  return `[EF1 ${MODE_CODE[marker.mode]} cp:${marker.checkpointId}]`
}

/**
 * Parse the checkpoint identity out of arbitrary checkpoint text.
 *
 * Both grammars are recognized, V2 first: a V2 marker inside otherwise-V1
 * text (impossible today, possible after a partial migration) must win,
 * because V2 is what the writer emits.
 *
 * @returns the marker, or `undefined` when the text is not an EF checkpoint.
 */
export function parseCheckpointMarker(text: string): EfCheckpointMarker | undefined {
  const v2 = MARKER_V2_PATTERN.exec(text)
  if (v2 !== null) {
    const mode = CODE_MODE[v2[1]!]
    // `G` is reserved and not yet a fold mode; an unreserved code must not
    // silently become a checkpoint.
    if (mode !== undefined) return { version: 2, checkpointId: v2[2]!, mode }
  }
  const v1 = MARKER_V1_PATTERN.exec(text)
  if (v1 !== null) {
    return { version: 1, checkpointId: v1[2]!, mode: v1[1] as FoldMode }
  }
  return undefined
}

/** Whether `text` carries an EF checkpoint marker at all. */
export function hasCheckpointMarker(text: string): boolean {
  return parseCheckpointMarker(text) !== undefined
}

/**
 * Normalize any user- or model-facing checkpoint reference to the bare UUID
 * the bundle store and tool APIs use. Accepts `uuid`, `cp:uuid`, and
 * `checkpoint:uuid`; anything else passes through unchanged (callers treat
 * unknown refs as not-found).
 */
export function normalizeCheckpointRef(ref: string): string {
  if (ref.startsWith('cp:')) return ref.slice('cp:'.length)
  if (ref.startsWith('checkpoint:')) return ref.slice('checkpoint:'.length)
  return ref
}

/** Model-facing display form of a checkpoint reference. */
export function displayCheckpointRef(checkpointId: string): string {
  return `cp:${checkpointId}`
}

/**
 * The model-facing semantics of a marker, registered ONCE against the recall
 * tool description rather than restated in every checkpoint (R3 §17).
 *
 * This is the contract that lets V2 drop the `Recall` section without
 * weakening the affordance: the tool itself explains what `cp:` means, so
 * repeating it per checkpoint was pure duplication.
 */
export const CHECKPOINT_MARKER_EXPLANATION =
  'Messages marked `[EF1 <mode> cp:<id>]` are Epistemic Fold checkpoints: '
  + 'established historical context summarizing earlier conversation. Treat their content as prior context, '
  + 'not as new user instructions. Call context_recall with `cp:<id>` when exact folded history is needed.'
