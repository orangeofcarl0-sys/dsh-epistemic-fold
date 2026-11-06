#!/usr/bin/env node
/**
 * R37-D WP4: freeze the bounded process-prompt batch and run its preflight.
 *
 * This script makes no provider request. The batch is `ready-for-authorization`
 * because the R37-C authorization covered the C2 batch, not this one.
 *
 * Design:
 *   2 cases x 2 context arms x 2 process conditions x 3 replicates = 24 cells
 *   guard off in P0 and P1
 *   8 steps, 1,024 follow-up output tokens
 *   fixed context per case/arm from eval/r37d/fixtures
 *   P0 is the frozen task; P1 appends one generic process sentence
 *
 *   node eval/r37d/process-pilot.mjs            write manifest + preflight
 *   node eval/r37d/process-pilot.mjs --check    verify the frozen inputs
 *   node eval/r37d/process-pilot.mjs --run      refuse without a new authorization
 *
 * @module eval/r37d/process-pilot
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTree } from '../r33/src/dataset.mjs'
import { SCORER_VERSION } from '../r33/src/grade.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const FIXTURES = join(HERE, 'fixtures')
const PROMPTS = join(HERE, 'prompts')
const CHECK_ONLY = process.argv.includes('--check')
const RUN = process.argv.includes('--run')

const CASES = ['B2', 'D1-v2']
const ARMS = ['B1', 'S']
const CONDITIONS = ['P0', 'P1']
const REPLICATES = ['r1', 'r2', 'r3']
const MODEL = 'deepseek-v4.1-flash'
const PROTOCOL = 'P3s'
const RUNTIME = 'custom-json-loop'
const STEPS = 8
const OUTPUT_TOKENS = 1024
const LIMITS = {
  httpAttempts: 240,
  inputTokens: 300_000,
  outputTokens: 70_000,
  wallClockMs: 3_600_000,
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function caseRoot(caseId) {
  for (const candidate of [
    join(REPO, 'eval', 'r37', 'cases', caseId),
    join(REPO, 'eval', 'r33', 'cases', caseId),
  ]) {
    if (existsSync(join(candidate, 'case.json'))) return candidate
  }
  return null
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

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/gu, ' ').trim()
}

if (RUN) {
  process.stderr.write('R37-D process pilot: not authorized for this batch.\n')
  process.stderr.write('The R37-C authorization covered the C2 batch, not this 24-cell batch.\n')
  process.stderr.write('No provider request was made. Freeze a new authorization before running.\n')
  process.exit(2)
}

const fixtureManifest = await readJson(join(OUT, 'fixed-context-manifest.json'))
const p0 = await readFile(join(PROMPTS, 'P0.txt'), 'utf8')
const p1 = await readFile(join(PROMPTS, 'P1.txt'), 'utf8')
const p0Digest = sha256(p0)
const p1Digest = sha256(p1)

const checks = []
function check(id, status, detail) {
  checks.push({ id, status, detail })
}

const cells = []
const caseDataById = {}
for (const caseId of CASES) {
  const root = caseRoot(caseId)
  if (root === null) {
    check(`case-${caseId}`, 'failed', 'case root not found')
    continue
  }
  const caseData = await readJson(join(root, 'case.json'))
  caseDataById[caseId] = caseData
  const files = await readTree(join(root, 'workspace'))
  const workspaceDigest = hashFiles(files)
  const expectedWorkspace = fixtureManifest.workspace?.[caseId]?.digest
  check(`workspace-${caseId}`, workspaceDigest === expectedWorkspace ? 'passed' : 'failed',
    `${workspaceDigest.slice(0, 12)}… vs ${String(expectedWorkspace).slice(0, 12)}…`)

  for (const arm of ARMS) {
    const selected = fixtureManifest.cases?.[caseId]?.[arm]?.selected
    if (selected === undefined) {
      check(`fixture-${caseId}-${arm}`, 'failed', 'fixture selection missing')
      continue
    }
    const contextPath = join(REPO, selected.fixture.context)
    const context = existsSync(contextPath) ? await readFile(contextPath, 'utf8') : null
    const contextDigest = context === null ? null : sha256(context)
    check(`fixture-${caseId}-${arm}`,
      contextDigest === selected.checkpointDigest && selected.guard === 'G0' ? 'passed' : 'failed',
      `${String(contextDigest).slice(0, 12)}… vs ${selected.checkpointDigest.slice(0, 12)}…`)

    for (const condition of CONDITIONS) {
      const processPrompt = condition === 'P0' ? '' : p1.trim()
      const task = processPrompt === ''
        ? caseData.task
        : `${caseData.task}\n\n${processPrompt}`
      for (const replicateId of REPLICATES) {
        cells.push({
          cellId: `r37d-process-${caseId}-${arm}-${condition}-${replicateId}`,
          caseId,
          arm,
          condition,
          replicateId,
          prompt: condition,
          promptPath: `eval/r37d/prompts/${condition}.txt`,
          promptDigest: condition === 'P0' ? p0Digest : p1Digest,
          promptChars: condition === 'P0' ? p0.length : p1.length,
          task,
          taskDigest: sha256(task),
          fixture: selected.fixture.context,
          fixtureDigest: selected.checkpointDigest,
          workspaceDigest,
          guard: false,
          steps: STEPS,
          outputTokens: OUTPUT_TOKENS,
          model: MODEL,
          toolProtocol: PROTOCOL,
          runtime: RUNTIME,
          scorerVersion: SCORER_VERSION,
        })
      }
    }
  }
}

const uniqueCells = new Set(cells.map(cell => cell.cellId))
check('matrix', cells.length === 24 && uniqueCells.size === 24 ? 'passed' : 'failed',
  `${cells.length} cells, ${uniqueCells.size} unique`)
const byCondition = {}
for (const cell of cells) {
  const key = `${cell.caseId}/${cell.arm}/${cell.condition}`
  byCondition[key] = (byCondition[key] ?? 0) + 1
}
check('replicates',
  Object.values(byCondition).every(count => count === 3) && Object.keys(byCondition).length === 8
    ? 'passed' : 'failed',
  JSON.stringify(byCondition))

check('prompts',
  p0.length === 0 && p1.length > 0 && p0Digest === sha256('') ? 'passed' : 'failed',
  `P0 ${p0.length} chars ${p0Digest.slice(0, 12)}…; P1 ${p1.length} chars ${p1Digest.slice(0, 12)}…`)

let goldLeak = 0
for (const [caseId, caseData] of Object.entries(caseDataById)) {
  const text = normalize(p1)
  for (const fact of caseData.gold ?? []) {
    if (text.includes(normalize(fact.statement))
      || text.includes(normalize(fact.visibleNeedle ?? fact.quote))) goldLeak += 1
  }
}
check('prompt-no-gold', goldLeak === 0 ? 'passed' : 'failed', `${goldLeak} gold phrases in P1`)

check('guard', cells.every(cell => cell.guard === false) ? 'passed' : 'failed', 'guard off in all cells')
check('budget', LIMITS.httpAttempts === 240
  && LIMITS.inputTokens === 300_000
  && LIMITS.outputTokens === 70_000
  && LIMITS.wallClockMs === 3_600_000 ? 'passed' : 'failed', JSON.stringify(LIMITS))
check('frozen', cells.every(cell => cell.model === MODEL
  && cell.toolProtocol === PROTOCOL
  && cell.runtime === RUNTIME
  && cell.steps === STEPS
  && cell.outputTokens === OUTPUT_TOKENS
  && cell.scorerVersion === SCORER_VERSION) ? 'passed' : 'failed',
  `model ${MODEL}, protocol ${PROTOCOL}, runtime ${RUNTIME}, steps ${STEPS}, output ${OUTPUT_TOKENS}, scorer ${SCORER_VERSION}`)

const authorization = {
  required: true,
  granted: false,
  basis: 'The R37-C authorization covered the 24-cell C2 batch. It does not cover this new batch.',
  requiredGrant: 'a new frozen authorization naming this manifest digest, cell count, model, route, and budget',
}
check('authorization', authorization.granted ? 'passed' : 'partial',
  authorization.granted ? 'granted' : 'not granted; batch is ready-for-authorization')

const source = await readFile(join(HERE, 'process-pilot.mjs'), 'utf8')
const providerPatterns = [
  /from\s+['"]@deepseek-ai\/dsh-llm['"]/u,
  /from\s+['"]@deepseek-ai\/dsh-agent-loop['"]/u,
  /from\s+['"]@deepseek-ai\/dsh-agent['"]/u,
  /process\.env\.R37C_/u,
]
const providerHits = providerPatterns.filter(pattern => pattern.test(source)).map(pattern => pattern.source)
check('no-provider', providerHits.length === 0 ? 'passed' : 'failed',
  providerHits.length === 0 ? 'no provider client or credential read in the preflight path' : providerHits.join(', '))
check('runner', 'partial', 'frozen inputs are complete; live adapter wiring is design-only')

const failed = checks.filter(entry => entry.status === 'failed')
const partial = checks.filter(entry => entry.status === 'partial')
const status = failed.length > 0
  ? 'failed'
  : partial.length > 0
    ? 'ready-for-authorization'
    : 'passed'

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP4-process-pilot',
  status,
  design: {
    cases: CASES,
    contextArms: ARMS,
    processConditions: CONDITIONS,
    replicates: REPLICATES,
    cells: 24,
    guard: 'off',
    steps: STEPS,
    outputTokens: OUTPUT_TOKENS,
    model: MODEL,
    toolProtocol: PROTOCOL,
    runtime: RUNTIME,
    scorerVersion: SCORER_VERSION,
    randomization: 'none; full factorial with three fixed replicates',
    estimand: 'E2 controlled process effect; not an EF Active product effect',
  },
  prompts: {
    P0: { path: 'eval/r37d/prompts/P0.txt', sha256: p0Digest, chars: p0.length, text: p0 },
    P1: { path: 'eval/r37d/prompts/P1.txt', sha256: p1Digest, chars: p1.length, text: p1 },
  },
  fixtures: fixtureManifest.cases,
  workspace: fixtureManifest.workspace,
  limits: LIMITS,
  authorization,
  cells,
  nextExperiment: {
    id: 'r37d-step-budget',
    status: 'not-executed',
    design: '2 cases x 2 arms x 2 step budgets (8, 12) x 3 replicates = 24 cells',
    note: 'Separate preregistration. Do not mix the step budget into P0/P1.',
  },
}

const preflight = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  round: 'R37-D',
  work: 'WP4-process-pilot-preflight',
  status,
  manifestDigest: sha256(JSON.stringify(manifest)),
  checks,
  authorization,
  runner: {
    status: 'design-only',
    note: 'The frozen inputs are complete. The live adapter wiring is not part of this preflight; it must be implemented and reviewed before an authorized run.',
    entryPoint: 'eval/r33/live.mjs followUp',
  },
  noProviderCall: true,
}

if (!CHECK_ONLY) {
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'process-pilot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(join(OUT, 'process-pilot-preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`, 'utf8')
} else if (!existsSync(join(OUT, 'process-pilot-manifest.json'))) {
  check('manifest', 'failed', 'manifest missing')
}

process.stdout.write(`R37-D process pilot: ${status}\n`)
process.stdout.write(`cells ${cells.length}; conditions ${JSON.stringify(byCondition)}\n`)
process.stdout.write(`authorization ${authorization.granted ? 'granted' : 'not granted'}; `
  + `runner ${preflight.runner.status}; provider calls 0\n`)
for (const entry of checks) {
  process.stdout.write(`  ${entry.id} ${entry.status}: ${entry.detail}\n`)
}
process.exit(status === 'failed' ? 1 : 0)
