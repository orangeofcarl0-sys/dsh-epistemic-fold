/**
 * Canonical JSON serialization and SHA-256 digests for bundle integrity.
 *
 * The logical hash covers the canonical JSON of the archived messages — the
 * identity of WHAT was archived — while the file hash covers the serialized
 * bundle bytes, which may differ once compression lands (Q-002).
 *
 * @module dsh-epistemic-fold/hash
 */

import { createHash } from 'node:crypto'

/**
 * Serialize a value to canonical JSON: object keys sorted, arrays in order,
 * no whitespace. `undefined` properties are dropped, matching the DSH
 * snapshotJsonValue lossless-JSON face.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return value.map(entry => canonicalize(entry))
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}

/** SHA-256 hex digest over one string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** SHA-256 hex digest over canonical JSON of one value. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
