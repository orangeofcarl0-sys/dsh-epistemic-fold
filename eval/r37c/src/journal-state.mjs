/**
 * Read-only journal state reconstruction for the R37-C audit.
 *
 * R37-B persisted packets and receipts but not the session log, so the full
 * `validateSemanticCommit` proof cannot be re-run from the archive. This module
 * therefore checks every proof field that IS present in the archive:
 *
 *   - the packet id is the v4 identity of its body
 *   - `spanDigest` hashes `foldedSeqs`
 *   - `receipt.opsDigest` hashes the packet's operations
 *   - receipt packet/session/checkpoint ids agree
 *   - receipt proof body/source/span/commitOrder agree
 *   - only a `committed` receipt contributes anchors
 *
 * The result is labelled `journal-proof`, not `ValidatedSemanticCommit`: the
 * historical fold itself cannot be re-proven without the session log.
 *
 * @module eval/r37c/src/journal-state
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash } from '../../../lib/checkpoint/hash.js'
import { opsDigestOf, packetIdOf } from '../../../lib/semantic/ops.js'

function stateKeyText(key) {
  if (key === undefined || key === null) return null
  return `${key.namespace}/${key.entity}/${key.property}`
}

function unwrap(value) {
  if (value?.kind === 'packet' && value.packet !== undefined) return value.packet
  if (value?.kind === 'receipt-file' && value.receipt !== undefined) return value.receipt
  return value
}

async function readOptional(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function verifyPacket(packet, receipt) {
  const errors = []
  if (packet?.schemaVersion !== 4) errors.push('packet-schema')
  if (packet?.packetId !== packetIdOf({
    sessionId: packet?.sessionId,
    checkpointId: packet?.checkpointId,
    foldedSeqs: packet?.foldedSeqs,
    bodyDigest: packet?.bodyDigest,
  })) errors.push('packet-id')
  if (canonicalHash([...(packet?.foldedSeqs ?? [])]) !== packet?.spanDigest) errors.push('packet-span')
  if (receipt === null || receipt === undefined) {
    errors.push('receipt-missing')
    return errors
  }
  if (receipt.outcome !== 'committed') errors.push(`receipt-${receipt.outcome ?? 'unknown'}`)
  if (receipt.packetId !== packet?.packetId) errors.push('receipt-packet-binding')
  if (receipt.sessionId !== packet?.sessionId) errors.push('receipt-session-binding')
  if (receipt.checkpointId !== packet?.checkpointId) errors.push('receipt-checkpoint-binding')
  if (receipt.opsDigest !== opsDigestOf(packet)) errors.push('ops-digest')
  const proof = receipt.proof
  if (proof === undefined || proof === null) {
    errors.push('proof-missing')
  } else {
    if (proof.sessionId !== packet?.sessionId) errors.push('proof-session')
    if (proof.checkpointId !== packet?.checkpointId) errors.push('proof-checkpoint')
    if (proof.spanDigest !== packet?.spanDigest) errors.push('proof-span')
    if (proof.sourceDigest !== packet?.sourceDigest) errors.push('proof-source')
    if (proof.bodyDigest !== packet?.bodyDigest) errors.push('proof-body')
    if (!Number.isInteger(proof.commitOrder)) errors.push('proof-commit-order')
  }
  return errors
}

function applyOps(anchors, ops) {
  for (const op of ops ?? []) {
    if (op.op === 'declare' && op.anchor !== undefined) {
      const key = stateKeyText(op.anchor.stateKey) ?? `id:${op.anchor.id}`
      anchors.set(key, { ...op.anchor })
    } else if (op.op === 'transition' && typeof op.anchorId === 'string') {
      for (const [key, anchor] of anchors) {
        if (anchor.id !== op.anchorId) continue
        anchors.set(key, {
          ...anchor,
          ...(op.failureState === undefined ? {} : { failureState: op.failureState }),
          ...(op.failureState === 'verified' ? { lifecycle: 'retired' } : {}),
        })
      }
    } else if (op.op === 'retire' && typeof op.anchorId === 'string') {
      for (const [key, anchor] of anchors) {
        if (anchor.id === op.anchorId) anchors.delete(key)
      }
    }
  }
}

/**
 * Reconstruct the visible anchor set from one run's journal directory.
 *
 * @param {string} journalRoot - the `journal/` directory of one run.
 * @returns {Promise<object>} proof status, anchors, packet/receipt counts.
 */
export async function readJournalState(journalRoot) {
  let sessions
  try {
    sessions = (await readdir(journalRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return {
      journalFound: false,
      packets: 0,
      receipts: 0,
      committedPackets: 0,
      proofValid: null,
      anchors: [],
      errors: [],
      unavailable: 'no-journal',
    }
  }
  const records = []
  const errors = []
  for (const sessionId of sessions) {
    const directory = join(journalRoot, sessionId)
    const files = (await readdir(directory)).filter(name => name.endsWith('.json') && !name.endsWith('.receipt.json')).sort()
    for (const file of files) {
      const packet = unwrap(await readOptional(join(directory, file)))
      const receipt = unwrap(await readOptional(join(directory, `${file.slice(0, -5)}.receipt.json`)))
      const packetErrors = verifyPacket(packet, receipt)
      if (packetErrors.length > 0) {
        for (const error of packetErrors) errors.push({ packetId: packet?.packetId ?? file, error })
      }
      records.push({ packet, receipt, packetErrors })
    }
  }
  const committed = records
    .filter(record => record.packetErrors.length === 0 && record.receipt?.outcome === 'committed')
    .sort((left, right) => {
      const order = (left.receipt?.proof?.commitOrder ?? 0) - (right.receipt?.proof?.commitOrder ?? 0)
      return order === 0 ? String(left.packet?.packetId).localeCompare(String(right.packet?.packetId)) : order
    })
  const anchors = new Map()
  for (const record of committed) applyOps(anchors, record.packet?.ops)
  const receiptCount = records.filter(record => record.receipt !== null && record.receipt !== undefined).length
  return {
    journalFound: true,
    sessions,
    packets: records.length,
    receipts: receiptCount,
    committedPackets: committed.length,
    proofValid: committed.length > 0 && errors.length === 0,
    anchors: [...anchors.values()],
    errors,
    unavailable: null,
  }
}
