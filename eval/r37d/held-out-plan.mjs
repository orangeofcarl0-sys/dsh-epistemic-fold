#!/usr/bin/env node
/**
 * R37-D WP6: freeze the held-out benchmark plan.
 *
 * Two cases are certified offline:
 *
 *   H1-v2  retrieval-trigger   (R37-C certificate + R37-D leakage audit)
 *   S1-v1  authority-scope     (R37-D certification)
 *
 * Four categories are specified but not authored:
 *
 *   decision-override
 *   negative-knowledge
 *   cross-phase-dependency
 *   multi-fold-supersession
 *
 * No provider call is made. A specified case is not a case; it must be
 * authored, certified, and frozen before any live batch uses it.
 *
 * Output:
 *   eval/r37d/out/held-out-plan.json
 *
 * @module eval/r37d/held-out-plan
 */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJson } from '../r37/src/io.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out', 'held-out-plan.json')

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function hashFiles(files) {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
  const hash = createHash('sha256')
  for (const [path, content] of entries) {
    hash.update(path, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(content, 'utf8')
    hash.update('\0', 'utf8')
  }
  return hash.digest('hex')
}

async function caseFiles(caseRoot) {
  const files = {}
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const display = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(directory, entry.name), display)
      else if (entry.isFile()) files[display] = await readFile(join(directory, entry.name), 'utf8')
    }
  }
  await walk(caseRoot, '')
  return files
}

async function certified(caseId, caseRoot, referenceAction, staleAction, certificatePath, auditPath) {
  const caseData = JSON.parse(await readFile(join(caseRoot, 'case.json'), 'utf8'))
  const files = await caseFiles(caseRoot)
  const referenceFiles = Object.fromEntries(Object.entries(files)
    .filter(([path]) => path.startsWith(`actions/${referenceAction}/`)))
  const staleFiles = Object.fromEntries(Object.entries(files)
    .filter(([path]) => path.startsWith(`actions/${staleAction}/`)))
  return {
    id: caseId,
    category: caseData.riskClass,
    status: 'certified',
    historyIndependent: caseData.historyIndependent,
    gold: caseData.gold.map(fact => ({
      factId: fact.factId,
      statement: fact.statement,
      visibleNeedle: fact.visibleNeedle,
      quote: fact.quote,
      sourceRefs: fact.sourceRefs,
      scope: fact.scope ?? null,
    })),
    referenceAction,
    staleAction,
    digests: {
      case: sha256(JSON.stringify(caseData)),
      workspace: hashFiles(Object.fromEntries(Object.entries(files)
        .filter(([path]) => path.startsWith('workspace/')))),
      checker: sha256(files['check.mjs'] ?? ''),
      reference: hashFiles(referenceFiles),
      stale: hashFiles(staleFiles),
    },
    certification: certificatePath,
    audit: auditPath,
  }
}

const h1 = await certified(
  'H1-v2',
  join(ROOT, 'eval', 'r37c', 'cases', 'H1-v2'),
  'use-eu',
  'use-us',
  'eval/r37c/out/h1-v2-validity.json',
  'eval/r37d/out/h1-v2-audit.json',
)
const s1 = await certified(
  'S1-v1',
  join(ROOT, 'eval', 'r37d', 'cases', 'S1-v1'),
  'use-production',
  'use-staging',
  'eval/r37d/out/s1-v1-validity.json',
  null,
)

const specified = [
  {
    id: 'D2-v1',
    category: 'decision-override',
    status: 'specified-not-authored',
    design: 'An early decision is explicitly replaced by a later authoritative decision. The visible test accepts either value; the hidden checker requires the later one. The stale action is the earlier value.',
    goldShape: 'decision, later sourceRef, supersedesFactId pointing at the early decision',
    referenceAction: 'latest',
    staleAction: 'early',
    mustCertify: ['reference passes visible+hidden', 'early passes visible and fails hidden', 'no gold in task/workspace/visible test'],
  },
  {
    id: 'N1-v1',
    category: 'negative-knowledge',
    status: 'specified-not-authored',
    design: 'A dependency or approach is explicitly rejected in the history. The workspace is functional without it. The visible test checks behaviour; the hidden checker rejects the forbidden import or call.',
    goldShape: 'rejected-approach, tool sourceRef, quote contains the rejection',
    referenceAction: 'without-rejected-dependency',
    staleAction: 'with-rejected-dependency',
    mustCertify: ['reference passes visible+hidden', 'stale passes visible and fails hidden', 'the rejected name is absent from the workspace and visible test'],
  },
  {
    id: 'X1-v1',
    category: 'cross-phase-dependency',
    status: 'specified-not-authored',
    design: 'A phase-1 fact is required in phase 3 after at least one fold. The task and workspace do not repeat it. The hidden checker requires the phase-1 value.',
    goldShape: 'finding or constraint from phase 1, cited across the fold',
    referenceAction: 'use-phase1-fact',
    staleAction: 'use-default',
    mustCertify: ['the fact survives the fold in S and the summary in B1', 'reference passes visible+hidden', 'stale fails hidden', 'the fact is absent from phase 3 task/workspace'],
  },
  {
    id: 'M1-v1',
    category: 'multi-fold-supersession',
    status: 'specified-not-authored',
    design: 'A coordinate is revised twice. The first and second values are stale. The hidden checker requires the third value. The visible test accepts any well-formed value.',
    goldShape: 'three facts at one subjectKey, two superseded, the third current',
    referenceAction: 'latest',
    staleAction: 'middle',
    mustCertify: ['the final active anchor is the third value', 'both stale values fail hidden', 'the stale values do not revive after the second fold'],
  },
]

const plan = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP6-held-out-plan',
  status: 'prepared',
  noProviderCall: true,
  cases: [h1, s1, ...specified],
  counts: {
    certified: 2,
    specified: specified.length,
    total: 2 + specified.length,
  },
  freezeRequirements: [
    'The gold quote occurs verbatim in every sourceRef message.',
    'The reference action passes the visible tests and the hidden checker.',
    'The stale and a plausible alternative action pass the visible test and fail the hidden checker.',
    'The gold is absent from the task, the initial workspace, the visible test, and the writer handoff.',
    'The hidden checker is outside the workspace and declares the exact check names.',
    'A certification artifact records every run and the case digests.',
    'No provider call is made during certification.',
  ],
  nextBatch: {
    status: 'not-executed',
    note: 'The next history-use batch must use only certified cases. The four specified cases require authoring, certification, and a new frozen manifest before any live run.',
  },
  notes: [
    'H1-v2 is certified by R37-C and re-audited by R37-D. The R37-D audit adds a us-west-2 alternative that passes visible and fails hidden.',
    'S1-v1 is authored and certified in R37-D.',
    'The four specified categories are design briefs, not cases.',
  ],
}

await writeJson(OUT, plan)
process.stdout.write(`R37-D held-out plan: ${OUT}\n`)
process.stdout.write(`certified ${plan.counts.certified}; specified ${plan.counts.specified}; total ${plan.counts.total}\n`)
process.stdout.write(`H1-v2 ${h1.digests.case.slice(0, 12)}…; S1-v1 ${s1.digests.case.slice(0, 12)}…\n`)
