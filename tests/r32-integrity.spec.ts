/**
 * R32-A: Packet–Receipt–Proof–Ops referential integrity.
 *
 * Each row of a journal is four facts. These tests make one of them disagree
 * with the others and assert that the disagreement is reported and cannot
 * become state.
 *
 * @module tests/r32-integrity
 */

import { describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeTemp } from '../eval/tmp.ts'
import { FileSemanticJournal } from '../src/semantic/journal.ts'
import {
  packetIdentityProblem,
  receiptBindingProblem,
  validateSemanticCommit,
} from '../src/semantic/integrity.ts'
import { validateOps } from '../src/semantic/ops.ts'
import { SEMANTIC_SCHEMA_VERSION } from '../src/semantic/types.ts'
import type { SemanticPacket, SemanticReceipt } from '../src/semantic/types.ts'
import { committedFixture } from './r32-fixtures.ts'

function cloneReceipt(receipt: SemanticReceipt): SemanticReceipt {
  return structuredClone(receipt)
}

describe('R32-A: Packet/Receipt/Proof/Ops binding', () => {
  it('accepts a packet whose receipt commits exactly its operations', () => {
    const fixture = committedFixture()
    const result = validateSemanticCommit({
      session: fixture.session,
      packet: fixture.packet,
      receipt: fixture.receipt,
    })
    expect(result.status).toBe('valid')
    if (result.status !== 'valid') return
    expect(result.missingReceipt).toBe(false)
    expect(result.commit.packetId).toBe(fixture.packet.packetId)
    expect(result.commit.commitOrder).toBe(fixture.proof.commitOrder)
  })

  it('admits a committed packet whose receipt is missing (cross-store crash)', () => {
    const fixture = committedFixture()
    const result = validateSemanticCommit({ session: fixture.session, packet: fixture.packet })
    expect(result.status).toBe('valid')
    if (result.status !== 'valid') return
    expect(result.missingReceipt).toBe(true)
  })

  it('rejects a packet modified after its receipt: opsDigest no longer matches', async () => {
    const fixture = committedFixture()
    const journal = new FileSemanticJournal(await makeTemp('ef-r32-integrity-'))
    await journal.write(fixture.packet)
    await journal.writeReceipt(fixture.receipt)

    const path = join(journal.root, String(fixture.session.id), `${fixture.packet.packetId}.json`)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { packet: SemanticPacket }
    const modified: SemanticPacket = {
      ...parsed.packet,
      ops: [{ op: 'retire', anchorId: 'not-in-the-receipt' }],
    }
    await writeFile(path, JSON.stringify({ ...parsed, packet: modified }, null, 2), 'utf8')

    const read = await journal.list(fixture.session.id)
    expect(read.invalid.some(issue => issue.code === 'ops-digest')).toBe(true)
    expect(read.receipts.size).toBe(0)

    const result = validateSemanticCommit({
      session: fixture.session,
      packet: modified,
      receipt: fixture.receipt,
    })
    expect(result.status).toBe('conflict')
    if (result.status === 'conflict') expect(result.code).toBe('ops-digest')
  })

  it('rejects a packet id that is not the v4 identity of its body', () => {
    const fixture = committedFixture()
    const problem = packetIdentityProblem({ ...fixture.packet, packetId: 'friendly-name' })
    expect(problem?.code).toBe('packet-id')

    const result = validateSemanticCommit({
      session: fixture.session,
      packet: { ...fixture.packet, packetId: 'friendly-name' },
      receipt: fixture.receipt,
    })
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') expect(result.code).toBe('packet-id')
  })

  it('rejects a receipt bound to another session or checkpoint', () => {
    const fixture = committedFixture()
    const wrongSession: SemanticReceipt = {
      ...fixture.receipt,
      sessionId: SessionId('some-other-session'),
    }
    expect(receiptBindingProblem(fixture.packet, wrongSession)?.code).toBe('receipt-binding')
    expect(validateSemanticCommit({
      session: fixture.session,
      packet: fixture.packet,
      receipt: wrongSession,
    }).status).toBe('conflict')

    const wrongCheckpoint = { ...fixture.receipt, checkpointId: 'cp-other' }
    expect(validateSemanticCommit({
      session: fixture.session,
      packet: fixture.packet,
      receipt: wrongCheckpoint,
    }).status).toBe('conflict')
  })

  it('rejects a receipt whose proof describes a different body', () => {
    const fixture = committedFixture()
    const receipt = cloneReceipt(fixture.receipt)
    if (receipt.proof === undefined) throw new Error('fixture receipt has no proof')
    const mismatched: SemanticReceipt = {
      ...receipt,
      proof: { ...receipt.proof, bodyDigest: 'some-other-body' },
    }
    const result = validateSemanticCommit({
      session: fixture.session,
      packet: fixture.packet,
      receipt: mismatched,
    })
    expect(result.status).toBe('conflict')
    if (result.status === 'conflict') expect(result.code).toBe('proof-mismatch')
  })

  it('reports an orphan receipt and refuses to count it as committed', async () => {
    const fixture = committedFixture()
    const journal = new FileSemanticJournal(await makeTemp('ef-r32-integrity-'))
    await journal.write(fixture.packet)
    await journal.writeReceipt(fixture.receipt)
    await rm(join(journal.root, String(fixture.session.id), `${fixture.packet.packetId}.json`))

    const read = await journal.list(fixture.session.id)
    expect(read.orphans).toHaveLength(1)
    expect(read.receipts.size).toBe(0)
    expect(read.invalid.some(issue => issue.code === 'orphan-receipt')).toBe(true)
  })

  it('reports a receipt file stem that disagrees with its payload id', async () => {
    const fixture = committedFixture()
    const journal = new FileSemanticJournal(await makeTemp('ef-r32-integrity-'))
    await journal.write(fixture.packet)
    const dir = join(journal.root, String(fixture.session.id))
    await mkdir(dir, { recursive: true })
    const wrongPath = join(dir, 'not-the-packet-id.receipt.json')
    await writeFile(wrongPath, JSON.stringify({
      kind: 'receipt-file',
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      receipt: fixture.receipt,
    }), 'utf8')

    const read = await journal.list(fixture.session.id)
    expect(read.invalid.some(issue => issue.code === 'file-stem')).toBe(true)
    expect(read.receipts.size).toBe(0)
  })

  it('reports a packet file stem that disagrees with its payload id', async () => {
    const fixture = committedFixture()
    const journal = new FileSemanticJournal(await makeTemp('ef-r32-integrity-'))
    const dir = join(journal.root, String(fixture.session.id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'wrong-stem.json'), JSON.stringify({
      kind: 'packet',
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      packet: fixture.packet,
    }), 'utf8')

    const read = await journal.list(fixture.session.id)
    expect(read.invalid.some(issue => issue.code === 'file-stem')).toBe(true)
    expect(read.packets).toHaveLength(0)
  })
})

