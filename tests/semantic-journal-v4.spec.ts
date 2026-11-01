/**
 * R31-C3/C6/C4: the v4 journal is prepared packets + immutable receipts,
 * ordered by verified commit seq.
 *
 * R32 adds a native v4 identity: a packet file whose id is not the hash of its
 * own body/span is not admitted. The fixtures therefore derive real ids instead
 * of inventing friendly ones; that is the contract the journal now enforces.
 *
 * @module tests/semantic-journal-v4
 */

import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeTemp } from '../eval/tmp.ts'
import { canonicalHash } from '../src/checkpoint/hash.ts'
import {
  FileSemanticJournal,
  isSemanticPacket,
  opsDigestOf,
  packetIdOf,
  packetStatusOf,
} from '../src/semantic/journal.ts'
import {
  LEGACY_SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_SCHEMA_VERSION,
} from '../src/semantic/types.ts'
import type { HistoricalFoldProof } from '../src/semantic/proof.ts'
import type { SemanticPacket, SemanticReceipt } from '../src/semantic/types.ts'

const sessionId = SessionId('journal-v4')
const FOLDED = [1, 2]

function packet(name: string, options: { readonly stagedAtSeq?: number } = {}): SemanticPacket {
  const checkpointId = `cp-${name}`
  const bodyDigest = `body-${name}`
  return {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    packetId: packetIdOf({ sessionId, checkpointId, foldedSeqs: FOLDED, bodyDigest }),
    sessionId,
    checkpointId,
    mode: 'active',
    authority: 'journal',
    status: 'staged',
    spanDigest: canonicalHash(FOLDED),
    foldedSeqs: [...FOLDED],
    createdAt: 999,
    stagedAtSeq: options.stagedAtSeq ?? 10,
    bodyDigest,
    sourceDigest: 'source',
    ops: [{ op: 'retire', anchorId: `anchor-${name}` }],
    handoff: '',
    deltaParse: 'absent',
    proposed: [],
    accepted: [],
    refused: [],
  }
}

function proofFor(packet: SemanticPacket, commitOrder: number): HistoricalFoldProof {
  return {
    proofVersion: 1,
    sessionId: String(sessionId),
    checkpointId: packet.checkpointId,
    compactionId: `compaction-${commitOrder}`,
    startSeq: commitOrder - 2,
    summarySeq: commitOrder - 1,
    replacementSeq: commitOrder,
    shadowedSeqs: [...packet.foldedSeqs],
    spanDigest: packet.spanDigest,
    sourceDigest: packet.sourceDigest ?? 'source',
    bodyDigest: packet.bodyDigest,
    summaryDigest: 'summary',
    commitOrder,
    unclosed: false,
  }
}

function receipt(packet: SemanticPacket, order: number): SemanticReceipt {
  return {
    kind: 'receipt',
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    packetId: packet.packetId,
    sessionId,
    checkpointId: packet.checkpointId,
    outcome: 'committed',
    proof: proofFor(packet, order),
    opsDigest: opsDigestOf(packet),
    decidedAt: 1,
  }
}

describe('R31-C3: prepared packets and receipts are immutable', () => {
  it('accepts an identical packet twice and refuses a different one', async () => {
    const root = await makeTemp('ef-journal-')
    const journal = new FileSemanticJournal(root)
    const first = packet('p1')
    await journal.write(first)
    await journal.write(first)
    await expect(journal.write({ ...first, bodyDigest: 'changed' }))
      .rejects.toThrow(/immutable|identity/u)
  })

  it('refuses a packet whose id is not its v4 identity', async () => {
    const journal = new FileSemanticJournal(await makeTemp('ef-journal-'))
    await expect(journal.write({ ...packet('p1'), packetId: 'friendly-name' }))
      .rejects.toThrow(/identity/u)
  })

  it('refuses to journal a packet that already carries a decision', async () => {
    const journal = new FileSemanticJournal(await makeTemp('ef-journal-'))
    await expect(journal.write({ ...packet('p1'), status: 'activated' }))
      .rejects.toThrow(/prepared packet is staged/u)
  })

  it('refuses a receipt for a packet that does not exist', async () => {
    const journal = new FileSemanticJournal(await makeTemp('ef-journal-'))
    await expect(journal.writeReceipt(receipt(packet('missing'), 10)))
      .rejects.toThrow(/no prepared packet/u)
  })

  it('refuses a receipt that commits different operations than its packet', async () => {
    const journal = new FileSemanticJournal(await makeTemp('ef-journal-'))
    const target = packet('p1')
    await journal.write(target)
    await expect(journal.writeReceipt({ ...receipt(target, 10), opsDigest: 'not-the-ops' }))
      .rejects.toThrow(/opsDigest/u)
  })

  it('accepts an identical receipt twice and refuses a different decision', async () => {
    const root = await makeTemp('ef-journal-')
    const journal = new FileSemanticJournal(root)
    const target = packet('p1')
    await journal.write(target)
    const decision = receipt(target, 10)
    await journal.writeReceipt(decision)
    await journal.writeReceipt(decision)
    // A schema-valid but DIFFERENT decision is still refused by the immutable
    // writer; the outcome swap alone would be rejected earlier as malformed.
    await expect(journal.writeReceipt({ ...decision, decidedAt: 2 }))
      .rejects.toThrow(/immutable/u)

    const read = await journal.list(sessionId)
    expect(read.receipts.size).toBe(1)
    expect(packetStatusOf(undefined)).toBe('staged')
    expect(packetStatusOf(decision)).toBe('activated')
  })
})

