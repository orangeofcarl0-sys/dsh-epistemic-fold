/**
 * The semantic journal: an append-only, per-session record of what the writer
 * proposed, what the runtime validated, and what was committed.
 *
 * ## Why a journal exists when `ef/anchor` events already persist
 *
 * The anchor events are the durable STATE — the reducer replays them, and the
 * projection reconstructs the current values. What they do not carry is the
 * audit trail: which proposal was refused and why, which fold produced it, and
 * whether a commit was ever attempted. Those facts are needed for three things
 * that the state alone cannot answer:
 *
 *  1. **Idempotency.** A retried fold must be a no-op. The journal holds the
 *     delta identities already committed, so the validator can refuse a repeat
 *     instead of appending a second anchor at the same coordinate.
 *  2. **Crash reconciliation.** A packet can be accepted and journaled while
 *     the anchor append never happens (process dies between the two). On the
 *     next fold the journal is compared against the log and the missing anchor
 *     is re-committed. `committed = true` in memory could never survive that.
 *  3. **Honest health.** `partial` and `unavailable` are claims about the
 *     semantic layer, and they need evidence: how many proposals were refused,
 *     and for what reason. Without the journal, the only available answer would
 *     be "some text was produced".
 *
 * ## Storage
 *
 * One atomically-written JSON file per packet, in the same layout and with the
 * same guarantees as `bundle-store.ts` (write → read back → hash verify). The
 * journal is NOT a second session log: it never stores message text, only
 * quotes already verified against the log, and it is safe to lose — losing it
 * costs idempotency and audit, not state, because the anchors are in the log.
 *
 * ## What is never written
 *
 * No message bodies, no tool output, no checkpoint text. A journal line is a
 * claim pointer: kind, coordinate, statement, evidence `(seq, digest, quote)`,
 * and the runtime's verdict. Statements are the writer's own words and ARE
 * recorded — they are the semantic content this layer exists to carry, and they
 * were already shown to the model.
 *
 * @module dsh-epistemic-fold/semantic/journal
 */

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalHash } from '../hash.ts'
import type {
  AcceptedDelta,
  ReconciliationReport,
  SemanticHealth,
  SemanticPacket,
} from './types.ts'
import { SEMANTIC_SCHEMA_VERSION } from './types.ts'
import { anchorIdOf } from './validate.ts'

const JOURNAL_FILE_MODE = 0o600
const JOURNAL_DIR_MODE = 0o700

/** One file per packet, named by its content-derived id. */
function packetPath(root: string, sessionId: string, packetId: string): string {
  return join(root, sessionId, `packet-${packetId}.json`)
}

/** The semantic journal interface; the engine owns one instance. */
export interface SemanticJournal {
  /** Persist one complete packet (proposal + verdicts). Idempotent by packetId. */
  write(packet: SemanticPacket): Promise<void>
  /**
   * Record that one accepted delta became one anchor.
   *
   * Kept separate from the packet so the ordering is visible in the files:
   * a packet with no commit line is an intent, a packet with commit lines is a
   * transaction that landed.
   */
  recordCommit(sessionId: SessionId, packetId: string, commits: readonly SemanticCommit[]): Promise<void>
  /** Record a health transition with its reason. */
  recordHealth(sessionId: SessionId, packetId: string, health: SemanticHealth, detail?: string): Promise<void>
  /** Every packet for one session, oldest first. Unreadable files are skipped. */
  readAll(sessionId: SessionId): Promise<readonly SemanticPacket[]>
  /** Every committed delta for one session, with its anchor id. */
  readCommits(sessionId: SessionId): Promise<readonly SemanticCommitRecord[]>
  /** Durable health verdicts, latest last. */
  readHealth(sessionId: SessionId): Promise<readonly { health: SemanticHealth; detail?: string }[]>
  /**
   * Compare the journal's accepted deltas against the anchors in a live log.
   *
   * @param anchorsById - the anchor ids currently present in the session log.
   * @returns the missing deltas and the resulting health.
   */
  reconcile(sessionId: SessionId, anchorsById: ReadonlySet<string>): Promise<ReconciliationReport>
}

