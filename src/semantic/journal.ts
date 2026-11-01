/**
 * The semantic journal: immutable prepared packets plus immutable commit
 * receipts, one session directory per session.
 *
 * ## Why the file layout changed
 *
 * The previous journal rewrote ONE file per packet, changing `status` in place.
 * That made the packet both the preparation and the decision, so a crash
 * between the fold's surface replacement and the status write left a packet
 * that looked merely staged; a stale status write could also disagree with the
 * log with no independent record of what had been decided. Worse, replay
 * ordered packets by `activatedAt ?? createdAt` — wall time, which is neither
 * monotonic across processes nor the order the folds committed in.
 *
 * v4 separates the two facts:
 *
 *   <root>/<sessionId>/<packetId>.json           PREPARED packet (immutable)
 *   <root>/<sessionId>/<packetId>.receipt.json   COMMIT receipt (immutable)
 *
 * "Staged" means "no receipt yet". A decision is written once, with the
 * historical fold proof that justified it; a second, different decision for the
 * same packet is a hard error, not a silent overwrite. Ordering uses the
 * proof's `commitOrder` (the replacement event's seq), never wall time.
 *
 * ## Write, then read back
 *
 * Every write verifies what landed by reading the file and comparing its bytes.
 * The atomic-write primitive renames a sibling temp file; the read-back catches
 * a short write or a torn rename, which is the one failure that would look like
 * a commit.
 *
 * ## Legacy v3 files
 *
 * Read but never rewritten. `list` returns them separately; the reconciler
 * migrates one only after the historical proof and the bundle agree. A v3 file
 * is never applied directly, because it cannot prove its source content.
 *
 * @module dsh-epistemic-fold/semantic/journal
 */

import { mkdir, readdir, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalHash } from '../checkpoint/hash.ts'
import {
  LEGACY_SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_SCHEMA_VERSION,
} from './types.ts'
import type { PacketStatus, SemanticPacket, SemanticReceipt } from './types.ts'
import type { HistoricalFoldProof } from './proof.ts'

/** A packet plus the reason it could not be read, when one was skipped. */
export interface JournalRead {
  /** v4 prepared packets, ordered by commit proof (committed first, then staging seq). */
  readonly packets: readonly SemanticPacket[]
  /** The receipt for each packet id that has one. */
  readonly receipts: ReadonlyMap<string, SemanticReceipt>
  /** Schema-3 packets: migration candidates, never applied as-is. */
  readonly legacy: readonly SemanticPacket[]
  /** Files that exist but are not a readable packet or receipt. */
  readonly invalid: readonly { readonly file: string; readonly detail: string }[]
}

/** The journal surface the engine and the reconciler use. */
export interface SemanticJournal {
  /** Write one PREPARED packet. Idempotent for identical bytes, fatal for a different packet. */
  write(packet: SemanticPacket): Promise<void>
  /** Write one IMMUTABLE decision. Idempotent for an identical receipt, fatal otherwise. */
  writeReceipt(receipt: SemanticReceipt): Promise<void>
  /** Every packet, legacy packet, and receipt for one session. */
  list(sessionId: SessionId): Promise<JournalRead>
  /**
   * Whether this session has a journal directory.
   *
   * A fork needs this to distinguish "the parent had no semantic state" from
   * "the parent's journal is not here at all". Both list as zero packets, but
   * only the first is safe to treat as an empty seed.
   */
  hasSession(sessionId: SessionId): Promise<boolean>
  /** The journal root, for diagnostics; absent for the null journal. */
  readonly root?: string
}

/** A journal that stores nothing: the `off` mode's zero-I/O face. */
export class NullSemanticJournal implements SemanticJournal {
  async write(): Promise<void> {}
  async writeReceipt(): Promise<void> {}
  async hasSession(): Promise<boolean> { return false }
  async list(): Promise<JournalRead> {
    return { packets: [], receipts: new Map(), legacy: [], invalid: [] }
  }
}