describe('R32-A: runtime operation schema', () => {
  it('refuses a null operation', () => {
    const result = validateOps([null])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.index).toBe(0)
  })

  it('refuses malformed declare, transition, and retire operations', () => {
    const cases: readonly unknown[] = [
      // declare without a state key
      { op: 'declare', anchor: { id: 'a', kind: 'constraint', value: 'x', authority: 'normative', lifecycle: 'active', sourceRefs: [] } },
      // unknown lifecycle
      { op: 'declare', anchor: { id: 'a', kind: 'constraint', stateKey: { namespace: 'semantic', entity: 'constraint', property: 'x' }, value: 'x', authority: 'normative', lifecycle: 'zombie', sourceRefs: [] } },
      // transition without a target
      { op: 'transition', failureState: 'verified', evidenceRefs: [{ seq: 1 }] },
      // verified transition with no evidence
      { op: 'transition', anchorId: 'a', failureState: 'verified' },
      // retire without an id
      { op: 'retire' },
      // unknown operation
      { op: 'delete', anchorId: 'a' },
    ]
    for (const candidate of cases) {
      expect(validateOps([candidate]).ok, JSON.stringify(candidate)).toBe(false)
    }
  })

  it('accepts the three legal operation shapes', () => {
    const result = validateOps([
      {
        op: 'declare',
        anchor: {
          id: 'a',
          kind: 'constraint',
          stateKey: { namespace: 'semantic', entity: 'constraint', property: 'timeout' },
          value: '30s',
          authority: 'normative',
          lifecycle: 'active',
          sourceRefs: [{ seq: 1 }],
        },
      },
      { op: 'transition', anchorId: 'a', failureState: 'verified', evidenceRefs: [{ seq: 2 }] },
      { op: 'retire', anchorId: 'b' },
    ])
    expect(result.ok).toBe(true)
  })
})
