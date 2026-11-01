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
 * ## Read, associate, then apply
 *
 * A readable file is not yet an authoritative record. `list` validates the
 * packet's runtime shape, its native v4 identity, every resolved operation, and
 * the one-to-one association between packet files and receipt files. An orphan
 * receipt, a file whose stem disagrees with its payload id, a receipt that
 * commits different operations, or a corrupt file is reported as an
 * `invalid` row — never silently admitted, and never quietly treated as an
 * empty journal.
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
import { opsDigestOf, packetIdOf, validateOps } from './ops.ts'

export { opsDigestOf, packetIdOf }

/** Whether a journal root was readable, absent, or an I/O failure. */
export type JournalReadState = 'ok' | 'valid-empty' | 'unreadable'

/** One structural problem that keeps a file from being authoritative. */
export interface JournalIssue {
  readonly file: string
  readonly detail: string
  /**
   * A machine-readable category. `io` and `corrupt` are storage failures;
   * `orphan-receipt`, `file-stem`, `packet-id`, `ops-invalid`, `binding`,
   * `ops-digest`, `duplicate` and `schema` are contradictions inside readable
   * bytes.
   */
  readonly code?:
    | 'io'
    | 'corrupt'
    | 'schema'
    | 'file-stem'
    | 'packet-id'
    | 'packet-span'
    | 'ops-invalid'
    | 'authority'
    | 'binding'
    | 'ops-digest'
    | 'orphan-receipt'
    | 'duplicate'
}

/** A packet plus the reason it could not be read, when one was skipped. */
export interface JournalRead {
  /** v4 prepared packets, ordered by commit proof (committed first, then staging seq). */
  readonly packets: readonly SemanticPacket[]
  /** The receipt for each packet id that has one AND agrees with that packet. */
  readonly receipts: ReadonlyMap<string, SemanticReceipt>
  /** Schema-3 packets: migration candidates, never applied as-is. */
  readonly legacy: readonly SemanticPacket[]
  /** Files that exist but are not an authoritative packet/receipt pair. */
  readonly invalid: readonly JournalIssue[]
  /** Receipt files with no packet file to apply them to. */
  readonly orphans: readonly { readonly file: string; readonly packetId: string; readonly detail: string }[]
  /**
   * Packets whose receipt FILE exists but could not be bound to them.
   *
   * The distinction from "no receipt" is load-bearing: an absent receipt is the
   * cross-store crash that recovery may complete, while a rejected receipt means
   * two records disagree. Treating the latter as missing would let recovery
   * overwrite a decision with a different one.
   */
  readonly rejectedReceipts: ReadonlyMap<string, string>
  /** `unreadable` outranks `ok`; `valid-empty` means the directory does not exist. */
  readonly state: JournalReadState
}

/** The journal surface the engine and the reconciler use. */
export interface SemanticJournal {
  /** Write one PREPARED packet. Idempotent for identical bytes, fatal for a different packet. */
  write(packet: SemanticPacket): Promise<void>
  /** Write one IMMUTABLE decision. Idempotent for an identical receipt, fatal otherwise. */
  writeReceipt(receipt: SemanticReceipt): Promise<void>
  /** Every packet, legacy packet, and associated receipt for one session. */
  list(sessionId: SessionId): Promise<JournalRead>
  /**
   * Whether this session has a journal directory.
   *
   * A fork needs this to distinguish "the parent had no semantic state" from
   * "the parent's journal is not here at all". Both list as zero packets, but
   * only the first is safe to treat as an empty seed.
   */
  hasSession(sessionId: SessionId): Promise<boolean>
  /**
   * The three-valued presence check.
   *
   * `hasSession` collapses `absent` and `unreadable` differently on purpose:
   * an I/O failure is NOT a missing directory, and a fork/recovery decision
   * must be able to tell them apart.
   */
  sessionState(sessionId: SessionId): Promise<'present' | 'absent' | 'unreadable'>
  /** The journal root, for diagnostics; absent for the null journal. */
  readonly root?: string
}

