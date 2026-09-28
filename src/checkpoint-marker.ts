/**
 * Checkpoint marker protocol — the SINGLE owner of checkpoint identity on
 * the surface (R0-A). Renderers emit it, the frontier parses it, recall
 * normalizes through it. No other module may regex for checkpoint identity.
 *
 * Surface format (first line of every EF checkpoint):
 *
 *   [EF checkpoint v1 mode=leaf id=<uuid>]
 *
 * Everything after the marker line is free-form checkpoint body. The marker
 * parses the identity out of the FIRST line only, so later body extensions
 * (state sections, verified badges, degradation notes) can never affect
 * identity recognition again.
 *
 * Reference normalization: models see `cp:<uuid>` in rendered text; tool
 * APIs accept the bare UUID, `cp:<uuid>`, or `checkpoint:<uuid>` and
 * normalize to the bare UUID before any lookup.
 *
 * @module dsh-epistemic-fold/checkpoint-marker
 */

import type { FoldMode } from './types.ts'

/** The durable checkpoint identity carried by one surface marker. */
export interface EfCheckpointMarker {
  readonly version: 1
  readonly checkpointId: string
  readonly mode: FoldMode
}

/** Token-level grammar; tolerant of any body after the closing bracket. */
const MARKER_PATTERN = /\[EF checkpoint v1 mode=(leaf|root|emergency) id=([A-Za-z0-9-]+)\]/u

/** Encode the canonical surface marker line for one checkpoint. */
export function encodeCheckpointMarker(marker: {
  checkpointId: string
  mode: FoldMode
}): string {
  return `[EF checkpoint v1 mode=${marker.mode} id=${marker.checkpointId}]`
}

/**
 * Parse the checkpoint identity out of arbitrary checkpoint text (the
 * marker must appear within the text; the first occurrence wins).
 * @returns the marker, or `undefined` when the text is not an EF checkpoint.
 */
export function parseCheckpointMarker(text: string): EfCheckpointMarker | undefined {
  const match = MARKER_PATTERN.exec(text)
  if (match === null) return undefined
  const mode = match[1] as FoldMode
  return { version: 1, checkpointId: match[2]!, mode }
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