/** The identity of one prepared body. */
export function packetIdOf(input: {
  readonly sessionId: SessionId
  readonly checkpointId: string
  readonly foldedSeqs: readonly number[]
  readonly bodyDigest: string
}): string {
  return canonicalHash({
    schema: SEMANTIC_SCHEMA_VERSION,
    sessionId: input.sessionId,
    checkpointId: input.checkpointId,
    foldedSeqs: input.foldedSeqs,
    bodyDigest: input.bodyDigest,
  })
}

/** `canonicalHash` of a packet's resolved operations. */
export function opsDigestOf(packet: Pick<SemanticPacket, 'ops'>): string {
  return canonicalHash(packet.ops)
}

/**
 * Whether an unknown value is a complete enough v4 packet to replay.
 *
 * Strict about the fields that decide STATE (`status`, `authority`, `ops`,
 * `sourceDigest`) and lenient about audit-only fields. The ops themselves are
 * validated at the point they are applied by `semantic/record.ts`.
 */
export function isSemanticPacket(value: unknown): value is SemanticPacket {
  if (value === null || typeof value !== 'object') return false
  const packet = value as Partial<SemanticPacket>
  return packet.schemaVersion === SEMANTIC_SCHEMA_VERSION
    && typeof packet.packetId === 'string'
    && typeof packet.sessionId === 'string'
    && typeof packet.checkpointId === 'string'
    && typeof packet.bodyDigest === 'string'
    && typeof packet.sourceDigest === 'string' && packet.sourceDigest.length > 0
    && typeof packet.spanDigest === 'string'
    && typeof packet.stagedAtSeq === 'number'
    && (packet.status === 'staged' || packet.status === 'activated'
      || packet.status === 'abandoned' || packet.status === 'archived-only')
    && (packet.authority === 'session-record' || packet.authority === 'journal')
    && Array.isArray(packet.foldedSeqs)
    && Array.isArray(packet.ops)
    && Array.isArray(packet.accepted)
}

/**
 * Whether an unknown value is a readable v3 packet.
 *
 * It is accepted only as a MIGRATION candidate. The caller must re-prove the
 * fold and compute the source digest from the bundle before it becomes state.
 */
export function isLegacySemanticPacket(value: unknown): value is SemanticPacket {
  if (value === null || typeof value !== 'object') return false
  const packet = value as Partial<SemanticPacket>
  return packet.schemaVersion === LEGACY_SEMANTIC_SCHEMA_VERSION
    && typeof packet.packetId === 'string'
    && typeof packet.sessionId === 'string'
    && typeof packet.checkpointId === 'string'
    && typeof packet.bodyDigest === 'string'
    && typeof packet.stagedAtSeq === 'number'
    && (packet.status === 'staged' || packet.status === 'activated'
      || packet.status === 'abandoned' || packet.status === 'archived-only')
    && (packet.authority === 'session-record' || packet.authority === 'journal')
    && Array.isArray(packet.foldedSeqs)
    && Array.isArray(packet.ops)
    && Array.isArray(packet.accepted)
}

/** Structural validation for a proof, sufficient to order and replay by it. */
function isProof(value: unknown): value is HistoricalFoldProof {
  if (value === null || typeof value !== 'object') return false
  const proof = value as Partial<HistoricalFoldProof>
  return proof.proofVersion === 1
    && typeof proof.sessionId === 'string'
    && typeof proof.checkpointId === 'string'
    && typeof proof.compactionId === 'string'
    && typeof proof.startSeq === 'number'
    && typeof proof.summarySeq === 'number'
    && typeof proof.replacementSeq === 'number'
    && typeof proof.commitOrder === 'number'
    && typeof proof.sourceDigest === 'string'
    && Array.isArray(proof.shadowedSeqs)
}