/** One delta-to-anchor mapping. */
export interface SemanticCommit {
  readonly deltaId: string
  readonly anchorId: string
}

/** A commit record as stored. */
export interface SemanticCommitRecord extends SemanticCommit {
  readonly packetId: string
}

/**
 * The packet's stable identity: the span it describes, not the fold that
 * happened to produce it. A retried fold re-uses the id, so its packet file is
 * the same file.
 *
 * @param sessionId - owning session.
 * @param foldedSeqs - the span's surface seqs, in order.
 * @returns a content identity for the packet.
 */
export function packetIdOf(sessionId: SessionId, foldedSeqs: readonly number[]): string {
  return canonicalHash({ sessionId, foldedSeqs: [...foldedSeqs] })
}

/**
 * Every delta identity whose anchor is ACTUALLY IN THE LOG.
 *
 * ## Why "accepted" is not "committed"
 *
 * A delta is accepted when it passes validation. It is committed when its
 * `ef/anchor` append lands. Those differ in two ordinary situations: every
 * delta of a `shadow` packet (never meant to be anchored), and any delta whose
 * declare threw (a refused durable write, a host without the capability). Using
 * `accepted` as the idempotency oracle therefore refused a genuine re-proposal
 * as `duplicate` and silently dropped the claim — most visibly on the documented
 * shadow → active transition, where the previous shadow packets cover the same
 * spans.
 *
 * The identity is derived (`anchorIdOf`), so the LOG alone decides.
 *
 * @param packets - the session's packets, oldest first.
 * @param anchorIds - every anchor id present in the session log.
 * @returns the ids that have a durable anchor.
 */
export function committedDeltaIds(
  packets: readonly SemanticPacket[],
  anchorIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>()
  for (const packet of packets) {
    if (packet.mode !== 'active') continue
    for (const delta of packet.accepted) {
      if (anchorIds.has(anchorIdOf(delta.deltaId))) ids.add(delta.deltaId)
    }
  }
  return ids
}

/** Sidecar file holding the commit lines for one packet. */
function commitPath(root: string, sessionId: string, packetId: string): string {
  return join(root, sessionId, `commit-${packetId}.json`)
}

/** Sidecar file holding health transitions for one packet. */
function healthPath(root: string, sessionId: string, packetId: string): string {
  return join(root, sessionId, `health-${packetId}.json`)
}

/** Write one JSON document atomically, creating the session directory. */
async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: JOURNAL_DIR_MODE })
  const serialized = JSON.stringify(value)
  await writeFileAtomic(target, serialized, { mode: JOURNAL_FILE_MODE, dirMode: JOURNAL_DIR_MODE })
  // Read back, like the bundle store: a journal that silently wrote nothing
  // would make the next fold re-commit deltas it already committed.
  const stored = await readFile(target, 'utf8')
  if (stored !== serialized) {
    throw new Error(`epistemic-fold: semantic journal write verification failed for ${target}`)
  }
}

/** Read one JSON document, or `undefined` when absent/unreadable. */
async function readJson<T>(target: string): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** Whether a parsed packet is one this build understands. */
function isKnownPacket(value: unknown): value is SemanticPacket {
  if (value === null || typeof value !== 'object') return false
  const packet = value as Partial<SemanticPacket>
  if (packet.schemaVersion !== SEMANTIC_SCHEMA_VERSION
    || typeof packet.packetId !== 'string'
    || (packet.mode !== 'active' && packet.mode !== 'shadow' && packet.mode !== 'off')
    || !Array.isArray(packet.accepted)
    || !Array.isArray(packet.refused)) {
    return false
  }
  // Every accepted entry is read back for repair, so its SHAPE is checked here
  // rather than trusted. A cast that admitted a corrupt entry would throw inside
  // reconciliation (and abort a fold) or build an anchor draft that never
  // passed validation.
  return packet.accepted.every(isAcceptedDelta)
}

