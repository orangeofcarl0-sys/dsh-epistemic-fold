#!/usr/bin/env node
/**
 * EF-C1 gates.
 *
 * ## Three booleans, deliberately not one
 *
 *   stageComplete            every C1 gate passed
 *   coreReleaseEligible      stageComplete AND no unresolved real-defect suspect
 *                            AND a supported lane is declared
 *   semanticActiveEligible   ALWAYS false in this round (deployment hold)
 *
 * The brief is explicit that offline completion is not product evidence. A
 * single `eligible` boolean would collapse the three and invite exactly that
 * reading, so the report keeps them apart.
 *
 * ## Exit semantics
 *
 *   0  every gate passed
 *   1  a gate failed (a check ran and said no)
 *   2  a gate is blocked / not-verifiable / not-executed
 *
 * A gate that merely finds its document present is NOT a pass: every gate
 * re-reads the artifact and checks a property inside it.
 *
 * @module eval/c1/gates
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const DATA = join(ROOT, 'docs', 'convergence', 'data')

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined)
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

function gate(id, name, status, detail, evidence) {
  return { id, name, status, detail, evidence }
}

/**
 * Evaluate every gate.
 *
 * @param options.testsOverride - a vitest JSON summary, for the unit test that
 *   exercises pass/fail without running the suite.
 */
