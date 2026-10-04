/**
 * The on-disk encoding of a checkpoint bundle.
 *
 * ## Why the file is compressed
 *
 * A bundle stores the exact model-visible messages a fold removed, and those
 * are overwhelmingly text. Measured on a real bundle from this machine: 948 KB
 * of JSON collapsed to 93 KB at zstd level 19, and to 100 KB at level 9. The
 * session log that holds the SAME content is stored compressed (3.7x), so an
 * uncompressed archive made EF's copy of a session cost several times what the
 * session itself did — measured at 53% of the log's on-disk size for one
 * session, against 15% for a session whose folds were smaller.
 *
 * Compression is the one saving that costs nothing semantically: the archive is
 * append-only cold data, and the bundle's `logicalHash` covers the archived
 * MESSAGES rather than the file, so the identity of what was archived survives
 * the encoding change untouched. That is what makes this safe to do without
 * weakening the exact-recall promise — nothing is discarded, only re-encoded.
 *
 * ## The format
 *
 * The file is an ENVELOPE, not a bare bundle:
 *
 *     { format: 'ef-bundle-file', formatVersion: 1, codec: 'zstd', payload }
 *
 * `payload` is base64 of a zstd frame over `canonicalJson(bundle)`. Base64
 * rather than raw bytes because the store writes through DSH's `writeFileAtomic`,
 * which takes a string; base64 keeps the write ASCII-clean and the atomic
 * rename, permission bits and symlink refusal all intact.
 *
 * ## Reading is tolerant on purpose
 *
 * `decodeBundleFile` accepts a bare bundle as well as an envelope. Bundles
 * written before this format existed are still on disk in real installs, and
 * refusing them would turn an encoding improvement into silent recall loss for
 * every session that already folded. The envelope marker is what makes the two
 * distinguishable without guessing.
 *
 * @module dsh-epistemic-fold/bundle-codec
 */

import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { canonicalJson } from './hash.ts'
import type { CheckpointBundleV1 } from './types.ts'

/** Marker on the envelope. Distinct from the bundle's own `format` field. */
export const BUNDLE_FILE_FORMAT = 'ef-bundle-file'

/** Envelope schema version, so a future codec change is detectable. */
export const BUNDLE_FILE_VERSION = 1

/**
 * zstd level for archived bundles.
 *
 * Level 9 is the knee, measured on a real 948 KB bundle:
 *
 *     level   size     ratio   compress
 *     3       109 KB   8.6x    3.5 ms
 *     9       100 KB   9.4x   14.7 ms
 *     19       93 KB  10.2x  179.9 ms
 *
 * Level 19 buys 7% more for 12x the time, and this runs INSIDE the fold
 * transaction — the path whose whole job is to relieve context pressure. Level 9
 * keeps the fold responsive while still removing ~90% of the bytes; the ratio
 * that matters is against the uncompressed archive, not against level 19.
 */
const ZSTD_LEVEL = 9

/** The envelope as it is written to disk. */
export interface BundleFileEnvelope {
  readonly format: typeof BUNDLE_FILE_FORMAT
  readonly formatVersion: number
  readonly codec: 'zstd'
  /** base64 of the zstd frame over `canonicalJson(bundle)`. */
  readonly payload: string
}

/**
 * Serialize a bundle to the on-disk envelope.
 *
 * Deterministic: canonical JSON plus a fixed compression level means the same
 * bundle always produces the same bytes, which is what lets the write path
 * verify the file it just wrote by hashing it.
 *
 * @param bundle - the bundle to encode.
 * @returns the complete file content.
 */
export function encodeBundleFile(bundle: CheckpointBundleV1): string {
  const compressed = zstdCompressSync(Buffer.from(canonicalJson(bundle), 'utf8'), {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  })
  const envelope: BundleFileEnvelope = {
    format: BUNDLE_FILE_FORMAT,
    formatVersion: BUNDLE_FILE_VERSION,
    codec: 'zstd',
    payload: compressed.toString('base64'),
  }
  return canonicalJson(envelope)
}

/** Whether parsed file content is an envelope rather than a bare bundle. */
export function isBundleEnvelope(value: unknown): value is BundleFileEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<BundleFileEnvelope>
  return candidate.format === BUNDLE_FILE_FORMAT
    && candidate.codec === 'zstd'
    && typeof candidate.payload === 'string'
}

/**
 * Parse file content back into a bundle.
 *
 * Accepts both the envelope and a bare bundle — see the module note on
 * tolerance. Throws on malformed input; callers that must distinguish
 * corruption from absence catch, because the two mean different things in an
 * audit.
 *
 * @param text - the complete file content.
 * @returns the bundle the file describes.
 */
export function decodeBundleFile(text: string): CheckpointBundleV1 {
  const parsed = JSON.parse(text) as unknown
  if (!isBundleEnvelope(parsed)) return parsed as CheckpointBundleV1
  const decompressed = zstdDecompressSync(Buffer.from(parsed.payload, 'base64'))
  return JSON.parse(decompressed.toString('utf8')) as CheckpointBundleV1
}