/** A journal that stores nothing: the `off` mode's zero-I/O face. */
export class NullSemanticJournal implements SemanticJournal {
  async write(): Promise<void> {}
  async writeReceipt(): Promise<void> {}
  async hasSession(): Promise<boolean> { return false }
  async sessionState(): Promise<'absent'> { return 'absent' }
  async list(): Promise<JournalRead> {
    return {
      packets: [],
      receipts: new Map(),
      legacy: [],
      invalid: [],
      orphans: [],
      rejectedReceipts: new Map(),
      state: 'valid-empty',
    }
  }
}

/**
 * Whether an unknown value is a complete enough v4 packet to replay.
 *
 * Strict about every field that decides STATE: schema, identity, mode,
 * authority, status, body/source/span digests, staged seq, folded seqs, and
 * every resolved operation (through the runtime validator). Audit-only fields
 * are checked for shape but not content.
 */
export function isSemanticPacket(value: unknown): value is SemanticPacket {
  if (value === null || typeof value !== 'object') return false
  const packet = value as Partial<SemanticPacket>
  if (packet.schemaVersion !== SEMANTIC_SCHEMA_VERSION) return false
  if (typeof packet.packetId !== 'string' || packet.packetId.length === 0) return false
  if (typeof packet.sessionId !== 'string' || packet.sessionId.length === 0) return false
  if (typeof packet.checkpointId !== 'string' || packet.checkpointId.length === 0) return false
  if (typeof packet.bodyDigest !== 'string' || packet.bodyDigest.length === 0) return false
  if (typeof packet.sourceDigest !== 'string' || packet.sourceDigest.length === 0) return false
  if (typeof packet.spanDigest !== 'string' || packet.spanDigest.length === 0) return false
  if (packet.mode !== 'off' && packet.mode !== 'shadow' && packet.mode !== 'active') return false
  if (packet.authority !== 'journal' && packet.authority !== 'session-record') return false
  if (packet.status !== 'staged' && packet.status !== 'activated'
    && packet.status !== 'abandoned' && packet.status !== 'archived-only') return false
  if (typeof packet.stagedAtSeq !== 'number' || !Number.isSafeInteger(packet.stagedAtSeq)
    || packet.stagedAtSeq < 0) return false
  if (typeof packet.createdAt !== 'number' || !Number.isFinite(packet.createdAt)) return false
  if (!seqArray(packet.foldedSeqs)) return false
  if (typeof packet.handoff !== 'string') return false
  if (packet.deltaParse !== 'parsed' && packet.deltaParse !== 'absent' && packet.deltaParse !== 'malformed') {
    return false
  }
  if (!Array.isArray(packet.proposed) || !Array.isArray(packet.accepted) || !Array.isArray(packet.refused)) {
    return false
  }
  if (!Array.isArray(packet.ops)) return false
  if (!validateOps(packet.ops).ok) return false
  return true
}

/**
 * Whether an unknown value is a readable v3 packet.
 *
 * It is accepted only as a MIGRATION candidate. The caller must re-prove the
 * fold and compute the source digest from the bundle before it becomes state.
 * The operations still pass the same runtime validator: an unreadable v3 body
 * is not a migration problem, it is malformed input.
 */
export function isLegacySemanticPacket(value: unknown): value is SemanticPacket {
  if (value === null || typeof value !== 'object') return false
  const packet = value as Partial<SemanticPacket>
  if (packet.schemaVersion !== LEGACY_SEMANTIC_SCHEMA_VERSION) return false
  if (typeof packet.packetId !== 'string' || packet.packetId.length === 0) return false
  if (typeof packet.sessionId !== 'string' || packet.sessionId.length === 0) return false
  if (typeof packet.checkpointId !== 'string' || packet.checkpointId.length === 0) return false
  if (typeof packet.bodyDigest !== 'string' || packet.bodyDigest.length === 0) return false
  if (packet.mode !== 'off' && packet.mode !== 'shadow' && packet.mode !== 'active') return false
  if (packet.authority !== 'journal' && packet.authority !== 'session-record') return false
  if (packet.status !== 'staged' && packet.status !== 'activated'
    && packet.status !== 'abandoned' && packet.status !== 'archived-only') return false
  if (typeof packet.stagedAtSeq !== 'number' || !Number.isSafeInteger(packet.stagedAtSeq)
    || packet.stagedAtSeq < 0) return false
  if (!seqArray(packet.foldedSeqs)) return false
  if (typeof packet.handoff !== 'string') return false
  if (!Array.isArray(packet.proposed) || !Array.isArray(packet.accepted) || !Array.isArray(packet.refused)) {
    return false
  }
  if (!Array.isArray(packet.ops)) return false
  return validateOps(packet.ops).ok
}

