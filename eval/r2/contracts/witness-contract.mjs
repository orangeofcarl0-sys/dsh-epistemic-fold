#!/usr/bin/env node
/**
 * EF-R2 WP1 — the Compaction Witness contract.
 *
 * Seven scenarios decide whether the witness can tell attempt from commit from
 * delivery. Each case builds REAL bundle files with `FileBundleStore` and a
 * synthetic event log, so the test exercises the same codec and commit
 * records the campaigns wrote.
 *
 *   node eval/r2/contracts/witness-contract.mjs
 *
 * @module eval/r2/contracts/witness-contract
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBundleStore } from '../../../lib/checkpoint/bundle-store.js'
import { canonicalHash } from '../../../lib/checkpoint/hash.js'
import { encodeCheckpointMarker } from '../../../lib/checkpoint/checkpoint-marker.js'
import {
  buildWitnessesFromEvents,
  buildWitnessesFromRun,
  summarizeWitnesses,
} from '../../e2e/src/witness.mjs'

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const baseTime = Date.parse('2026-11-10T10:00:00.000Z')

let failures = 0
let checks = 0
function check(name, condition, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`  PASS ${name}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}\n`)
}

function marker(mode, checkpointId) {
  return encodeCheckpointMarker({ mode, checkpointId })
}

function archivedMessages(label) {
  return [
    { role: 'user', content: [{ type: 'text', text: `${label} archived instruction` }] },
    { role: 'assistant', content: [{ type: 'text', text: `${label} archived answer` }] },
  ]
}

async function writeBundle(store, sessionId, {
  checkpointId,
  mode = 'leaf',
  text,
  createdAt,
  messages,
  semantic,
}) {
  const bundle = {
    format: 'ef-checkpoint',
    formatVersion: 1,
    checkpointId,
    sessionId,
    createdAt,
    mode,
    source: {
      orderedSurfaceSeqs: [4, 23],
      sourceDigest: canonicalHash({ seed: 'witness-contract', seqs: [4, 23] }),
    },
    archive: {
      messageCount: messages.length,
      shadowedMessages: messages,
      logicalHash: canonicalHash(messages),
    },
    rendered: { text, digest: canonicalHash(text) },
    ...(semantic === undefined ? {} : { semantic: { text: semantic } }),
  }
  await store.write(bundle)
}

async function writeCommit(store, sessionId, {
  checkpointId,
  compactionId,
  mode = 'leaf',
  startSeq,
  summarySeq,
  endSeq,
  committedAt,
  shadowedSeqs = [4, 7],
}) {
  await store.recordCommit({
    checkpointId,
    sessionId,
    mode,
    compactionId,
    shadowedSeqs,
    startSeq,
    summarySeq,
    endSeq,
    committedAt,
  })
}

function eventLog({
  compactionId,
  checkpointText,
  startSeq,
  summarySeq,
  replacementSeq,
  endSeq,
  shadowedSeqs = [4, 7],
  shadowedTokenCount = 200,
  startTime = baseTime,
  error,
}) {
  const events = [{
    type: 'compaction/start',
    seq: startSeq,
    time: startTime,
    data: { compactionId },
  }]
  if (checkpointText !== undefined) {
    events.push({
      type: 'compaction/summary',
      seq: summarySeq,
      time: startTime + 10,
      data: {
        compactionId,
        summary: [{ type: 'text', text: checkpointText }],
        shadowedRange: { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] },
        shadowedSeqs,
        shadowedTokenCount,
        provider: 'ef-e2e',
        model: 'test',
        maxTokens: 16_384,
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    })
  }
  if (replacementSeq !== undefined) {
    events.push({
      type: 'user/message',
      seq: replacementSeq,
      time: startTime + 20,
      surfaceOp: {
        op: 'replace',
        startSeq: shadowedSeqs[0],
        endSeq: shadowedSeqs[shadowedSeqs.length - 1],
      },
      sourceEventSeqs: [startSeq, summarySeq, ...shadowedSeqs],
      data: {
        message: {
          role: 'user',
          content: [{ type: 'text', text: checkpointText }],
          source: { kind: 'compact-checkpoint', compactionId },
        },
      },
    })
  }
  events.push({
    type: 'compaction/end',
    seq: endSeq,
    time: startTime + 30,
    data: { compactionId, ...(error === undefined ? {} : { error }) },
  })
  return events
}

function primaryRequest(index, text, at) {
  return {
    index,
    purpose: 'primary',
    at: new Date(at).toISOString(),
    maxTokens: 1024,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text }],
      digest: sha256(text),
      preview: text.slice(0, 400),
      truncated: false,
    }],
    usage: { inputTokens: 10, outputTokens: 5 },
    finish: { kind: 'stop' },
    durationMs: 1,
  }
}

function auxiliaryRequest(index, purpose, at, finish = { kind: 'stop' }, maxTokens = 16_384) {
  return {
    index,
    purpose,
    at: new Date(at).toISOString(),
    maxTokens,
    messages: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    finish,
    durationMs: 1,
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'ef-r2-witness-'))
  try {
    return await fn(root, join(root, 'bundles'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function main() {
  process.stdout.write('witness contract\n')

  // 1. Economic refusal: no attempt at all, so no exposure.
  await withRoot(async (_root, bundles) => {
    const out = await buildWitnessesFromEvents({
      sessionId: 'sess-economic',
      events: [],
      bundleRoot: bundles,
      requests: [primaryRequest(1, 'task', baseTime + 1000)],
      taskPrompt: 'task',
      arm: 'E1',
    })
    const summary = summarizeWitnesses(out.witnesses)
    check('economic refusal: zero attempts', summary.attempts === 0)
    check('economic refusal: zero commits', summary.committed === 0)
  })

  // 2. The rationale call fails; the engine publishes the fallback body and
  //    Basic commits it. Attempted is true, landed is false, commit is real.
  await withRoot(async (_root, bundles) => {
    const sessionId = 'sess-rationale-fail'
    const checkpointId = randomUUID()
    const compactionId = randomUUID()
    const text = `${marker('leaf', checkpointId)}\nFolded 2 message(s); semantic summary unavailable.`
    const store = new FileBundleStore(bundles)
    await writeBundle(store, sessionId, {
      checkpointId, text, createdAt: baseTime, messages: archivedMessages('fallback'),
    })
    await writeCommit(store, sessionId, {
      checkpointId, compactionId, startSeq: 30, summarySeq: 31, endSeq: 33, committedAt: baseTime + 40,
    })
    const events = eventLog({
      compactionId, checkpointText: text, startSeq: 30, summarySeq: 31,
      replacementSeq: 32, endSeq: 33,
    })
    const out = await buildWitnessesFromEvents({
      sessionId,
      events,
      bundleRoot: bundles,
      requests: [
        auxiliaryRequest(1, 'rationale', baseTime + 15, {
          kind: 'error',
          failure: { message: 'provider down', code: 'PROVIDER' },
        }),
        primaryRequest(2, text, baseTime + 1000),
      ],
      taskPrompt: 'task',
      arm: 'E1',
    })
    const witness = out.witnesses[0]
    check('rationale failure: committed with fallback body', witness.status === 'committed')
    check('rationale failure: call attempted', witness.rationale.attempted === true)
    check('rationale failure: text did not land', witness.rationale.landed === false)
    check('rationale failure: finish recorded', witness.rationale.finish?.kind === 'error')
    check('rationale failure: delivery verified', witness.delivery?.checkpointDelivered === true)
  })

  // 3. Bundle durable, surface not replaced: the shrink check refused it.
  await withRoot(async (_root, bundles) => {
    const sessionId = 'sess-shrink'
    const checkpointId = randomUUID()
    const compactionId = randomUUID()
    const text = `${marker('leaf', checkpointId)}\n${'rationale '.repeat(80)}`
    const store = new FileBundleStore(bundles)
    await writeBundle(store, sessionId, {
      checkpointId, text, createdAt: baseTime, messages: archivedMessages('tiny'),
      semantic: 'rationale '.repeat(80),
    })
    const events = eventLog({
      compactionId, checkpointText: text, startSeq: 40, summarySeq: 41, endSeq: 42,
      shadowedTokenCount: 62,
      error: 'summary is not smaller than the shadowed content (333 estimated framed tokens >= 62)',
    })
    const out = await buildWitnessesFromEvents({
      sessionId,
      events,
      bundleRoot: bundles,
      requests: [
        auxiliaryRequest(1, 'rationale', baseTime + 15),
        primaryRequest(2, 'raw history retained', baseTime + 1000),
      ],
      taskPrompt: 'task',
      arm: 'E1',
    })
    const witness = out.witnesses[0]
    check('shrink refusal: status refused', witness.status === 'refused')
    check('shrink refusal: classified', witness.reason === 'shrink-refusal')
    check('shrink refusal: bundle verified', witness.archive.fileStatus === 'verified')
    check('shrink refusal: no surface replacement', witness.surfaceReplacementVerified === false)
    check('shrink refusal: no delivery claim', witness.delivery === null)
    check('shrink refusal: rationale landed but undelivered', witness.rationale.landed === true)
  })

  // 4. Two folds; the first checkpoint leaves the surface. Both still commit.
  await withRoot(async (_root, bundles) => {
    const sessionId = 'sess-multifold'
    const store = new FileBundleStore(bundles)
    const firstId = randomUUID()
    const secondId = randomUUID()
    const firstCompaction = randomUUID()
    const secondCompaction = randomUUID()
    const firstText = `${marker('leaf', firstId)}\nfirst body`
    const secondText = `${marker('leaf', secondId)}\nsecond body`
    await writeBundle(store, sessionId, {
      checkpointId: firstId, text: firstText, createdAt: baseTime, messages: archivedMessages('first'),
    })
    await writeCommit(store, sessionId, {
      checkpointId: firstId, compactionId: firstCompaction,
      startSeq: 30, summarySeq: 31, endSeq: 33, committedAt: baseTime + 40,
    })
    await writeBundle(store, sessionId, {
      checkpointId: secondId, text: secondText, createdAt: baseTime + 100,
      messages: archivedMessages('second'),
    })
    await writeCommit(store, sessionId, {
      checkpointId: secondId, compactionId: secondCompaction,
      startSeq: 50, summarySeq: 51, endSeq: 53, committedAt: baseTime + 140,
    })
    const events = [
      ...eventLog({
        compactionId: firstCompaction, checkpointText: firstText, startSeq: 30, summarySeq: 31,
        replacementSeq: 32, endSeq: 33,
      }),
      ...eventLog({
        compactionId: secondCompaction, checkpointText: secondText, startSeq: 50, summarySeq: 51,
        replacementSeq: 52, endSeq: 53, startTime: baseTime + 100,
      }),
    ]
    const out = await buildWitnessesFromEvents({
      sessionId,
      events,
      bundleRoot: bundles,
      requests: [
        auxiliaryRequest(1, 'rationale', baseTime + 15),
        primaryRequest(2, firstText, baseTime + 1000),
        auxiliaryRequest(3, 'rationale', baseTime + 115),
        primaryRequest(4, secondText, baseTime + 2000),
      ],
      taskPrompt: 'task',
      arm: 'E1',
    })
    const summary = summarizeWitnesses(out.witnesses)
    check('multi-fold: both attempts committed', summary.committed === 2)
    check('multi-fold: both verified', summary.verified === 2)
    check('multi-fold: first body delivered while resident', out.witnesses[0].delivery?.checkpointDelivered === true)
    check('multi-fold: second body delivered later', out.witnesses[1].delivery?.checkpointDelivered === true)
    check('multi-fold: first is not "unverifiable" because it left the surface', out.witnesses[0].status === 'committed')
  })

  // 5. Fold succeeded after the last primary request: no attribution.
  await withRoot(async (_root, bundles) => {
    const sessionId = 'sess-no-followup'
    const checkpointId = randomUUID()
    const compactionId = randomUUID()
    const text = `${marker('leaf', checkpointId)}\nlate body`
    const store = new FileBundleStore(bundles)
    await writeBundle(store, sessionId, {
      checkpointId, text, createdAt: baseTime, messages: archivedMessages('late'),
    })
    await writeCommit(store, sessionId, {
      checkpointId, compactionId, startSeq: 60, summarySeq: 61, endSeq: 63, committedAt: baseTime + 40,
    })
    const out = await buildWitnessesFromEvents({
      sessionId,
      events: eventLog({
        compactionId, checkpointText: text, startSeq: 60, summarySeq: 61,
        replacementSeq: 62, endSeq: 63,
      }),
      bundleRoot: bundles,
      requests: [primaryRequest(1, 'earlier', baseTime - 1000)],
      taskPrompt: 'task',
      arm: 'E1',
    })
    const witness = out.witnesses[0]
    check('no follow-up: committed', witness.status === 'committed')
    check('no follow-up: delivery is empty, not true', witness.delivery?.firstPrimaryRequestAfterCommit === null)
    check('no follow-up: not counted as delivered', summarizeWitnesses(out.witnesses).committedAndDelivered === 0)
    check('no follow-up: counted as no-following-request', summarizeWitnesses(out.witnesses).noFollowingRequest === 1)
  })

  // 6. Root / leaf / basic: each uses its own commit evidence.
  await withRoot(async (_root, bundles) => {
    const sessionId = 'sess-modes'
    const store = new FileBundleStore(bundles)
    const leafId = randomUUID()
    const rootId = randomUUID()
    const leafCompaction = randomUUID()
    const rootCompaction = randomUUID()
    const leafText = `${marker('leaf', leafId)}\nleaf`
    const rootText = `${marker('root', rootId)}\nroot`
    await writeBundle(store, sessionId, {
      checkpointId: leafId, mode: 'leaf', text: leafText, createdAt: baseTime, messages: archivedMessages('leaf'),
    })
    await writeCommit(store, sessionId, {
      checkpointId: leafId, compactionId: leafCompaction, mode: 'leaf',
      startSeq: 70, summarySeq: 71, endSeq: 73, committedAt: baseTime + 40,
    })
    await writeBundle(store, sessionId, {
      checkpointId: rootId, mode: 'root', text: rootText, createdAt: baseTime + 100,
      messages: archivedMessages('root'),
    })
    await writeCommit(store, sessionId, {
      checkpointId: rootId, compactionId: rootCompaction, mode: 'root',
      startSeq: 80, summarySeq: 81, endSeq: 83, committedAt: baseTime + 140,
    })
    const events = [
      ...eventLog({
        compactionId: leafCompaction, checkpointText: leafText, startSeq: 70, summarySeq: 71,
        replacementSeq: 72, endSeq: 73,
      }),
      ...eventLog({
        compactionId: rootCompaction, checkpointText: rootText, startSeq: 80, summarySeq: 81,
        replacementSeq: 82, endSeq: 83, startTime: baseTime + 100,
      }),
    ]
    const out = await buildWitnessesFromEvents({
      sessionId, events, bundleRoot: bundles, requests: [], taskPrompt: 'task', arm: 'E1',
    })
    check('modes: leaf recorded', out.witnesses[0].mode === 'leaf')
    check('modes: root recorded', out.witnesses[1].mode === 'root')

    const basic = await buildWitnessesFromRun({
      report: {
        compactions: [{ id: 'basic-1', startSeq: 5, endSeq: 9, error: null }],
        checkpoint: { text: 'basic body', mode: 'basic' },
      },
      requests: [auxiliaryRequest(1, 'summary', baseTime + 10), primaryRequest(2, 'later', baseTime + 1000)],
      fullMessages: [],
      bundleRoot: join(bundles, 'does-not-exist'),
      taskPrompt: 'task',
      arm: 'B0',
    })
    check('modes: basic is committed from the report', basic.witnesses[0].status === 'committed')
    check('modes: basic is inferred, never verified', basic.witnesses[0].evidenceLevel === 'inferred')
    check('modes: basic delivery is unverifiable', basic.witnesses[0].delivery === null)
  })

  // 7. T5: two real commits plus one refusal, not three attempts counted as folds.
  await withRoot(async (_root, bundles) => {
    const sessionId = 'sess-t5'
    const store = new FileBundleStore(bundles)
    const ids = [randomUUID(), randomUUID()]
    const compactionIds = [randomUUID(), randomUUID(), randomUUID()]
    const texts = ids.map((id, index) => `${marker('leaf', id)}\nbody ${index}`)
    for (let index = 0; index < 2; index += 1) {
      await writeBundle(store, sessionId, {
        checkpointId: ids[index], text: texts[index], createdAt: baseTime + index * 100,
        messages: archivedMessages(`t5-${index}`),
      })
      await writeCommit(store, sessionId, {
        checkpointId: ids[index], compactionId: compactionIds[index],
        startSeq: 90 + index * 20, summarySeq: 91 + index * 20, endSeq: 93 + index * 20,
        committedAt: baseTime + 40 + index * 100,
      })
    }
    const events = [
      ...eventLog({
        compactionId: compactionIds[0], checkpointText: texts[0], startSeq: 90, summarySeq: 91,
        replacementSeq: 92, endSeq: 93,
      }),
      ...eventLog({
        compactionId: compactionIds[1], checkpointText: texts[1], startSeq: 110, summarySeq: 111,
        replacementSeq: 112, endSeq: 113, startTime: baseTime + 100,
      }),
      ...eventLog({
        compactionId: compactionIds[2], checkpointText: texts[1], startSeq: 130, summarySeq: 131,
        endSeq: 133, startTime: baseTime + 200,
        error: 'summary is not smaller than the shadowed content (500 estimated framed tokens >= 120)',
      }),
    ]
    const out = await buildWitnessesFromEvents({
      sessionId, events, bundleRoot: bundles, requests: [], taskPrompt: 'task', arm: 'E1',
    })
    const summary = summarizeWitnesses(out.witnesses)
    check('T5: three attempts', summary.attempts === 3)
    check('T5: exactly two committed', summary.committed === 2)
    check('T5: one refused', summary.refused === 1)
  })

  process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
  if (failures > 0) process.exit(1)
}

main().catch(error => {
  process.stderr.write(`witness contract: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(2)
})
