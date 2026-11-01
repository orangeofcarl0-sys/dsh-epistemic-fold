/**
 * R31-C3/C6/C4: the v4 journal is prepared packets + immutable receipts,
 * ordered by verified commit seq.
 *
 * @module tests/semantic-journal-v4
 */

import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeTemp } from '../eval/tmp.ts'
import {
  FileSemanticJournal,
  isSemanticPacket,
  packetStatusOf,
} from '../src/semantic/journal.ts'
import {
  LEGACY_SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_SCHEMA_VERSION,
} from '../src/semantic/types.ts'
import type { HistoricalFoldProof } from '../src/semantic/proof.ts'
import type { SemanticPacket, SemanticReceipt } from '../src/semantic/types.ts'

const sessionId = SessionId('journal-v4')

function packet(id: string, options: { readonly stagedAtSeq?: number } = {}): SemanticPacket {
  return {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    packetId: id,
    sessionId,
    checkpointId: `cp-${id}`,
    mode: 'active',
    authority: 'journal',
    status: 'staged',
    spanDigest: 'span',
    foldedSeqs: [1, 2],
    createdAt: 999,
    stagedAtSeq: options.stagedAtSeq ?? 10,
    bodyDigest: `body-${id}`,
    sourceDigest: 'source',
    ops: [{ op: 'retire', anchorId: `anchor-${id}` }],
    handoff: '',
    deltaParse: 'absent',
    proposed: [],
    accepted: [],
    refused: [],
  }
}

function proof(commitOrder: number): HistoricalFoldProof {
  return {
    proofVersion: 1,
    sessionId: String(sessionId),
    checkpointId: `cp-${commitOrder}`,
    compactionId: `compaction-${commitOrder}`,
    startSeq: commitOrder - 2,
    summarySeq: commitOrder - 1,
    replacementSeq: commitOrder,
    shadowedSeqs: [1, 2],
    spanDigest: 'span',
    sourceDigest: 'source',
    bodyDigest: `body-${commitOrder}`,
    summaryDigest: 'summary',
    commitOrder,
    unclosed: false,
  }
}

function receipt(packetId: string, order: number): SemanticReceipt {
  return {
    kind: 'receipt',
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    packetId,
    sessionId,
    checkpointId: `cp-${packetId}`,
    outcome: 'committed',
    proof: proof(order),
    opsDigest: 'ops',
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
      .rejects.toThrow(/immutable/u)
  })

  it('refuses to journal a packet that already carries a decision', async () => {
    const journal = new FileSemanticJournal(await makeTemp('ef-journal-'))
    await expect(journal.write({ ...packet('p1'), status: 'activated' }))
      .rejects.toThrow(/prepared packet is staged/u)
  })

  it('refuses a receipt for a packet that does not exist', async () => {
    const journal = new FileSemanticJournal(await makeTemp('ef-journal-'))
    await expect(journal.writeReceipt(receipt('missing', 10)))
      .rejects.toThrow(/no prepared packet/u)
  })

  it('accepts an identical receipt twice and refuses a different decision', async () => {
    const root = await makeTemp('ef-journal-')
    const journal = new FileSemanticJournal(root)
    await journal.write(packet('p1'))
    const decision = receipt('p1', 10)
    await journal.writeReceipt(decision)
    await journal.writeReceipt(decision)
    await expect(journal.writeReceipt({ ...decision, outcome: 'aborted' }))
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
    await journal.writeReceipt({ ...receipt('later', 50), decidedAt: 1 })
    await journal.writeReceipt({ ...receipt('earlier', 20), decidedAt: 999_999 })
    const read = await journal.list(sessionId)
    expect(read.packets.map(entry => entry.packetId)).toEqual(['earlier', 'later'])
  })

  it('sorts a receipt-less packet after every committed one', async () => {
    const journal = new FileSemanticJournal(await makeTemp('ef-journal-'))
    await journal.write(packet('staged', { stagedAtSeq: 1 }))
    await journal.write(packet('committed', { stagedAtSeq: 999 }))
    await journal.writeReceipt(receipt('committed', 50))
    const read = await journal.list(sessionId)
    expect(read.packets.map(entry => entry.packetId)).toEqual(['committed', 'staged'])
  })
})

describe('R31-C7: legacy files are readable but never applied directly', () => {
  it('returns schema-3 packets separately and does not misread them as v4', async () => {
    const root = await makeTemp('ef-journal-')
    const dir = join(root, String(sessionId))
    await mkdir(dir, { recursive: true })
    const legacy = {
      ...packet('legacy'),
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
    await journal.write(packet('p1'))
    const dir = join(root, String(sessionId))
    const path = join(dir, 'p1.receipt.json')
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