/** Whether one journaled entry has the fields reconciliation reads. */
function isAcceptedDelta(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const delta = value as Partial<AcceptedDelta>
  return typeof delta.deltaId === 'string'
    && typeof delta.kind === 'string'
    && typeof delta.subjectKey === 'string'
    && typeof delta.statement === 'string'
    && typeof delta.authority === 'string'
    && Array.isArray(delta.evidence)
    && delta.evidence.every(entry =>
      entry !== null && typeof entry === 'object'
      && typeof (entry as { seq?: unknown }).seq === 'number'
      && typeof (entry as { messageDigest?: unknown }).messageDigest === 'string')
}

/** Union two accepted lists by delta identity, keeping the first occurrence. */
function mergeAccepted(
  previous: readonly AcceptedDelta[],
  incoming: readonly AcceptedDelta[],
): readonly AcceptedDelta[] {
  const byId = new Map<string, AcceptedDelta>()
  for (const delta of previous) byId.set(delta.deltaId, delta)
  for (const delta of incoming) if (!byId.has(delta.deltaId)) byId.set(delta.deltaId, delta)
  return [...byId.values()]
}

/**
 * The file-backed journal.
 *
 * Writes are idempotent by `packetId`: writing the same span twice replaces the
 * same file with equivalent content rather than accumulating copies. Reads skip
 * anything unparseable or from an unknown schema version instead of throwing —
 * a corrupt journal must never block a fold, because the state itself lives in
 * the session log.
 */
export class FileSemanticJournal implements SemanticJournal {
  constructor(private readonly root: string) {}

  async write(packet: SemanticPacket): Promise<void> {
    const target = packetPath(this.root, packet.sessionId, packet.packetId)
    // A retried fold covers the same span and therefore the same packet id. The
    // retry's deltas are refused as already-committed, so a naive overwrite
    // would erase the ACCEPTANCE record of the first attempt and hand the next
    // retry a fresh chance to re-declare. Union instead: a packet can gain
    // accepted deltas, never lose them.
    const existing = await readJson<{ packet?: unknown }>(target)
    const merged = existing?.packet !== undefined && isKnownPacket(existing.packet)
      ? { ...packet, accepted: mergeAccepted(existing.packet.accepted, packet.accepted) }
      : packet
    await writeJson(target, { schemaVersion: SEMANTIC_SCHEMA_VERSION, packet: merged })
  }

  async recordCommit(sessionId: SessionId, packetId: string, commits: readonly SemanticCommit[]): Promise<void> {
    if (commits.length === 0) return
    const target = commitPath(this.root, sessionId, packetId)
    const existing = await readJson<{ schemaVersion: number; commits: SemanticCommitRecord[] }>(target)
    const merged = new Map<string, SemanticCommitRecord>()
    for (const record of existing?.commits ?? []) {
      if (typeof record?.deltaId === 'string') merged.set(record.deltaId, record)
    }
    for (const commit of commits) {
      merged.set(commit.deltaId, { ...commit, packetId })
    }
    await writeJson(target, {
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      commits: [...merged.values()],
    })
  }

  async recordHealth(sessionId: SessionId, packetId: string, health: SemanticHealth, detail?: string): Promise<void> {
    await writeJson(healthPath(this.root, sessionId, packetId), {
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      packetId,
      health,
      ...(detail === undefined ? {} : { detail }),
      at: Date.now(),
    })
  }

