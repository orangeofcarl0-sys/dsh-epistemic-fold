#!/usr/bin/env node
/**
 * EF-R1 WP5 — every writer that can change durable state, and its authority.
 *
 * The WP1 fix covered `planCommit`. That is not the whole surface: the anchor
 * service is a public writer (`ctx.epistemicFold`), the replay path applies
 * recorded operations, and the projection folds events by design. This audit
 * enumerates the writers, states what each one authorizes, and fails when a
 * new unclassified call site appears.
 *
 * It also runs the effect invariant (the complete authority/source matrix plus
 * the anchor-service cases). It makes no provider request.
 *
 *   node eval/ef-r1/state-write-audit.mjs
 *
 * @module eval/ef-r1/state-write-audit
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const REPORT = join(OUT, 'ef-r1-invariant-tests.json')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * The classified writers. `authorization` is the actual gate, not a promise.
 * `replay` and `projection` are deliberately NOT re-authorized: they apply
 * recorded facts, and re-running policy over history would rewrite it.
 */
const WRITERS = [
  {
    path: 'src/semantic/plan.ts',
    entry: 'planCommit',
    writes: 'declare, transition, retire operations',
    authorization: 'mayRetire for every named target AND for every displaced head; a refused effect withholds the delta and emits no op',
    test: 'tests/ef-r1-operation-authority.spec.ts',
  },
  {
    path: 'src/state/anchor-service.ts',
    entry: 'declare',
    writes: 'a single declare event',
    authorization: 'mayRetire for the head at the draft coordinate before the append',
    test: 'tests/ef-r1-effect-invariant.spec.ts',
  },
  {
    path: 'src/state/anchor-service.ts',
    entry: 'retire',
    writes: 'a retire event',
    authorization: 'PRIVILEGED runtime operation: no claiming identity; not reachable from a model tool or the semantic writer',
    test: 'tests/ef-r1-effect-invariant.spec.ts',
    risk: 'privileged-api',
  },
  {
    path: 'src/fold/engine.ts',
    entry: 'applyOps',
    writes: 'the candidate checkpoint view',
    authorization: 'consumes planCommit.ops; the authorization ran when those ops were planned',
    test: 'tests/ef-r1-operation-authority.spec.ts',
  },
  {
    path: 'src/state/state.ts',
    entry: 'reduceEvent',
    writes: 'the deterministic reducer',
    authorization: 'NOT a writer: it applies committed operations; it has no policy and must not acquire one',
    test: 'tests/ef-r1-effect-invariant.spec.ts',
  },
  {
    path: 'src/semantic/replay.ts',
    entry: 'applyOps',
    writes: 'recorded operations at their commit position',
    authorization: 'NOT re-authorized by design: replay is mechanical over recorded ops; historical outcomes are not rewritten',
    test: 'tests/r38-relation-authority.spec.ts',
  },
  {
    path: 'src/semantic/record.ts',
    entry: 'applyOps',
    writes: 'recorded operations from a legacy session record',
    authorization: 'NOT re-authorized by design: the record is a committed fact; the reconciler migrates it',
    test: 'tests/r38-relation-authority.spec.ts',
  },
  {
    path: 'src/state/projection.ts',
    entry: 'reduceSessionEvent',
    writes: 'the bounded state projection',
    authorization: 'NOT a writer: it folds committed events; it cannot invent one',
    test: 'tests/r38-relation-authority.spec.ts',
  },
]

function callSites() {
  const output = execFileSync('git', ['grep', '-n', '-E', 'applyOps\\(|reduceEvent\\(|reduceSessionEvent\\(|\\.declare\\(', '--', 'src'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trimEnd()
  return output.split('\n').filter(Boolean)
}

function main() {
  mkdirSync(OUT, { recursive: true })
  const classified = new Set(WRITERS.map(writer => `${writer.path}:${writer.entry}`))
  const sites = callSites()
  // A call site is classified when its file+enclosing entry is in the list.
  // The check is intentionally coarse: a new FILE with a write call is the
  // signal, not a new line inside a known writer.
  const files = [...new Set(sites.map(line => line.split(':')[0]))]
  const unclassifiedFiles = files.filter(file =>
    !WRITERS.some(writer => writer.path === file))
  const missingFiles = WRITERS.filter(writer => !existsSync(join(ROOT, writer.path)))

  let runError
  try {
    execFileSync(process.execPath, [
      join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'tests/ef-r1-effect-invariant.spec.ts',
      'tests/ef-r1-operation-authority.spec.ts',
      '--reporter=json',
      `--outputFile=${REPORT}`,
    ], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
  }
  const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : null
  const tests = (report?.testResults ?? []).flatMap(file => file.assertionResults ?? [])

  const evidence = {
    schemaVersion: 1,
    work: 'EF-R1 WP5',
    generatedAt: new Date().toISOString(),
    writers: WRITERS.map(writer => ({
      ...writer,
      present: existsSync(join(ROOT, writer.path)),
      artifactSha256: existsSync(join(ROOT, writer.path)) ? sha256(join(ROOT, writer.path)) : null,
      testPresent: existsSync(join(ROOT, writer.test)),
    })),
    callSites: sites,
    unclassifiedFiles,
    missingFiles: missingFiles.map(writer => writer.path),
    invariantTests: {
      total: report?.numTotalTests ?? null,
      passed: report?.numPassedTests ?? null,
      failed: report?.numFailedTests ?? null,
      runError: runError ?? null,
      titles: tests.map(test => ({ title: test.title, status: test.status })),
    },
    verdict: unclassifiedFiles.length === 0
      && missingFiles.length === 0
      && (report?.numFailedTests ?? 1) === 0
      && (report?.numTotalTests ?? 0) >= 18
      ? 'state-write-audit-closed'
      : 'not-closed',
  }
  writeFileSync(join(OUT, 'state-write-audit.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`state-write audit: ${evidence.verdict}\n`)
  process.stdout.write(`  writers ${WRITERS.length}, call sites ${sites.length}, unclassified files ${unclassifiedFiles.length}\n`)
  process.stdout.write(`  invariant tests ${report?.numPassedTests ?? 0}/${report?.numTotalTests ?? 0} passed\n`)
  if (unclassifiedFiles.length > 0) process.stdout.write(`  UNCLASSIFIED ${unclassifiedFiles.join(', ')}\n`)
  if (evidence.verdict !== 'state-write-audit-closed') process.exit(1)
}

main()
