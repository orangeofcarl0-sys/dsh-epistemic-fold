/**
 * The semantic journal: the durable staging record for one deployment's
 * semantic packets, and the AUTHORITY for semantic state on hosts that cannot
 * write a plugin record.
 *
 * ## One file per packet, one mutable field
 *
 * A packet is written ATOMICALLY before it can commit, then rewritten in place
 * exactly once, when its status changes from `staged` to `activated` or
 * `abandoned`. There is no commit-log append: a commit record written before
 * the fold could only describe an intent, and one written after it would be a
 * second source of truth for a fact the packet's status already carries.
 *
 * ## Write, then read back
 *
 * Every write verifies what landed by reading the file and comparing its
 * digest. A short write or a torn rename is the one failure that would look
 * like a commit, so it is checked rather than assumed. The atomic-write
 * primitive renames a sibling temp file, which is atomic on the same
 * filesystem; the read-back catches everything the rename cannot.
 *
 * ## Statuses are the state machine
 *
 *   staged        not state. The fold has not committed, or we cannot tell yet.
 *   activated     state. Its `ops` are folded, in packet order, onto the
 *                 session-derived projection.
 *   abandoned     never state. The fold did not commit, or a retry won instead.
 *   archived-only the bundle is durable but the surface never committed.
 *
 * @module dsh-epistemic-fold/semantic/journal
 */

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalHash } from '../checkpoint/hash.ts'
import { SEMANTIC_SCHEMA_VERSION } from './types.ts'
import type { PacketStatus, SemanticPacket } from './types.ts'

/** A packet plus the reason it could not be read, when one was skipped. */
export interface JournalRead {
  readonly packets: readonly SemanticPacket[]
  /** Files that exist but are not a valid v3 packet (corrupt, older schema). */
  readonly invalid: readonly { readonly file: string; readonly detail: string }[]
}

/** The journal surface the engine and the reconciler use. */
export interface SemanticJournal {
  /** Write one packet and verify it landed. */
  write(packet: SemanticPacket): Promise<void>
  /** Rewrite one packet's status; `patch` may add activation/abandon detail. */
  setStatus(
    packetId: string,
    status: PacketStatus,
    patch?: { readonly activatedAt?: number; readonly abandonReason?: string },
  ): Promise<SemanticPacket | undefined>
  /** Every packet for one session, in staging order. */
  list(sessionId: SessionId): Promise<JournalRead>
  /** The journal root, for diagnostics; absent for the null journal. */
  readonly root?: string
}

/** A journal that stores nothing: the `off` mode's zero-I/O face. */
export class NullSemanticJournal implements SemanticJournal {
  async write(): Promise<void> {}
  async setStatus(): Promise<undefined> { return undefined }
  async list(): Promise<JournalRead> { return { packets: [], invalid: [] } }
}

/**
 * Whether an unknown value is a complete enough v3 packet to replay.
 *
 * Deliberately strict about the fields that decide STATE (`status`,
 * `authority`, `ops`) and lenient about audit-only fields. A packet that
 * passes but whose ops are individually malformed is still a problem; the
 * record guard in `semantic/record.ts` validates the ops themselves at the
 * point they are applied.
 */
export function isSemanticPacket(value: unknown): value is SemanticPacket {
  if (value === null || typeof value !== 'object') return false
  const packet = value as Partial<SemanticPacket>
  return packet.schemaVersion === SEMANTIC_SCHEMA_VERSION
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

/** The identity of one staged body. */
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

/**
 * File-backed journal.
 *
 * `<root>/<sessionId>/<packetId>.json` keeps one session's packets together
 * and makes `list` a directory read rather than an index rebuild. A packet
 * file is immutable except for its status transition, so two processes racing
 * on the same session are rewriting the same packet — and the write is atomic,
 * so the later answer wins rather than a torn file.
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

  async write(packet: SemanticPacket): Promise<void> {
    const dir = this.dir(packet.sessionId)
    await mkdir(dir, { recursive: true })
    const path = this.file(packet.sessionId, packet.packetId)
    const body = `${JSON.stringify({ kind: 'packet', schemaVersion: SEMANTIC_SCHEMA_VERSION, packet }, null, 2)}\n`
    await writeFileAtomic(path, body, { mode: 0o600, dirMode: 0o700 })
    const landed = await readFile(path, 'utf8')
    if (landed !== body) {
      throw new Error(
        `epistemic-fold: semantic journal write did not land intact at ${path} `
        + `(wrote ${body.length} bytes, read ${landed.length})`,
      )
    }
  }

  async setStatus(
    packetId: string,
    status: PacketStatus,
    patch: { readonly activatedAt?: number; readonly abandonReason?: string } = {},
  ): Promise<SemanticPacket | undefined> {
    const found = await this.find(packetId)
    if (found === undefined) return undefined
    const next: SemanticPacket = {
      ...found.packet,
      status,
      ...(patch.activatedAt === undefined ? {} : { activatedAt: patch.activatedAt }),
      ...(patch.abandonReason === undefined ? {} : { abandonReason: patch.abandonReason }),
    }
    // `write` verifies the read-back; the status file is the commit record, so
    // a silent failure here is exactly the failure that must not be silent.
    await this.write(next)
    return next
  }

  /** Locate one packet across sessions; used by `setStatus` without a session id. */
  private async find(packetId: string): Promise<{ readonly packet: SemanticPacket } | undefined> {
    let sessions: string[]
    try {
      sessions = await readdir(this.root)
    } catch {
      return undefined
    }
    for (const session of sessions) {
      const path = join(this.root, session, `${packetId}.json`)
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && isSemanticPacket((parsed as { packet?: unknown }).packet)) {
          return { packet: (parsed as { packet: SemanticPacket }).packet }
        }
      } catch {
        // Not this session, or not a packet. `list` reports the invalid ones.
      }
    }
    return undefined
  }

  async list(sessionId: SessionId): Promise<JournalRead> {
    const dir = this.dir(sessionId)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return { packets: [], invalid: [] }
    }
    const packets: SemanticPacket[] = []
    const invalid: { file: string; detail: string }[] = []
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue
      const path = join(dir, file)
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        const packet = parsed !== null && typeof parsed === 'object'
          ? (parsed as { packet?: unknown }).packet
          : undefined
        if (!isSemanticPacket(packet)) {
          invalid.push({ file, detail: `not a schema-${SEMANTIC_SCHEMA_VERSION} packet` })
          continue
        }
        packets.push(packet)
      } catch (error: unknown) {
        invalid.push({ file, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    packets.sort(comparePackets)
    return { packets, invalid }
  }
}

/**
 * Staging order, with `activatedAt` first for packets that have one.
 *
 * Replay applies activated packets in this order, so it must be total and
 * stable. A packet's ops are already resolved, but two packets writing the
 * same coordinate still need a defined last writer; commit time is the honest
 * order, and staging time is the only available proxy before commit.
 */
export function comparePackets(left: SemanticPacket, right: SemanticPacket): number {
  const leftAt = left.activatedAt ?? left.createdAt
  const rightAt = right.activatedAt ?? right.createdAt
  if (leftAt !== rightAt) return leftAt - rightAt
  return left.packetId.localeCompare(right.packetId)
}