  async readAll(sessionId: SessionId): Promise<readonly SemanticPacket[]> {
    const dir = join(this.root, sessionId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const packets: SemanticPacket[] = []
    for (const name of names.sort()) {
      if (!name.startsWith('packet-') || !name.endsWith('.json')) continue
      const stored = await readJson<{ packet?: unknown }>(join(dir, name))
      if (stored?.packet !== undefined && isKnownPacket(stored.packet)) packets.push(stored.packet)
    }
    return packets.sort((left, right) => left.createdAt - right.createdAt)
  }

  async readCommits(sessionId: SessionId): Promise<readonly SemanticCommitRecord[]> {
    const dir = join(this.root, sessionId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const commits: SemanticCommitRecord[] = []
    for (const name of names.sort()) {
      if (!name.startsWith('commit-') || !name.endsWith('.json')) continue
      const stored = await readJson<{ schemaVersion?: number; commits?: unknown }>(join(dir, name))
      if (stored?.schemaVersion !== SEMANTIC_SCHEMA_VERSION || !Array.isArray(stored.commits)) continue
      for (const entry of stored.commits as SemanticCommitRecord[]) {
        if (typeof entry?.deltaId === 'string' && typeof entry?.anchorId === 'string') commits.push(entry)
      }
    }
    return commits
  }

  async readHealth(sessionId: SessionId): Promise<readonly { health: SemanticHealth; detail?: string }[]> {
    const dir = join(this.root, sessionId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const out: { health: SemanticHealth; detail?: string }[] = []
    for (const name of names.sort()) {
      if (!name.startsWith('health-') || !name.endsWith('.json')) continue
      const stored = await readJson<{ schemaVersion?: number; health?: SemanticHealth; detail?: string }>(join(dir, name))
      if (stored?.schemaVersion !== SEMANTIC_SCHEMA_VERSION || typeof stored.health !== 'string') continue
      out.push({ health: stored.health, ...(stored.detail === undefined ? {} : { detail: stored.detail }) })
    }
    return out
  }

  async reconcile(sessionId: SessionId, anchorsById: ReadonlySet<string>): Promise<ReconciliationReport> {
    // Ordered by FOLD POSITION, not by wall clock: the head at a shared
    // coordinate is whichever repair lands last, and `createdAt` can tie or go
    // backwards. `foldedSeqs` is the durable order the log itself records.
    const packets = [...await this.readAll(sessionId)].sort((left, right) => {
      const leftStart = Math.min(...left.foldedSeqs)
      const rightStart = Math.min(...right.foldedSeqs)
      if (leftStart !== rightStart) return leftStart - rightStart
      return left.createdAt - right.createdAt
    })
    const missing: { packetId: string; delta: AcceptedDelta }[] = []
    let present = 0
    for (const packet of packets) {
      // A `shadow` packet is a MEASUREMENT, not a promise: its deltas were
      // never meant to become anchors, so their absence from the log is not a
      // gap. Repairing them would silently turn shadow mode into active mode
      // one restart later.
      if (packet.mode !== 'active') continue
      for (const delta of packet.accepted) {
        // A journal-only kind (`experience-candidate`) has no anchor BY
        // CONTRACT, so its absence is not a gap either. Counting it as one made
        // every writer that emitted a candidate look permanently stale.
        if (delta.anchorKind === undefined) continue
        // The anchor id is DERIVED from the delta identity, so the session log
        // alone answers "was this committed?". The commit sidecar is audit
        // only: trusting it would make a lost sidecar look like lost state.
        if (anchorsById.has(anchorIdOf(delta.deltaId))) {
          present += 1
          continue
        }
        missing.push({ packetId: packet.packetId, delta })
      }
    }
    if (missing.length === 0) {
      return { packets: packets.length, missing, present, health: 'ready' }
    }
    return {
      packets: packets.length,
      missing,
      present,
      health: 'stale',
      detail: `${missing.length} accepted delta(s) have no anchor in the session log`,
    }
  }
}

/**
 * A journal that keeps nothing.
 *
 * Used when `semanticContinuity.mode` is `off`: the engine must not create a
 * directory, must not read one, and must not acquire a second source of truth.
 */
export class NullSemanticJournal implements SemanticJournal {
  async write(_packet: SemanticPacket): Promise<void> {}
  async recordCommit(_sessionId: SessionId, _packetId: string, _commits: readonly SemanticCommit[]): Promise<void> {}
  async recordHealth(
    _sessionId: SessionId,
    _packetId: string,
    _health: SemanticHealth,
    _detail?: string,
  ): Promise<void> {}
  async readAll(_sessionId: SessionId): Promise<readonly SemanticPacket[]> {
    return []
  }
  async readCommits(_sessionId: SessionId): Promise<readonly SemanticCommitRecord[]> {
    return []
  }
  async readHealth(_sessionId: SessionId): Promise<readonly { health: SemanticHealth; detail?: string }[]> {
    return []
  }
  async reconcile(_sessionId: SessionId, _anchorsById: ReadonlySet<string>): Promise<ReconciliationReport> {
    return { packets: 0, missing: [], present: 0, health: 'archive-only' }
  }
}