describe('R31-C4: replay order is commit order, not wall time', () => {
  it('orders committed packets by proof.commitOrder regardless of staging time', async () => {
    const root = await makeTemp('ef-journal-')
    const journal = new FileSemanticJournal(root)
    // `later` was staged FIRST and has a LATER wall time in every field a v3
    // journal sorted on; its commit seq is what must order it second.
    const later = { ...packet('later', { stagedAtSeq: 5 }), createdAt: 1 }
    const earlier = { ...packet('earlier', { stagedAtSeq: 99 }), createdAt: 100_000 }
    await journal.write(later)
    await journal.write(earlier)
    await journal.writeReceipt({ ...receipt(later, 50), decidedAt: 1 })
    await journal.writeReceipt({ ...receipt(earlier, 20), decidedAt: 999_999 })
    const read = await journal.list(sessionId)
    expect(read.packets.map(entry => entry.packetId)).toEqual([earlier.packetId, later.packetId])
  })

  it('sorts a receipt-less packet after every committed one', async () => {
    const journal = new FileSemanticJournal(await makeTemp('ef-journal-'))
    const staged = packet('staged', { stagedAtSeq: 1 })
    const committed = packet('committed', { stagedAtSeq: 999 })
    await journal.write(staged)
    await journal.write(committed)
    await journal.writeReceipt(receipt(committed, 50))
    const read = await journal.list(sessionId)
    expect(read.packets.map(entry => entry.packetId)).toEqual([committed.packetId, staged.packetId])
  })
})

describe('R31-C7: legacy files are readable but never applied directly', () => {
  it('returns schema-3 packets separately and does not misread them as v4', async () => {
    const root = await makeTemp('ef-journal-')
    const dir = join(root, String(sessionId))
    await mkdir(dir, { recursive: true })
    const legacy = {
      ...packet('legacy'),
      // A v3 id is not a v4 identity; the migration re-derives it.
      packetId: 'legacy',
      schemaVersion: LEGACY_SEMANTIC_SCHEMA_VERSION,
      status: 'activated',
    }
    delete (legacy as { sourceDigest?: string }).sourceDigest
    await writeFile(join(dir, 'legacy.json'), JSON.stringify({
      kind: 'packet',
      schemaVersion: LEGACY_SEMANTIC_SCHEMA_VERSION,
      packet: legacy,
    }), 'utf8')

    const read = await new FileSemanticJournal(root).list(sessionId)
    expect(read.packets).toHaveLength(0)
    expect(read.legacy.map(entry => entry.packetId)).toEqual(['legacy'])
    expect(read.invalid).toHaveLength(0)
    expect(isSemanticPacket(read.legacy[0])).toBe(false)
  })

  it('reports a corrupt receipt instead of silently ignoring it', async () => {
    const root = await makeTemp('ef-journal-')
    const journal = new FileSemanticJournal(root)
    const target = packet('p1')
    await journal.write(target)
    const dir = join(root, String(sessionId))
    const path = join(dir, `${target.packetId}.receipt.json`)
    await writeFile(path, JSON.stringify({
      kind: 'receipt-file',
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      receipt: { kind: 'receipt', outcome: 'committed' },
    }), 'utf8')
    const read = await journal.list(sessionId)
    expect(read.receipts.size).toBe(0)
    expect(read.invalid).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toContain('committed')
  })
})
