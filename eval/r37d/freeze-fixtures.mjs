#!/usr/bin/env node
/**
 * R37-D WP3: freeze the fixed continuation contexts for the next process batch.
 *
 * The C2 pilot regenerated a writer checkpoint inside every cell. That is a
 * valid end-to-end product run, but it is not a fixed-context mechanism
 * experiment: the P0/P1 comparison would inherit writer variance. This script
 * selects one real checkpoint per case/context arm and freezes its bytes.
 *
 * Selection rule, declared before the next live batch:
 *
 *   for each case and arm, take the G0 replicate with the lowest ordinal
 *   (r1). G0 is the no-guard baseline. The task outcome is not an input.
 *
 * All six candidates per case/arm (three G0, three G1) are recorded, so the
 * rule can be audited against the alternatives. G1 candidates are never
 * selected: the guard belongs to the process experiment, not to the context.
 *
 *   node eval/r37d/freeze-fixtures.mjs          write missing fixtures, verify existing
 *   node eval/r37d/freeze-fixtures.mjs --check  verify only, write nothing
 *
 * Outputs:
 *   eval/r37d/fixtures/<case>-<arm>/context.txt
 *   eval/r37d/fixtures/<case>-<arm>/fixture.json
 *   eval/r37d/out/fixed-context-manifest.json
 *
 * @module eval/r37d/freeze-fixtures
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTree } from '../r33/src/dataset.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const FIXTURES = join(HERE, 'fixtures')
const R37C = process.env.R37C_WORKTREE ?? 'F:/Codex_Work_Space/DSH plugin/ef-r37c-closure'
const CHECK_ONLY = process.argv.includes('--check')

const CASES = ['B2', 'D1-v2']
const ARMS = ['B1', 'S']

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/iu,
  /\bAuthorization\s*:/iu,
  /\bapi[_-]?key\s*[:=]\s*['"][^'"]{8,}/iu,
]

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/gu, ' ').trim()
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function caseRoot(caseId) {
  for (const candidate of [
    join(REPO, 'eval', 'r37', 'cases', caseId),
    join(REPO, 'eval', 'r33', 'cases', caseId),
    join(R37C, 'eval', 'r37c', 'cases', caseId),
  ]) {
    if (existsSync(join(candidate, 'case.json'))) return candidate
  }
  return null
}

function hashWorkspace(files) {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
  const hash = createHash('sha256')
  for (const [path, content] of entries) {
    hash.update(path, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(content, 'utf8')
    hash.update('\0', 'utf8')
  }
  return { digest: hash.digest('hex'), files: entries.length, paths: entries.map(([path]) => path) }
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from',
  'that', 'this', 'it', 'its', 'has', 'have', 'had', 'not', 'no', 'so', 'if',
])

function tokens(text) {
  return new Set(normalize(text)
    .split(/[^a-z0-9-]+/u)
    .filter(token => token.length > 2 && !STOP_WORDS.has(token)))
}

function coverage(needleTokens, haystackTokens) {
  if (needleTokens.size === 0) return 0
  let present = 0
  for (const token of needleTokens) if (haystackTokens.has(token)) present += 1
  return present / needleTokens.size
}

function factVisibility(caseData, checkpoint, anchors) {
  const text = normalize(checkpoint)
  const anchorText = anchors.map(normalize)
  const haystack = tokens(`${checkpoint}\n${anchors.join('\n')}`)
  return (caseData.gold ?? []).map(fact => {
    const needle = normalize(fact.visibleNeedle ?? fact.quote)
    const statement = normalize(fact.statement)
    const lexicalInCheckpoint = text.includes(needle) || text.includes(statement)
    const lexicalInAnchor = anchorText.some(anchor => anchor === statement || anchor.includes(needle))
    const factTokens = tokens(`${fact.statement} ${fact.visibleNeedle ?? fact.quote}`)
    const tokenCoverage = coverage(factTokens, haystack)
    const semanticVisible = tokenCoverage >= 0.75
    return {
      factId: fact.factId,
      criticality: fact.criticality,
      visibleNeedle: fact.visibleNeedle ?? fact.quote,
      statement: fact.statement,
      lexicalInCheckpoint,
      lexicalInAnchor,
      tokenCoverage,
      semanticVisible,
      factVisible: lexicalInCheckpoint || lexicalInAnchor || semanticVisible,
    }
  })
}

const results = await readJson(join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-results.json'))
const byCell = new Map(results.results.map(entry => [entry.cell.cellId, entry]))
const discrepancies = []
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP3-fixed-context',
  source: {
    c2Results: join(R37C, 'eval', 'r37c', 'out', 'r37c-c2-results.json'),
    note: 'The contexts are real C2 checkpoints. The next batch reuses them instead of regenerating a writer per cell.',
  },
  selectionRule: {
    rule: 'for each case and context arm, select the G0 replicate with the lowest ordinal (r1)',
    guard: 'G0 (no finish guard)',
    candidateOrder: ['r1', 'r2', 'r3'],
    outcomeBlind: true,
    rationale: 'G0 is the baseline condition. The ordinal is fixed before the next live batch; contract success, task success, and delivery are recorded only for audit.',
  },
  cases: {},
  workspace: {},
  verification: null,
  discrepancies,
}

for (const caseId of CASES) {
  const root = caseRoot(caseId)
  if (root === null) {
    discrepancies.push({ area: 'case', detail: `${caseId}: case root not found` })
    continue
  }
  const caseData = await readJson(join(root, 'case.json'))
  const files = await readTree(join(root, 'workspace'))
  const workspace = hashWorkspace(files)
  manifest.workspace[caseId] = {
    caseRoot: root,
    task: caseData.task,
    requiresTests: caseData.requiresTests,
    historyIndependent: caseData.historyIndependent,
    digest: workspace.digest,
    files: workspace.files,
    paths: workspace.paths,
  }
  manifest.cases[caseId] = {}

  for (const arm of ARMS) {
    const candidates = []
    for (const guard of ['G0', 'G1']) {
      for (const replicateId of ['r1', 'r2', 'r3']) {
        const cellId = `${caseId}-${arm}-${guard}-${replicateId}`
        const entry = byCell.get(cellId)
        if (entry === undefined || !existsSync(entry.reportPath)) {
          discrepancies.push({ area: 'candidate', detail: `${cellId}: report missing` })
          continue
        }
        const report = await readJson(entry.reportPath)
        const row = report.rows?.[0]
        const checkpoint = row?.checkpoint
        if (checkpoint === undefined || typeof checkpoint.text !== 'string' || checkpoint.text.length === 0) {
          discrepancies.push({ area: 'candidate', detail: `${cellId}: checkpoint missing` })
          continue
        }
        const digest = sha256(checkpoint.text)
        if (digest !== checkpoint.digest) {
          discrepancies.push({ area: 'candidate', detail: `${cellId}: checkpoint digest mismatch` })
        }
        if (row.writer?.renderedCheckpointDigest !== undefined
          && row.writer.renderedCheckpointDigest !== digest) {
          discrepancies.push({ area: 'candidate', detail: `${cellId}: rendered checkpoint digest mismatch` })
        }
        const secrets = SECRET_PATTERNS.filter(pattern => pattern.test(checkpoint.text))
        if (secrets.length > 0) {
          discrepancies.push({ area: 'candidate', detail: `${cellId}: secret-like text in checkpoint` })
        }
        candidates.push({
          cellId,
          guard,
          replicateId,
          runId: entry.runId,
          reportPath: entry.reportPath,
          checkpointDigest: digest,
          checkpointChars: checkpoint.text.length,
          checkpointText: checkpoint.text,
          delivery: row.writer?.commitStatus ?? entry.delivery ?? 'unknown',
          stateDigest: row.state?.stateDigest ?? null,
          anchors: Array.isArray(row.state?.anchors) ? row.state.anchors : [],
          contractSuccess: row.behaviour?.contractSuccess === true,
          taskSuccess: row.behaviour?.taskSuccess === true,
          testsExecuted: row.behaviourDetail?.testsExecuted ?? 0,
          facts: factVisibility(caseData, checkpoint.text, Array.isArray(row.state?.anchors) ? row.state.anchors : []),
        })
      }
    }

    const eligible = candidates
      .filter(candidate => candidate.guard === 'G0')
      .sort((left, right) => left.replicateId.localeCompare(right.replicateId))
    if (eligible.length !== 3) {
      discrepancies.push({ area: 'selection', detail: `${caseId}/${arm}: ${eligible.length} eligible G0 candidates` })
      continue
    }
    const selected = eligible[0]
    const fixtureName = `${caseId}-${arm}`
    const fixtureDir = join(FIXTURES, fixtureName)
    const contextPath = join(fixtureDir, 'context.txt')
    const metaPath = join(fixtureDir, 'fixture.json')
    const fixtureMeta = {
      schemaVersion: 1,
      caseId,
      arm,
      runId: selected.runId,
      replicateId: selected.replicateId,
      guard: selected.guard,
      checkpointDigest: selected.checkpointDigest,
      checkpointChars: selected.checkpointChars,
      delivery: selected.delivery,
      stateDigest: selected.stateDigest,
      anchors: selected.anchors,
      facts: selected.facts,
      sourceReport: selected.reportPath,
      task: caseData.task,
      workspaceDigest: workspace.digest,
      note: 'Frozen R37-D fixed-context fixture. Reuse verbatim; do not regenerate.',
    }

    if (CHECK_ONLY) {
      if (!existsSync(contextPath) || !existsSync(metaPath)) {
        discrepancies.push({ area: 'fixture', detail: `${fixtureName}: fixture files missing` })
      } else {
        const existing = await readFile(contextPath, 'utf8')
        if (sha256(existing) !== selected.checkpointDigest) {
          discrepancies.push({ area: 'fixture', detail: `${fixtureName}: context.txt digest mismatch` })
        }
        const existingMeta = await readJson(metaPath)
        if (existingMeta.checkpointDigest !== selected.checkpointDigest) {
          discrepancies.push({ area: 'fixture', detail: `${fixtureName}: fixture.json digest mismatch` })
        }
      }
    } else if (existsSync(contextPath)) {
      const existing = await readFile(contextPath, 'utf8')
      if (sha256(existing) !== selected.checkpointDigest) {
        discrepancies.push({ area: 'fixture', detail: `${fixtureName}: refusing to overwrite a different context` })
      } else {
        await writeFile(metaPath, `${JSON.stringify(fixtureMeta, null, 2)}\n`, 'utf8')
      }
    } else {
      await mkdir(fixtureDir, { recursive: true })
      await writeFile(contextPath, selected.checkpointText, 'utf8')
      await writeFile(metaPath, `${JSON.stringify(fixtureMeta, null, 2)}\n`, 'utf8')
    }

    manifest.cases[caseId][arm] = {
      selected: {
        cellId: selected.cellId,
        runId: selected.runId,
        replicateId: selected.replicateId,
        guard: selected.guard,
        checkpointDigest: selected.checkpointDigest,
        checkpointChars: selected.checkpointChars,
        delivery: selected.delivery,
        stateDigest: selected.stateDigest,
        anchors: selected.anchors,
        facts: selected.facts,
        fixture: {
          context: `eval/r37d/fixtures/${fixtureName}/context.txt`,
          meta: `eval/r37d/fixtures/${fixtureName}/fixture.json`,
          sha256: selected.checkpointDigest,
        },
      },
      candidates: candidates.map(candidate => ({
        cellId: candidate.cellId,
        guard: candidate.guard,
        replicateId: candidate.replicateId,
        checkpointDigest: candidate.checkpointDigest,
        checkpointChars: candidate.checkpointChars,
        delivery: candidate.delivery,
        contractSuccess: candidate.contractSuccess,
        taskSuccess: candidate.taskSuccess,
        testsExecuted: candidate.testsExecuted,
        selected: candidate.cellId === selected.cellId,
        eligible: candidate.guard === 'G0',
      })),
    }
  }
}

const selectedFixtures = Object.values(manifest.cases).flatMap(arms =>
  Object.entries(arms).map(([arm, value]) => ({ arm, ...value.selected })))
const distinctDigests = new Set(selectedFixtures.map(fixture => fixture.checkpointDigest))
manifest.verification = {
  cases: Object.keys(manifest.cases).length,
  armsPerCase: ARMS.length,
  fixtures: selectedFixtures.length,
  distinctCheckpointDigests: distinctDigests.size,
  allDigestsMatch: discrepancies.every(discrepancy => !discrepancy.detail.includes('digest mismatch')),
  allCandidatesRecorded: Object.values(manifest.cases).every(arms =>
    Object.values(arms).every(value => value.candidates.length === 6)),
  allSelectedAreG0R1: Object.values(manifest.cases).every(arms =>
    Object.values(arms).every(value => value.selected.guard === 'G0' && value.selected.replicateId === 'r1')),
  workspaceDigestsPresent: Object.values(manifest.workspace).every(workspace => typeof workspace.digest === 'string'),
  secretFindings: discrepancies.filter(discrepancy => discrepancy.detail.includes('secret-like')).length,
}

if (!CHECK_ONLY) {
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'fixed-context-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

const ok = discrepancies.length === 0
  && manifest.verification.allSelectedAreG0R1
  && manifest.verification.allCandidatesRecorded
  && manifest.verification.secretFindings === 0
process.stdout.write(`R37-D fixed contexts: ${FIXTURES}\n`)
process.stdout.write(`fixtures ${manifest.verification.fixtures}; distinct digests ${distinctDigests.size}; `
  + `G0/r1 ${manifest.verification.allSelectedAreG0R1}; candidates ${manifest.verification.allCandidatesRecorded}; `
  + `secrets ${manifest.verification.secretFindings}\n`)
for (const fixture of selectedFixtures) {
  process.stdout.write(`  ${fixture.cellId}  ${fixture.checkpointDigest.slice(0, 12)}…  `
    + `${fixture.checkpointChars} chars  ${fixture.delivery}\n`)
}
process.stdout.write(`discrepancies ${discrepancies.length}\n`)
if (!ok) {
  for (const discrepancy of discrepancies) process.stdout.write(`  ${discrepancy.area}: ${discrepancy.detail}\n`)
}
process.exit(ok ? 0 : 1)