/** Whether an unknown value is a receipt this build may act on. */
export function isSemanticReceipt(value: unknown): value is SemanticReceipt {
  if (value === null || typeof value !== 'object') return false
  const receipt = value as Partial<SemanticReceipt>
  if (receipt.kind !== 'receipt') return false
  if (receipt.schemaVersion !== SEMANTIC_SCHEMA_VERSION) return false
  if (typeof receipt.packetId !== 'string' || typeof receipt.sessionId !== 'string') return false
  if (typeof receipt.checkpointId !== 'string' || typeof receipt.opsDigest !== 'string') return false
  if (typeof receipt.decidedAt !== 'number') return false
  if (receipt.outcome === 'committed') return isProof(receipt.proof)
  return receipt.outcome === 'aborted' || receipt.outcome === 'archived-only'
}

/** One file's envelope, as written. */
interface PacketFile {
  readonly kind: 'packet'
  readonly schemaVersion: number
  readonly packet: SemanticPacket
}

interface ReceiptFile {
  readonly kind: 'receipt-file'
  readonly schemaVersion: number
  readonly receipt: SemanticReceipt
}

const RECEIPT_SUFFIX = '.receipt.json'

/**
 * File-backed journal.
 *
 * `<root>/<sessionId>/<packetId>.json` keeps one session's packets together and
 * makes `list` a directory read rather than an index rebuild. Both packet and
 * receipt writes are compare-then-write: an existing file with DIFFERENT
 * content is a conflict, because two different decisions for one packet mean
 * one of them is wrong and silently choosing the later one would hide that.
 */
export class FileSemanticJournal implements SemanticJournal {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  private dir(sessionId: SessionId): string {
    return join(this.root, String(sessionId))
  }

  private file(sessionId: SessionId, packetId: string): string {
    return join(this.dir(sessionId), `${packetId}.json`)
  }

  private receiptFile(sessionId: SessionId, packetId: string): string {
    return join(this.dir(sessionId), `${packetId}${RECEIPT_SUFFIX}`)
  }

  private async writeImmutable(path: string, body: string, what: string): Promise<void> {
    try {
      const existing = await readFile(path, 'utf8')
      if (existing === body) return
      throw new Error(
        `epistemic-fold: refusing to overwrite an existing ${what} at ${path}; `
        + 'prepared packets and receipts are immutable',
      )
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFileAtomic(path, body, { mode: 0o600, dirMode: 0o700 })
    const landed = await readFile(path, 'utf8')
    if (landed !== body) {
      throw new Error(
        `epistemic-fold: semantic journal ${what} write did not land intact at ${path} `
        + `(wrote ${body.length} bytes, read ${landed.length})`,
      )
    }
  }

  /**
   * Move a v3 file out of the v4 path before the prepared packet lands.
   *
   * The migration candidate and its replacement share `<packetId>.json`; the
   * immutable-write rule would refuse the different bytes. Renaming preserves
   * the old evidence as `<packetId>.v3.json` (read-only audit) and lets the v4
   * file take the canonical name. A v4 file already there is left alone so the
   * ordinary idempotency check handles it.
   */
  private async archiveLegacyAt(path: string, packetId: string): Promise<void> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if (isMissingFile(error)) return
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const packet = parsed !== null && typeof parsed === 'object'
      ? (parsed as { packet?: unknown }).packet
      : undefined
    if (packet === null || typeof packet !== 'object'
      || (packet as { schemaVersion?: unknown }).schemaVersion !== LEGACY_SEMANTIC_SCHEMA_VERSION
      || (packet as { packetId?: unknown }).packetId !== packetId) return
    await rename(path, join(dirname(path), `${packetId}.v3.json`))
  }

  async write(packet: SemanticPacket): Promise<void> {
    if (packet.status !== 'staged') {
      // A prepared packet is a PREPARATION. Its status is `staged` by
      // definition; the decision belongs in a receipt. Writing an "activated"
      // packet would restore the very mutable-status design v4 replaced.
      throw new Error(
        `epistemic-fold: refusing to journal a packet with status "${packet.status}"; `
        + 'a prepared packet is staged and a receipt carries the decision',
      )
    }
    const dir = this.dir(packet.sessionId)
    await mkdir(dir, { recursive: true })
    const path = this.file(packet.sessionId, packet.packetId)
    await this.archiveLegacyAt(path, packet.packetId)
    const body = `${JSON.stringify({
      kind: 'packet',
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      packet,
    } satisfies PacketFile, null, 2)}\n`
    await this.writeImmutable(path, body, 'prepared packet')
  }

