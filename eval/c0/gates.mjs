#!/usr/bin/env node
/**
 * EF-C0 convergence gates.
 *
 *   C0-G0  Repository integrity
 *   C0-G1  Configuration truth
 *   C0-G2  Architecture boundary
 *   C0-G3  Evidence consistency
 *   C0-G4  Governance
 *   C0-G5  Roadmap
 *
 * Exit codes follow R37-C:
 *   0  all required gates passed
 *   1  a gate failed
 *   2  no failure, but a gate is blocked / not-executed / not-verifiable
 *
 * A document existing is not a pass. Each gate reads a machine artifact or a
 * test result, and a gate that cannot be verified says so.
 *
 * @module eval/c0/gates
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DATA = join(ROOT, 'docs', 'convergence', 'data')
const DOCS = join(ROOT, 'docs', 'convergence')
const OUT = join(HERE, 'out')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function has(file) {
  return existsSync(join(ROOT, file))
}

function docContains(file, needle) {
  const full = join(ROOT, file)
  return existsSync(full) && readFileSync(full, 'utf8').includes(needle)
}

export function evaluateGates(options = {}) {
  const stageMap = has('docs/convergence/data/git-stage-map.json')
    ? readJson(join(DATA, 'git-stage-map.json')) : null
  const inventory = has('docs/convergence/data/change-inventory.json')
    ? readJson(join(DATA, 'change-inventory.json')) : null
  const manifest = has('docs/convergence/data/artifact-manifest.json')
    ? readJson(join(DATA, 'artifact-manifest.json')) : null
  const configMatrix = has('docs/convergence/data/effective-config-matrix.json')
    ? readJson(join(DATA, 'effective-config-matrix.json')) : null
  const registry = has('docs/convergence/data/evidence-registry.json')
    ? readJson(join(DATA, 'evidence-registry.json')) : null
  const baseline = has('docs/convergence/data/baseline-comparison-manifest.json')
    ? readJson(join(DATA, 'baseline-comparison-manifest.json')) : null
  // The test suite passes a synthetic result so the gate LOGIC is testable
  // without depending on a previous run of the same suite. The CLI uses the
  // real artifact.
  const tests = options.testsOverride
    ?? (has('eval/c0/out/c0-tests.json') ? readJson(join(OUT, 'c0-tests.json')) : null)

  const r38 = git('rev-parse', 'origin/rc38-mechanism-validation')
  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')

  const gates = []

  // ---- C0-G0 -------------------------------------------------------------
  {
    const checks = {
      stageMap: stageMap !== null,
      inventory: inventory !== null && (inventory.files?.length ?? 0) > 0,
      manifest: manifest !== null,
      headMatches: stageMap !== null && r38 !== null && stageMap.head?.sha === r38,
      ancestryComplete: stageMap !== null && (stageMap.ancestry?.checks ?? []).every(row => row.ancestor === true),
      ahead96: stageMap !== null
        && stageMap.ancestry?.mainToR38?.ahead === 96
        && stageMap.ancestry?.mainToR38?.behind === 0,
      archiveMatch: manifest?.externalArchive?.match === true,
      digestsMatch: manifest?.historicalDigests?.allMatch === true,
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
    gates.push({
      id: 'C0-G0',
      name: 'Repository integrity',
      status: failed.length === 0 ? 'passed' : 'failed',
      detail: failed.length === 0
        ? `R38 baseline ${r38?.slice(0, 7)}; ${stageMap.ancestry.checks.length} ancestry checks; `
          + `ahead ${stageMap.ancestry.mainToR38.ahead}; archive and digests match`
        : `failed checks: ${failed.join(', ')}`,
      evidence: 'docs/convergence/data/git-stage-map.json, change-inventory.json, artifact-manifest.json',
    })
  }

  // ---- C0-G1 -------------------------------------------------------------
  {
    const tiers = configMatrix?.summary?.tiersWithRationale ?? []
    const checks = {
      matrix: configMatrix !== null && (configMatrix.rows?.length ?? 0) >= 20,
      allTiersRationale: ['economy', 'balanced', 'quality'].every(name => tiers.includes(name)),
      noTierSemanticNone: (configMatrix?.summary?.tiersWithSemanticNone ?? []).length === 0,
      invalidCombosRejected: (configMatrix?.summary?.invalid ?? 0) >= 2,
      docCurrent: docContains('docs/ARCHITECTURE.md', 'semantic rationale, hint 400'),
      truthDoc: has('docs/convergence/CONFIGURATION_TRUTH.md'),
      testsPassed: tests?.success === true && (tests?.numFailedTests ?? 1) === 0,
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
    gates.push({
      id: 'C0-G1',
      name: 'Configuration truth',
      status: failed.length === 0 ? 'passed' : 'failed',
      detail: failed.length === 0
        ? `${configMatrix.rows.length} scenarios; rationale tiers ${tiers.join(',')}; `
          + `invalid ${configMatrix.summary.invalid}; tests ${tests.numPassedTests}/${tests.numTotalTests}`
        : `failed checks: ${failed.join(', ')}`,
      evidence: 'docs/convergence/data/effective-config-matrix.json, tests/convergence-config.spec.ts',
    })
  }

  // ---- C0-G2 -------------------------------------------------------------
  {
    const checks = {
      boundaryDoc: has('docs/convergence/BOUNDARY_CONTRACTS.md'),
      architectureDoc: has('docs/convergence/ARCHITECTURE_BASELINE.md'),
      contractsListed: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].every(id =>
        docContains('docs/convergence/BOUNDARY_CONTRACTS.md', `## ${id}`)),
      testsPassed: tests?.success === true && (tests?.numFailedTests ?? 1) === 0,
      scopeMatrix: has('docs/convergence/FEATURE_AND_SCOPE_MATRIX.md'),
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
    gates.push({
      id: 'C0-G2',
      name: 'Architecture boundary',
      status: failed.length === 0 ? 'passed' : 'failed',
      detail: failed.length === 0
        ? 'C1-C7 documented; boundary and config suites pass'
        : `failed checks: ${failed.join(', ')}`,
      evidence: 'docs/convergence/BOUNDARY_CONTRACTS.md, tests/convergence-boundaries.spec.ts',
    })
  }

  // ---- C0-G3 -------------------------------------------------------------
  {
    const claims = registry?.claims ?? []
    const productClaims = claims.filter(claim => claim.evidenceLevel === 'Product-level Evidence')
    const productClaimsWellFormed = productClaims.every(claim =>
      [claim.model, claim.route, claim.harness, claim.datasetVersion, claim.scorerVersion]
        .every(value => typeof value === 'string' && value.length > 0 && value !== 'Unknown'))
    const r37b = claims.find(claim => claim.claimId === 'R37B-CONTRACT-HARM')
    const historicalB1 = (baseline?.arms ?? []).find(arm => arm.arm === 'B1-HISTORICAL')
    const checks = {
      registry: claims.length >= 18,
      noMissingArtifacts: (registry?.counts?.missingArtifacts ?? 1) === 0,
      productClaimsWellFormed,
      r37bIsBehavioral: r37b?.evidenceLevel === 'Behavioral Observation',
      b1NotB0: historicalB1 !== undefined && historicalB1.status.includes('NOT equivalent to B0'),
      comparabilityFlags: baseline?.comparability?.historicalB1IsNotB0 === true
        && baseline?.comparability?.mechanismIsNotBehavior === true,
      digestsMatch: manifest?.historicalDigests?.allMatch === true,
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
    gates.push({
      id: 'C0-G3',
      name: 'Evidence consistency',
      status: failed.length === 0 ? 'passed' : 'failed',
      detail: failed.length === 0
        ? `${claims.length} claims; ${registry.counts.missingArtifacts} missing artifacts; `
          + `${productClaims.length} product-level claims; B1 marked not-B0`
        : `failed checks: ${failed.join(', ')}`,
      evidence: 'docs/convergence/data/evidence-registry.json, baseline-comparison-manifest.json',
    })
  }

  // ---- C0-G4 -------------------------------------------------------------
  {
    const checks = {
      governanceDoc: has('docs/convergence/REPOSITORY_GOVERNANCE.md'),
      integrationDoc: has('docs/convergence/PRODUCT_INTEGRATION_PLAN.md'),
      ciDoc: has('docs/convergence/CI_AND_RELEASE_GATES.md'),
      pr4Recorded: docContains('docs/convergence/REPOSITORY_GOVERNANCE.md', 'Open PR #4'),
      m1OnHold: baseline?.r38M1?.status === 'on hold pending convergence',
      refsRecorded: (stageMap?.refsWithoutRemote ?? []).length === 3,
      noUpstream: upstream === null,
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
    gates.push({
      id: 'C0-G4',
      name: 'Governance',
      status: failed.length === 0 ? 'passed' : 'failed',
      detail: failed.length === 0
        ? 'branch roles, push/PR/merge discipline, PR #4, M1 hold recorded; branch has no upstream (not pushed)'
        : `failed checks: ${failed.join(', ')}`,
      evidence: 'docs/convergence/REPOSITORY_GOVERNANCE.md, baseline-comparison-manifest.json',
    })
  }

  // ---- C0-G5 -------------------------------------------------------------
  {
    const checks = {
      roadmapDoc: has('docs/convergence/RESEARCH_ROADMAP.md'),
      milestonesDoc: has('docs/convergence/NEXT_MILESTONES.md'),
      tracks: ['S1', 'S2', 'S3', 'S4'].every(id =>
        docContains('docs/convergence/RESEARCH_ROADMAP.md', `### ${id}`)),
      states: ['Core', 'Optional Semantic', 'Research-only', 'Deferred', 'Deprecated'].every(state =>
        docContains('docs/convergence/FEATURE_AND_SCOPE_MATRIX.md', state)),
      deferredKept: docContains('docs/convergence/FEATURE_AND_SCOPE_MATRIX.md', 'Semantic dependency graph'),
      m1Unchanged: git('diff', '--quiet', 'HEAD', '--', 'docs/semantic-continuity/R38_M1_PREREGISTRATION.md') === '',
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
    gates.push({
      id: 'C0-G5',
      name: 'Roadmap',
      status: failed.length === 0 ? 'passed' : 'failed',
      detail: failed.length === 0
        ? 'S1-S4 present; five scope states present; deferred items kept; R38-M1 file unchanged'
        : `failed checks: ${failed.join(', ')}`,
      evidence: 'docs/convergence/RESEARCH_ROADMAP.md, NEXT_MILESTONES.md, FEATURE_AND_SCOPE_MATRIX.md',
    })
  }

  const failed = gates.filter(gate => gate.status === 'failed')
  const nonPass = gates.filter(gate => gate.status !== 'passed')
  return {
    gates,
    eligibility: {
      evaluated: gates.length,
      passed: gates.filter(gate => gate.status === 'passed').length,
      failed: failed.length,
      nonPass: nonPass.length,
      eligible: failed.length === 0 && nonPass.length === 0,
      failedIds: failed.map(gate => gate.id),
      nonPassIds: nonPass.map(gate => gate.id),
    },
  }
}

export function exitCodeFor(eligibility) {
  if (eligibility.failed > 0) return 1
  return eligibility.nonPass > 0 ? 2 : 0
}

export function runGates() {
  const { gates, eligibility } = evaluateGates()
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    round: 'EF-C0',
    status: eligibility.failed > 0 ? 'failed' : eligibility.eligible ? 'complete' : 'attention',
    eligibility,
    productDecision: 'deployment-hold',
    deploymentEligible: false,
    gates,
    notes: [
      'EF-C0 made no live model call.',
      'A document existing is not a pass.',
      'Mechanism evidence is not product evidence.',
      'No push, merge, rebase, tag or branch deletion was performed.',
    ],
  }
  mkdirSync(DATA, { recursive: true })
  writeFileSync(join(DATA, 'gate-status.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { report, exitCode: exitCodeFor(eligibility) }
}

const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const { report, exitCode } = runGates()
  for (const gate of report.gates) {
    process.stdout.write(`${gate.id} ${gate.status.toUpperCase()}: ${gate.name}\n   ${gate.detail}\n`)
  }
  process.stdout.write(`eligibility ${JSON.stringify(report.eligibility)}\n`)
  process.stdout.write(`product ${report.productDecision}; deploymentEligible ${report.deploymentEligible}\n`)
  process.exit(exitCode)
}
