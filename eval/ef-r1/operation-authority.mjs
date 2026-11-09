#!/usr/bin/env node
/**
 * EF-R1 WP1 evidence: operation-level authority closure.
 *
 * Runs the authority matrix with the real validator, planner and reducer, then
 * checks the required cases are PRESENT and PASSING rather than trusting a
 * green count. It also reads the two frozen probe captures:
 *
 *   probe-before.txt  the same four paths through the code at `cb218cc`
 *   probe-after.txt   the same four paths through the fixed code
 *
 * A suite that silently dropped a case would still be green; the explicit
 * `required` list is what makes that visible — the same accounting defect the
 * C1 round found in a test count that excluded its own skips.
 *
 *   node eval/ef-r1/operation-authority.mjs
 *
 * @module eval/ef-r1/operation-authority
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const REPORT = join(OUT, 'ef-r1-tests.json')

/** Every matrix case the round claims to cover. */
const REQUIRED = [
  'refuses an undeclared same-coordinate replacement of a user decision',
  'refuses an implicit replacement even when the named supersedes is unrelated',
  'refuses a same-packet second declare that would displace an unauthorized head',
  'allows an authorized same-coordinate revision and records the supersession link',
  'allows the user to revise the user decision with a newer statement',
  'does not let a tool result raise an assistant decision to tool standing',
  'does not accept the user’s OLD statement as authority for its opposite',
  'allows a user revision grounded in a NEWER user statement',
  'allows a same-value restatement from the same statement (it changes nothing)',
  'refuses an assistant revision of a historical anchor with no source',
  'keeps historical replay mechanical: a recorded op applies even when a NEW plan would refuse it',
  'applies an explicitly authorized cross-coordinate revision with a newer user statement',
  'refuses a decision revision whose evidence is not newer',
  'allows the same value at the same evidence position',
  'derives decision origin only from decision-capable producers',
]

/** The pre-fix source files, hashed so the evidence names the exact code. */
const SOURCE_FILES = [
  'src/semantic/plan.ts',
  'src/semantic/retirement.ts',
  'src/semantic/types.ts',
  'src/semantic/validate.ts',
  'src/state/authority.ts',
  'tests/ef-r1-operation-authority.spec.ts',
]

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

function readProbe(name) {
  const path = join(OUT, name)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.startsWith('PROBE '))
    .map(line => JSON.parse(line.slice('PROBE '.length)))
}

function main() {
  mkdirSync(OUT, { recursive: true })
  let runError
  try {
    execFileSync(process.execPath, [
      join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'tests/ef-r1-operation-authority.spec.ts',
      '--reporter=json',
      `--outputFile=${REPORT}`,
    ], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  } catch (error) {
    // A failing suite is evidence, not a crash: the report is still read.
    runError = error instanceof Error ? error.message : String(error)
  }
  if (!existsSync(REPORT)) {
    process.stderr.write(`ef-r1: vitest produced no report${runError === undefined ? '' : `: ${runError}`}\n`)
    process.exit(2)
  }
  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const tests = (report.testResults ?? []).flatMap(file => file.assertionResults ?? [])
  const byTitle = new Map(tests.map(test => [test.title, test.status]))
  const missing = REQUIRED.filter(title => !byTitle.has(title))
  const failed = REQUIRED.filter(title => byTitle.get(title) !== 'passed')
  const extras = tests.filter(test => !REQUIRED.includes(test.title)).map(test => test.title)

  const before = readProbe('probe-before.txt')
  const after = readProbe('probe-after.txt')
  const probe = {
    before: before.map(row => ({
      name: row.name,
      declares: row.declares,
      withheld: row.withheld,
      active: row.active,
    })),
    after: after.map(row => ({
      name: row.name,
      declares: row.declares,
      withheld: row.withheld,
      active: row.active,
    })),
  }

  // The vulnerability is only "reproduced" if the pre-fix run actually WROTE
  // the claim and displaced the user value; and only "closed" if the fixed run
  // wrote nothing and kept the user value active.
  const expectedNames = ['no-supersedes', 'unrelated-supersedes', 'mixed-assistant-tool', 'old-user-quote']
  const beforeByName = new Map(before.map(row => [row.name, row]))
  const afterByName = new Map(after.map(row => [row.name, row]))
  const probeVerdicts = expectedNames.map(name => {
    const pre = beforeByName.get(name)
    const post = afterByName.get(name)
    return {
      name,
      reproduced: pre !== undefined
        && pre.declares > 0
        && pre.active.some(entry => entry.value === 'Use the durable outbox.'),
      closed: post !== undefined
        && post.declares === 0
        && post.withheld.length > 0
        && post.active.every(entry => entry.value !== 'Use the durable outbox.'),
    }
  })

  const sources = {}
  for (const path of SOURCE_FILES) {
    sources[path] = sha256(readFileSync(join(ROOT, path), 'utf8'))
  }

  const evidence = {
    schemaVersion: 1,
    work: 'EF-R1 WP1',
    generatedAt: new Date().toISOString(),
    evaluatedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    suite: {
      total: report.numTotalTests ?? tests.length,
      passed: report.numPassedTests ?? tests.filter(test => test.status === 'passed').length,
      failed: report.numFailedTests ?? tests.filter(test => test.status === 'failed').length,
      required: REQUIRED.length,
      missing,
      failedRequired: failed,
      extra: extras,
    },
    probe,
    probeVerdicts,
    sources,
    verdict: missing.length === 0
      && failed.length === 0
      && probeVerdicts.every(entry => entry.reproduced && entry.closed)
      ? 'authority-closed'
      : 'not-closed',
  }
  writeFileSync(join(OUT, 'operation-authority.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  process.stdout.write(`ef-r1 authority: ${evidence.verdict}\n`)
  process.stdout.write(`  tests ${evidence.suite.passed}/${evidence.suite.required} required passed, failed ${evidence.suite.failed}\n`)
  if (missing.length > 0) process.stdout.write(`  MISSING ${missing.join(' | ')}\n`)
  if (failed.length > 0) process.stdout.write(`  FAILED REQUIRED ${failed.join(' | ')}\n`)
  for (const entry of probeVerdicts) {
    process.stdout.write(`  probe ${entry.name}: reproduced=${entry.reproduced} closed=${entry.closed}\n`)
  }
  if (evidence.verdict !== 'authority-closed') process.exit(1)
}

main()