  async writeReceipt(receipt: SemanticReceipt): Promise<void> {
    const dir = this.dir(receipt.sessionId)
    await mkdir(dir, { recursive: true })
    const packetPath = this.file(receipt.sessionId, receipt.packetId)
    const prepared = await readFile(packetPath, 'utf8').catch(() => undefined)
    if (prepared === undefined) {
      throw new Error(
        `epistemic-fold: refusing to write a receipt for packet ${receipt.packetId}; `
        + 'no prepared packet exists for it',
      )
    }
    const body = `${JSON.stringify({
      kind: 'receipt-file',
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      receipt,
    } satisfies ReceiptFile, null, 2)}\n`
    await this.writeImmutable(this.receiptFile(receipt.sessionId, receipt.packetId), body, 'commit receipt')
  }

  async hasSession(sessionId: SessionId): Promise<boolean> {
    try {
      await readdir(this.dir(sessionId))
      return true
    } catch {
      return false
    }
  }

  async list(sessionId: SessionId): Promise<JournalRead> {
    const dir = this.dir(sessionId)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return { packets: [], receipts: new Map(), legacy: [], invalid: [] }
    }
    const packets: SemanticPacket[] = []
    const legacy: SemanticPacket[] = []
    const receipts = new Map<string, SemanticReceipt>()
    const invalid: { file: string; detail: string }[] = []
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue
      const path = join(dir, file)
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (file.endsWith(RECEIPT_SUFFIX)) {
          const receipt = parsed !== null && typeof parsed === 'object'
            ? (parsed as { receipt?: unknown }).receipt
            : undefined
          if (!isSemanticReceipt(receipt)) {
            invalid.push({ file, detail: `not a schema-${SEMANTIC_SCHEMA_VERSION} receipt` })
            continue
          }
          receipts.set(receipt.packetId, receipt)
          continue
        }
        const packet = parsed !== null && typeof parsed === 'object'
          ? (parsed as { packet?: unknown }).packet
          : undefined
        if (isSemanticPacket(packet)) {
          packets.push(packet)
          continue
        }
        if (isLegacySemanticPacket(packet)) {
          legacy.push(packet)
          continue
        }
        invalid.push({ file, detail: `not a schema-${SEMANTIC_SCHEMA_VERSION} packet` })
      } catch (error: unknown) {
        invalid.push({ file, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    packets.sort((left, right) => comparePackets(left, right, receipts))
    return { packets, receipts, legacy, invalid }
  }
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Deterministic replay order.
 *
 * A committed packet is ordered by its PROOF's commit seq; a receipt-less
 * packet sorts after every committed one by staging seq. Wall time appears
 * nowhere: two processes can disagree about `Date.now()` and still must replay
 * the same history in the same order.
 */
export function comparePackets(
  left: SemanticPacket,
  right: SemanticPacket,
  receipts: ReadonlyMap<string, SemanticReceipt> = new Map(),
): number {
  const leftProof = receipts.get(left.packetId)?.proof
  const rightProof = receipts.get(right.packetId)?.proof
  const leftOrder = leftProof?.commitOrder ?? Number.MAX_SAFE_INTEGER
  const rightOrder = rightProof?.commitOrder ?? Number.MAX_SAFE_INTEGER
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  if (left.stagedAtSeq !== right.stagedAtSeq) return left.stagedAtSeq - right.stagedAtSeq
  return left.packetId.localeCompare(right.packetId)
}

/** A receipt's status as a packet lifecycle value, for diagnostics. */
export function packetStatusOf(
  receipt: SemanticReceipt | undefined,
): PacketStatus | 'conflict' {
  if (receipt === undefined) return 'staged'
  if (receipt.outcome === 'committed') return 'activated'
  return receipt.outcome === 'aborted' ? 'abandoned' : 'archived-only'
}
