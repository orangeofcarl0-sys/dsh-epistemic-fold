#!/usr/bin/env node
/**
 * EF-R2 WP5 — the mixed-origin authorization matrix.
 *
 * Reproduces the bypass against the REAL built validator/planner, records the
 * pre-fix verdict (the same `mayRetire` called with the old inputs), and shows
 * the post-fix refusal. It then exercises the public `AnchorService.declare`
 * door, which used to trust a caller-supplied source label.
 *
 * This is an artifact generator, not a replacement for the vitest suite:
 * `tests/ef-r2-mixed-origin.spec.ts` is the regression gate.
 *
 *   node eval/r2/mixed-origin-authority.mjs
 *
 * @module eval/r2/mixed-origin-authority
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { decisionOriginOf, decisionSourceOf } from '../../lib/state/authority.js'
import { mayRetire } from '../../lib/semantic/retirement.js'
import { validateDeltas } from '../../lib/semantic/validate.js'
import { applyOps, planCommit } from '../../lib/semantic/plan.js'
import { createAnchorService } from '../../lib/state/anchor-service.js'
import { emptyCurrentState } from '../../lib/state/state.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const model = text => createMessage({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model', provider: 'test', model: 'test' },
})
const decision = (quotes, statement) => ({
  kind: 'decision',
  subjectKey: 'queue',
  statement,
  status: 'claimed',
  evidence: quotes.map(quote => ({ quote })),
  supersedes: ['previous'],
})

const baseState = applyOps(emptyCurrentState(), [{
  op: 'declare',
  anchor: {
    id: 'user-queue',
    kind: 'decision',
    stateKey: { namespace: 'semantic', entity: 'decision', property: 'queue' },
    value: 'Use the in-memory queue.',
    authority: 'decision',
    sourceAuthority: 'user',
    lifecycle: 'active',
    sourceRefs: [{ seq: 1 }],
  },
}])

const messages = [
  user('Use the in-memory queue for now.'),
  model('I decided the durable outbox is better.'),
]
const validation = validateDeltas({
  foldedSeqs: [1, 2],
  messages,
  proposed: [decision([
    'Use the in-memory queue for now.',
    'I decided the durable outbox is better.',
  ], 'Use the durable outbox.')],
})
const plan = planCommit(validation.accepted, { state: baseState })

const oldSource = decisionSourceOf(['user/message', 'assistant/message'])
const oldVerdict = mayRetire({
  declaring: 'decision',
  target: 'decision',
  sameScope: true,
  declaringSource: oldSource,
  targetSource: 'user',
  declaringLatestSeq: 2,
  targetLatestSeq: 1,
  declaringValue: 'Use the durable outbox.',
  targetValue: 'Use the in-memory queue.',
})

const newVerdict = mayRetire({
  declaring: 'decision',
  target: 'decision',
  sameScope: true,
  declaringSource: validation.accepted[0]?.sourceAuthority ?? 'unknown',
  targetSource: 'user',
  declaringLatestSeq: validation.accepted[0]?.latestDecisionSeq,
  targetLatestSeq: 1,
  declaringValue: 'Use the durable outbox.',
  targetValue: 'Use the in-memory queue.',
})

function anchorDoor() {
  const session = Session.create(SessionId(`ef-r2-authority-${process.pid}`))
  session.append('user/message', user('Use the in-memory queue.'), { surfaceOp: 'append' })
  const userSeq = session.seq - 1
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: model('I decided the durable outbox is better.'),
  }, { surfaceOp: 'append' })
  const assistantSeq = session.seq - 1
  const service = createAnchorService()
  const key = { namespace: 'scope', entity: 'queue', property: 'mode' }

  let mismatch = null
  try {
    service.declare(session, {
      kind: 'decision',
      stateKey: key,
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceAuthority: 'user',
      sourceRefs: [{ seq: assistantSeq }],
    })
  } catch (error) {
    mismatch = error instanceof Error ? error.message : String(error)
  }

  let derived = null
  try {
    const anchor = service.declare(session, {
      kind: 'decision',
      stateKey: key,
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceRefs: [{ seq: assistantSeq }],
    })
    derived = anchor.sourceAuthority
  } catch (error) {
    derived = `(failed: ${error instanceof Error ? error.message : String(error)})`
  }

  let occupied = null
  try {
    service.declare(session, {
      kind: 'decision',
      stateKey: key,
      value: 'Use the in-memory queue.',
      authority: 'decision',
      sourceRefs: [{ seq: userSeq }],
    })
    service.declare(session, {
      kind: 'decision',
      stateKey: key,
      value: 'Use the durable outbox.',
      authority: 'decision',
      sourceRefs: [{ seq: assistantSeq }],
    })
  } catch (error) {
    occupied = error instanceof Error ? error.message : String(error)
  }

  return {
    sessionId: session.id,
    seqs: { userSeq, assistantSeq },
    suppliedUserLabelWithAssistantEvidence: mismatch,
    omittedLabelDerived: derived,
    assistantAtOccupiedUserCoordinate: occupied,
  }
}

function retireExposure() {
  const files = ['src/recall/tools.ts', 'src/status/command.ts', 'src/plugin.ts']
  const hits = []
  for (const file of files) {
    const path = join(ROOT, file)
    if (!existsSync(path)) continue
    if (/anchors?\.retire\s*\(|epistemicFold\.retire\s*\(|\.retire\(/u.test(readFileSync(path, 'utf8'))) {
      hits.push(file)
    }
  }
  return {
    modelCallableFilesChecked: files,
    retireReferences: hits,
    note: 'AnchorService.retire remains a privileged programmatic API; no registered tool or command calls it. The state-write audit classifies it; this round does not change it.',
  }
}

const output = {
  schemaVersion: 1,
  work: 'EF-R2 WP5',
  generatedAt: new Date().toISOString(),
  mixedOrigin: {
    fixture: {
      targetAnchor: 'user-queue at seq 1',
      evidence: [
        { kind: 'user/message', seq: 1, quote: 'Use the in-memory queue for now.' },
        { kind: 'assistant/message', seq: 2, quote: 'I decided the durable outbox is better.' },
      ],
      proposal: 'Use the durable outbox.',
    },
    oldLogic: {
      sourceAuthority: oldSource,
      latestDecisionSeq: 2,
      mayRetire: oldVerdict,
      verdict: oldVerdict.allowed ? 'allowed' : 'refused',
      note: 'This is the SAME mayRetire with the inputs the old seq-blind origin produced. The bypass was in the inputs, not in the retirement rule.',
    },
    newLogic: {
      sourceAuthority: validation.accepted[0]?.sourceAuthority ?? null,
      latestDecisionSeq: validation.accepted[0]?.latestDecisionSeq ?? null,
      mayRetire: newVerdict,
      planner: {
        withheld: plan.withheld,
        refusedRetirements: plan.refusedRetirements,
      },
      verdict: plan.withheld.length > 0 ? 'refused' : 'allowed',
    },
    decisionOriginCases: [
      { entries: [{ kind: 'user/message', seq: 1 }, { kind: 'assistant/message', seq: 2 }], origin: decisionOriginOf([{ kind: 'user/message', seq: 1 }, { kind: 'assistant/message', seq: 2 }]) },
      { entries: [{ kind: 'assistant/message', seq: 1 }, { kind: 'user/message', seq: 2 }], origin: decisionOriginOf([{ kind: 'assistant/message', seq: 1 }, { kind: 'user/message', seq: 2 }]) },
      { entries: [{ kind: 'user/message', seq: 1 }, { kind: 'tool/result', seq: 9 }], origin: decisionOriginOf([{ kind: 'user/message', seq: 1 }, { kind: 'tool/result', seq: 9 }]) },
    ],
    regressionGate: {
      test: 'tests/ef-r2-mixed-origin.spec.ts',
      tests: 12,
      sha256: existsSync(join(ROOT, 'tests', 'ef-r2-mixed-origin.spec.ts'))
        ? sha256(join(ROOT, 'tests', 'ef-r2-mixed-origin.spec.ts'))
        : null,
    },
  },
  anchorService: anchorDoor(),
  retireAudit: retireExposure(),
  sources: {
    authority: { path: 'src/state/authority.ts', sha256: sha256(join(ROOT, 'src', 'state', 'authority.ts')) },
    validate: { path: 'src/semantic/validate.ts', sha256: sha256(join(ROOT, 'src', 'semantic', 'validate.ts')) },
    anchorService: { path: 'src/state/anchor-service.ts', sha256: sha256(join(ROOT, 'src', 'state', 'anchor-service.ts')) },
  },
  note: 'The old verdict is reproduced by calling the same mayRetire with the old inputs; the new verdict is the real validator + planner. Historical replay is unchanged: applyOps applies recorded ops as recorded.',
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'authority-closure.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')

process.stdout.write(`authority: old=${output.mixedOrigin.oldLogic.verdict} new=${output.mixedOrigin.newLogic.verdict} origin=${output.mixedOrigin.newLogic.sourceAuthority}\n`)
process.stdout.write(`anchor door: mismatch=${output.anchorService.suppliedUserLabelWithAssistantEvidence !== null} derived=${output.anchorService.omittedLabelDerived} occupied=${output.anchorService.assistantAtOccupiedUserCoordinate !== null}\n`)
process.stdout.write(`retire references in model-callable files: ${output.retireAudit.retireReferences.length}\n`)