function seqArray(value: unknown): value is readonly number[] {
  return Array.isArray(value)
    && value.every(seq => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
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
    && proof.commitOrder === proof.replacementSeq
    && typeof proof.sourceDigest === 'string'
    && typeof proof.bodyDigest === 'string'
    && typeof proof.summaryDigest === 'string'
    && typeof proof.spanDigest === 'string'
    && seqArray(proof.shadowedSeqs)
}

/** Whether an unknown value is a receipt this build may act on. */
export function isSemanticReceipt(value: unknown): value is SemanticReceipt {
  if (value === null || typeof value !== 'object') return false
  const receipt = value as Partial<SemanticReceipt>
  if (receipt.kind !== 'receipt') return false
  if (receipt.schemaVersion !== SEMANTIC_SCHEMA_VERSION) return false
  if (typeof receipt.packetId !== 'string' || receipt.packetId.length === 0) return false
  if (typeof receipt.sessionId !== 'string' || receipt.sessionId.length === 0) return false
  if (typeof receipt.checkpointId !== 'string' || receipt.checkpointId.length === 0) return false
  if (typeof receipt.opsDigest !== 'string' || receipt.opsDigest.length === 0) return false
  if (typeof receipt.decidedAt !== 'number' || !Number.isFinite(receipt.decidedAt)) return false
  if (receipt.reason !== undefined && typeof receipt.reason !== 'string') return false
  if (receipt.outcome === 'committed') return isProof(receipt.proof)
  if (receipt.outcome !== 'aborted' && receipt.outcome !== 'archived-only') return false
  return receipt.proof === undefined
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
const LEGACY_SUFFIX = '.v3.json'

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
    await rename(path, join(dirname(path), `${packetId}${LEGACY_SUFFIX}`))
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
    if (!isSemanticPacket(packet)) {
      throw new Error('epistemic-fold: refusing to journal a packet that does not satisfy the v4 runtime schema')
    }
    if (packet.authority !== 'journal') {
      throw new Error(
        `epistemic-fold: refusing to journal a "${packet.authority}" packet as journal authority`,
      )
    }
    const expected = packetIdOf({
      sessionId: packet.sessionId,
      checkpointId: packet.checkpointId,
      foldedSeqs: packet.foldedSeqs,
      bodyDigest: packet.bodyDigest,
    })
    if (expected !== packet.packetId) {
      throw new Error(
        `epistemic-fold: refusing to journal packet ${packet.packetId}; its v4 identity is ${expected}`,
      )
    }
    if (canonicalHash([...packet.foldedSeqs]) !== packet.spanDigest) {
      throw new Error('epistemic-fold: refusing to journal a packet whose spanDigest does not hash its foldedSeqs')
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
    if (!isSemanticReceipt(receipt)) {
      throw new Error('epistemic-fold: refusing to write a receipt that does not satisfy the v4 runtime schema')
    }
    const dir = this.dir(receipt.sessionId)
    await mkdir(dir, { recursive: true })
    const packetPath = this.file(receipt.sessionId, receipt.packetId)
    const raw = await readFile(packetPath, 'utf8').catch(() => undefined)
    if (raw === undefined) {
      throw new Error(
        `epistemic-fold: refusing to write a receipt for packet ${receipt.packetId}; `
        + 'no prepared packet exists for it',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`epistemic-fold: refusing to write a receipt for an unreadable packet ${receipt.packetId}`)
    }
    const packet = parsed !== null && typeof parsed === 'object'
      ? (parsed as { packet?: unknown }).packet
      : undefined
    if (!isSemanticPacket(packet)) {
      throw new Error(`epistemic-fold: refusing to write a receipt for a non-v4 packet ${receipt.packetId}`)
    }
    if (packet.packetId !== receipt.packetId
      || String(packet.sessionId) !== String(receipt.sessionId)
      || packet.checkpointId !== receipt.checkpointId) {
      throw new Error(
        `epistemic-fold: refusing to bind receipt ${receipt.packetId} to a packet with a different identity`,
      )
    }
    if (receipt.opsDigest !== opsDigestOf(packet)) {
      throw new Error(
        `epistemic-fold: refusing to write a receipt whose opsDigest does not hash packet ${packet.packetId}`,
      )
    }
    const body = `${JSON.stringify({
      kind: 'receipt-file',
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      receipt,
    } satisfies ReceiptFile, null, 2)}\n`
    await this.writeImmutable(this.receiptFile(receipt.sessionId, receipt.packetId), body, 'commit receipt')
  }

  async sessionState(sessionId: SessionId): Promise<'present' | 'absent' | 'unreadable'> {
    try {
      await readdir(this.dir(sessionId))
      return 'present'
    } catch (error: unknown) {
      return isMissingFile(error) ? 'absent' : 'unreadable'
    }
  }

  async hasSession(sessionId: SessionId): Promise<boolean> {
    return await this.sessionState(sessionId) === 'present'
  }

  async list(sessionId: SessionId): Promise<JournalRead> {
    const dir = this.dir(sessionId)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return {
          packets: [],
          receipts: new Map(),
          legacy: [],
          invalid: [],
          orphans: [],
          rejectedReceipts: new Map(),
          state: 'valid-empty',
        }
      }
      return {
        packets: [],
        receipts: new Map(),
        legacy: [],
        invalid: [{
          file: dir,
          detail: `journal directory is unreadable: ${describeError(error)}`,
          code: 'io',
        }],
        orphans: [],
        rejectedReceipts: new Map(),
        state: 'unreadable',
      }
    }

    const invalid: JournalIssue[] = []
    const packets: SemanticPacket[] = []
    const legacy: SemanticPacket[] = []
    const packetFiles = new Map<string, string>()
    const receiptCandidates = new Map<string, { file: string; receipt: SemanticReceipt }>()
    const rejectedReceipts = new Map<string, string>()
    let state: JournalReadState = 'ok'

    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue
      const path = join(dir, file)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error: unknown) {
        // A file that cannot be READ is a storage failure; the journal's
        // contents are unknown, so the whole read is unreadable.
        invalid.push({
          file,
          detail: `unreadable record: ${describeError(error)}`,
          code: 'io',
        })
        state = 'unreadable'
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error: unknown) {
        // A file we read but cannot parse is CORRUPT, not unreadable: the
        // directory is intact and the rest of the journal is still knowable.
        invalid.push({
          file,
          detail: `malformed JSON: ${describeError(error)}`,
          code: 'corrupt',
        })
        continue
      }
      if (file.endsWith(RECEIPT_SUFFIX)) {
        const rawReceipt = parsed !== null && typeof parsed === 'object'
          ? (parsed as { receipt?: unknown }).receipt
          : undefined
        const claimedId = rawReceipt !== null && typeof rawReceipt === 'object'
          ? (rawReceipt as { packetId?: unknown }).packetId
          : undefined
        const receipt = rawReceipt
        if (!isSemanticReceipt(receipt)) {
          const detail = `not a schema-${SEMANTIC_SCHEMA_VERSION} receipt`
          invalid.push({ file, detail, code: 'schema' })
          if (typeof claimedId === 'string') rejectedReceipts.set(claimedId, detail)
          continue
        }
        const stem = file.slice(0, -RECEIPT_SUFFIX.length)
        if (receipt.packetId !== stem) {
          const detail = `receipt file stem "${stem}" disagrees with payload packetId "${receipt.packetId}"`
          invalid.push({ file, detail, code: 'file-stem' })
          rejectedReceipts.set(receipt.packetId, detail)
          continue
        }
        if (receiptCandidates.has(receipt.packetId)) {
          const detail = `duplicate receipt identity "${receipt.packetId}"`
          invalid.push({ file, detail, code: 'duplicate' })
          rejectedReceipts.set(receipt.packetId, detail)
          continue
        }
        receiptCandidates.set(receipt.packetId, { file, receipt })
        continue
      }

      const packet = parsed !== null && typeof parsed === 'object'
        ? (parsed as { packet?: unknown }).packet
        : undefined
      if (isSemanticPacket(packet)) {
        const archivedName = file.endsWith(LEGACY_SUFFIX)
        const stem = archivedName
          ? file.slice(0, -LEGACY_SUFFIX.length)
          : file.slice(0, -'.json'.length)
        if (archivedName) {
          invalid.push({
            file,
            detail: 'a v4 packet is stored under a .v3.json archive name',
            code: 'file-stem',
          })
          continue
        }
        if (packet.packetId !== stem) {
          invalid.push({
            file,
            detail: `packet file stem "${stem}" disagrees with payload packetId "${packet.packetId}"`,
            code: 'file-stem',
          })
          continue
        }
        const expected = packetIdOf({
          sessionId: packet.sessionId,
          checkpointId: packet.checkpointId,
          foldedSeqs: packet.foldedSeqs,
          bodyDigest: packet.bodyDigest,
        })
        if (expected !== packet.packetId) {
          invalid.push({
            file,
            detail: `packet id ${packet.packetId} is not the v4 identity of its body (${expected})`,
            code: 'packet-id',
          })
          continue
        }
        if (canonicalHash([...packet.foldedSeqs]) !== packet.spanDigest) {
          invalid.push({ file, detail: 'spanDigest does not hash foldedSeqs', code: 'packet-span' })
          continue
        }
        if (packet.authority !== 'journal') {
          invalid.push({
            file,
            detail: `journal row claims authority "${packet.authority}"`,
            code: 'authority',
          })
          continue
        }
        if (packetFiles.has(packet.packetId)) {
          invalid.push({
            file,
            detail: `duplicate packet identity "${packet.packetId}" (also ${packetFiles.get(packet.packetId)})`,
            code: 'duplicate',
          })
          continue
        }
        packetFiles.set(packet.packetId, file)
        packets.push(packet)
        continue
      }
      if (isLegacySemanticPacket(packet)) {
        const stem = file.endsWith(LEGACY_SUFFIX)
          ? file.slice(0, -LEGACY_SUFFIX.length)
          : file.slice(0, -'.json'.length)
        if (packet.packetId !== stem) {
          invalid.push({
            file,
            detail: `legacy packet file stem "${stem}" disagrees with payload packetId "${packet.packetId}"`,
            code: 'file-stem',
          })
          continue
        }
        legacy.push(packet)
        continue
      }
      invalid.push({
        file,
        detail: `not a schema-${SEMANTIC_SCHEMA_VERSION} packet (or a readable schema-${LEGACY_SEMANTIC_SCHEMA_VERSION} migration candidate)`,
        code: 'schema',
      })
    }

    const receipts = new Map<string, SemanticReceipt>()
    const orphans: { file: string; packetId: string; detail: string }[] = []
    const byId = new Map(packets.map(packet => [packet.packetId, packet]))
    for (const [packetId, candidate] of receiptCandidates) {
      const packet = byId.get(packetId)
      if (packet === undefined) {
        const detail = 'receipt has no prepared packet to apply to'
        orphans.push({ file: candidate.file, packetId, detail })
        invalid.push({ file: candidate.file, detail, code: 'orphan-receipt' })
        continue
      }
      const receipt = candidate.receipt
      const reject = (detail: string, code: NonNullable<JournalIssue['code']>): void => {
        invalid.push({ file: candidate.file, detail, code })
        rejectedReceipts.set(packetId, detail)
      }
      if (String(receipt.sessionId) !== String(packet.sessionId)) {
        reject('receipt names a different session than its packet', 'binding')
        continue
      }
      if (receipt.checkpointId !== packet.checkpointId) {
        reject('receipt names a different checkpoint than its packet', 'binding')
        continue
      }
      if (receipt.opsDigest !== opsDigestOf(packet)) {
        reject('receipt commits different operations than its packet', 'ops-digest')
        continue
      }
      if (receipt.outcome === 'committed'
        && (receipt.proof?.bodyDigest !== packet.bodyDigest
          || receipt.proof.spanDigest !== packet.spanDigest
          || receipt.proof.checkpointId !== packet.checkpointId)) {
        reject('receipt proof describes a different packet body/span', 'binding')
        continue
      }
      receipts.set(packetId, receipt)
    }

    packets.sort((left, right) => comparePackets(left, right, receipts))
    return { packets, receipts, legacy, invalid, orphans, rejectedReceipts, state }
  }
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { code?: unknown }).code === 'ENOENT'
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message
  }
  return String(error)
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
