/**
 * Canonical JSON and digests for the frozen R33 dataset.
 *
 * The digest must be stable across machines, so keys are sorted recursively and
 * only JSON-representable values are accepted. A case digest covers the ENTIRE
 * case file: transcript, gold, workspace, actions, and checker. If any of them
 * changes, the dataset id changes with it and the report can no longer be
 * compared to an earlier run.
 *
 * @module eval/r33/src/canonical
 */

import { createHash } from 'node:crypto'

/** Sort object keys recursively; arrays keep their order (order is data). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/** SHA-256 hex over the canonical JSON of one value. */
export function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** Short digest for reports; the full digest stays available for verification. */
export function shortDigest(value) {
  return digestOf(value).slice(0, 16)
}