export function evaluateGates(options = {}) {
  const tests = options.testsOverride ?? readJson(join(OUT, 'c1-tests.json'))
  const protectedRegistry = readJson(join(OUT, 'protected-artifacts.json'))
  const inventory = readJson(join(OUT, 'side-effect-inventory.json'))
  const accounting = readJson(join(OUT, 'test-accounting.json'))
  const compatibility = readJson(join(OUT, 'dsh-compatibility.json'))
  const basic = readJson(join(OUT, 'basic-compatibility.json'))
  const baseline = readJson(join(OUT, 'core-baseline.json'))
  const readiness = readJson(join(OUT, 'live-readiness.json'))
  const packageJson = readJson(join(ROOT, 'package.json'))
  const reportBaselines = readJson(join(DATA, 'report-baselines.json'))

  const gates = []

  // C1-G0 — Git / baseline integrity
  {
    const head = git(['rev-parse', 'HEAD'])
    const branch = git(['branch', '--show-current'])
    // A round is necessarily dirty while it is being built. What must not move
    // is tracked EVIDENCE: a modified historical artifact is the failure this
    // gate exists to catch, and an uncommitted test file is not.
    const evidenceDirty = git([
      'diff', '--name-only', '--',
      'eval/r31/out', 'eval/r32/out', 'eval/r33/out', 'eval/r35/out', 'eval/r36/out',
      'eval/r37/out', 'eval/r37c/out', 'eval/r37d/out', 'eval/r38/out',
      'docs/convergence/data/git-stage-map.json',
      'docs/convergence/data/artifact-manifest.json',
      'docs/convergence/data/evidence-registry.json',
    ])
    const base = git(['rev-parse', '327598f342dfca4fab2a779442af56a9ab510ece'])
    const r38 = git(['rev-parse', '006702023e8cf2fcdfd4a814e7be5f2ddf3534ec'])
    const checks = {
      branchIsC1: branch === 'chore/ef-c1-evaluation-foundation',
      baseIsC0: base.length === 40,
      r38Reachable: r38.length === 40,
      evidenceClean: evidenceDirty.length === 0,
      head: head.slice(0, 12),
    }
    const ok = checks.branchIsC1 && checks.baseIsC0 && checks.r38Reachable && checks.evidenceClean
    gates.push(gate('C1-G0', 'Git / baseline integrity', ok ? 'passed' : 'failed',
      `branch ${branch}, HEAD ${checks.head}, tracked evidence clean ${checks.evidenceClean}`,
      'git rev-parse / diff'))
  }

  // C1-G1 — Evidence isolation
  {
    const observations = ['post-npm-ci', 'post-r1-report', 'post-r33-arms', 'post-r33-live-entry']
      .map(id => readJson(join(OUT, `observation-${id}.json`)))
    const observed = observations.every(row => row !== undefined && row.drifted === 0)
    const registryClean = protectedRegistry !== undefined && protectedRegistry.counts.driftedFrozen === 0
    const noUncovered = inventory !== undefined && inventory.scan.uncoveredRepoFiles.length === 0
    const testsPass = tests !== undefined && tests.success === true
    const ok = observed && registryClean && noUncovered && testsPass
    gates.push(gate('C1-G1', 'Evidence isolation', ok ? 'passed' : 'failed',
      `post observations ${observations.filter(row => row?.drifted === 0).length}/4 at 0 drift, `
      + `frozen drift ${protectedRegistry?.counts.driftedFrozen ?? 'missing'} `
      + `(generated-config drift ${protectedRegistry?.counts.driftedGenerated ?? 'missing'}), `
      + `${inventory?.scan.uncoveredRepoFiles.length ?? 'missing'} unclassified`, 'eval/c1/out/observation-*.json'))
  }

  // C1-G2 — Test identity accounting
  {
    const arithmetic = accounting?.arithmetic
    const ok = arithmetic !== undefined
      && arithmetic.check === true
      && arithmetic.net === 24
      && arithmetic.added === 33
      && arithmetic.missing === 9
      && packageJson?.devDependencies?.['@deepseek-ai/dsh-agent-loop'] !== undefined
    gates.push(gate('C1-G2', 'Test identity accounting', ok ? 'passed' : 'failed',
      accounting === undefined
        ? 'no accounting file'
        : `net ${arithmetic.net} = added ${arithmetic.added} - missing ${arithmetic.missing}; check ${arithmetic.check}`,
      'eval/c1/out/test-accounting.json'))
  }

  // C1-G3 — DSH compatibility
  {
    const identities = compatibility?.identities
    const failuresClassified = compatibility?.checks !== undefined
      && compatibility.checks.length >= 10
    const ok = identities !== undefined && failuresClassified
      && typeof identities.historicalBasic === 'string'
      && typeof identities.currentHostBasic === 'string'
    gates.push(gate('C1-G3', 'DSH compatibility', ok ? 'passed' : 'failed',
      compatibility === undefined
        ? 'no compatibility fingerprint'
        : `vendor ${compatibility.measured.vendoredDshVersion ?? 'absent'}, `
          + `installed ${compatibility.measured.installedDshVersions.join(',')}, `
          + `declared ${compatibility.declared.dshLine.join(',')}`,
      'eval/c1/out/dsh-compatibility.json'))
  }

  // C1-G4 — Basic compatibility
  {
    const cases = basic?.arms ?? []
    const arms = new Set(cases.map(row => row.arm))
    const ok = arms.has('B0') && arms.has('Bv') && cases.length >= 10
      && cases.filter(row => row.case === 'parity').length === 2
      && cases.filter(row => row.case === 'abort').every(row => row.checkpoints === 0)
    gates.push(gate('C1-G4', 'Basic compatibility', ok ? 'passed' : 'failed',
      `${cases.length} case(s), arms ${[...arms].join('/')}, parity ${cases.filter(row => row.case === 'parity').length}/2`,
      'eval/c1/out/basic-compatibility.json'))
  }

  // C1-G5 — EF minimal / rationale calibration
  {
    const arms = baseline?.arms ?? []
    const e0 = arms.find(row => row.arm === 'E0')
    const e1 = arms.find(row => row.arm === 'E1')
    const b0 = arms.find(row => row.arm === 'B0')
    const bv = arms.find(row => row.arm === 'Bv')
    const ok = e0 !== undefined && e1 !== undefined
      && e0.calls === 0
      && e1.calls === 1
      && e1.rationaleCalls === 1
      && e1.writerCalls === 0
      && JSON.stringify(e0.legalSpan) === JSON.stringify(e1.legalSpan)
      && b0 !== undefined && bv !== undefined
      && b0.checkpointChars === bv.checkpointChars
      && b0.prefixFingerprint === bv.prefixFingerprint
    gates.push(gate('C1-G5', 'EF minimal / rationale calibration', ok ? 'passed' : 'failed',
      `E0 calls ${e0?.calls ?? '?'}, E1 calls ${e1?.calls ?? '?'} (rationale ${e1?.rationaleCalls ?? '?'}), `
      + `B0/Bv body ${b0?.checkpointChars ?? '?'}/${bv?.checkpointChars ?? '?'}`,
      'eval/c1/out/core-baseline.json'))
  }

  // C1-G6 — Live readiness
  {
    const ok = readiness !== undefined
      && readiness.status === 'not-authorized'
      && readiness.providerCalls === 0
      && readiness.manifest === null
    gates.push(gate('C1-G6', 'Live readiness', ok ? 'passed' : 'failed',
      readiness === undefined
        ? 'no readiness file'
        : `${readiness.status}, ${readiness.providerCalls} provider calls, ${readiness.blocking.length} blocking condition(s)`,
      'eval/c1/out/live-readiness.json'))
  }

  // C1-G7 — Product / research separation
  {
    const changed = git(['diff', '--name-only', '327598f342dfca4fab2a779442af56a9ab510ece', '--', 'src/semantic'])
    const statuses = reportBaselines?.reports?.map(row => row.status) ?? []
    const semanticArms = (baseline?.arms ?? []).filter(row => row.arm === 'E0' || row.arm === 'E1')
    const ok = changed.length === 0
      && semanticArms.length === 2
      && semanticArms.every(row => row.semanticContinuity === 'off')
      && statuses.every(status => ['current', 'stale', 'superseded'].includes(status))
    gates.push(gate('C1-G7', 'Product / research separation', ok ? 'passed' : 'failed',
      changed.length === 0
        ? `src/semantic unchanged since C0; E0/E1 continuity ${semanticArms.map(row => row.semanticContinuity).join('/') || 'missing'}`
        : `src/semantic changed: ${changed}`,
      'git diff + core-baseline.json'))
  }

  const eligibility = {
    evaluated: gates.length,
    passed: gates.filter(row => row.status === 'passed').length,
    failed: gates.filter(row => row.status === 'failed').length,
    nonPass: gates.filter(row => !['passed', 'failed'].includes(row.status)).length,
    failedIds: gates.filter(row => row.status === 'failed').map(row => row.id),
    nonPassIds: gates.filter(row => !['passed', 'failed'].includes(row.status)).map(row => row.id),
  }

  return {
    schemaVersion: 1,
    work: 'EF-C1',
    generatedAt: new Date().toISOString(),
    sourceCommit: git(['rev-parse', 'HEAD']),
    gates,
    eligibility: {
      ...eligibility,
      stageComplete: eligibility.failed === 0 && eligibility.nonPass === 0,
    },
    decisions: {
      // Offline completion does not equal product evidence.
      coreReleaseEligible: false,
      coreReleaseReason: 'C1 is offline-only: no product-quality experiment has been run, and eval-corpus B04 is unresolved',
      // Deployment hold is not lifted by an offline result.
      semanticActiveEligible: false,
      semanticActiveReason: 'EF Active: deployment hold; decision authority is unsplit and no live experiment is authorized',
    },
    product: {
      deploymentEligible: false,
      decision: 'deployment-hold',
    },
  }
}

export function exitCodeFor(eligibility) {
  if (eligibility.failed > 0) return 1
  if (eligibility.nonPass > 0) return 2
  return 0
}

export function runGates() {
  const report = evaluateGates()
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'gate-status.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  for (const row of report.gates) {
    process.stdout.write(`${row.id}  ${row.status.padEnd(14)} ${row.name} — ${row.detail}\n`)
  }
  process.stdout.write(
    `stageComplete ${report.eligibility.stageComplete}, coreReleaseEligible ${report.decisions.coreReleaseEligible}, `
    + `semanticActiveEligible ${report.decisions.semanticActiveEligible}\n`,
  )
  return { report, exitCode: exitCodeFor(report.eligibility) }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const { exitCode } = runGates()
  process.exit(exitCode)
}
