#!/usr/bin/env node
/**
 * EF-R1 WP5 — the round's claim registry.
 *
 * The C0 registry is a historical document and is not rewritten. This is the
 * EF-R1 companion: one falsifiable sentence per claim, the artifact that
 * supports it, its SHA-256, the commit that owns it, and the limitation that
 * keeps it from being promoted further than it goes.
 *
 * The artifact hash is computed from the worktree. A claim whose artifact is
 * missing or changed after the freeze is reported, not trusted.
 *
 *   node eval/ef-r1/evidence-claims.mjs
 *
 * @module eval/ef-r1/evidence-claims
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const CLAIMS = [
  {
    claimId: 'R1-OPERATION-AUTHORITY',
    claim: 'An assistant decision with no supersedes, or with an unrelated target, can no longer replace a user decision at the same coordinate through validate → plan → apply.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'EF-R1 WP1',
    gitSha: '135124b',
    artifact: 'eval/ef-r1/out/operation-authority.json',
    harness: '16-case matrix; real validator, planner and reducer',
    configuration: 'assistant decision vs user decision; no supersedes, unrelated target, same-packet conflict, mixed source, stale quote',
    datasetVersion: '16 named cases + four before/after probes',
    scorerVersion: 'vitest + explicit verdict',
    limitation: 'Deterministic contract only; it says nothing about model behaviour or product quality. The stale-source rule uses message order, not semantic entailment.',
  },
  {
    claimId: 'R1-STAGE-ATTRIBUTION',
    claim: 'The 96 E2E failures split into 17 produce, 13 write, 12 schema and 5 verify; no failure can be shown to be an observation failure from the recorded text.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'EF-R1 WP2 (re-analysis of EF-E2E)',
    gitSha: 'f03e6ee',
    artifact: 'eval/e2e/out/stage-attribution.json',
    harness: 'offline reconstruction from reports, 25 ordered trajectories and request previews',
    configuration: 'the six E2E campaigns as executed; no new call',
    datasetVersion: '96 executed cells',
    scorerVersion: 'stage-attribution.mjs v1',
    limitation: 'Post hoc. C is unknown in 35 memory-task cells because tool text was truncated; the 12 cells that produced a value with neither visible source are not explained.',
  },
  {
    claimId: 'R1-LOCATOR-CONTRACT',
    claim: 'An archive locator resolves to the archived message it names, distinguishes two reads of one path, refuses a missing bundle, another session and a digest mismatch, and drops an untrusted argument.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'EF-R1 WP3',
    gitSha: 'bd1907d',
    artifact: 'eval/ef-r1/out/locator-contract.json',
    harness: '11-case suite over the real bundle store and recall path',
    configuration: 'archiveLocator on for the contract test; default off',
    datasetVersion: '11 named cases',
    scorerVersion: 'vitest + explicit verdict',
    limitation: 'It proves the address is correct and bounded, not that a model uses it. A three-locator section costs ~169 tokens by chars/4.',
  },
  {
    claimId: 'R1-TASK-CERTIFICATION',
    claim: 'All 22 task instances fail initially, pass with the reference, fail with the counterfactual, and seed above the pressure threshold.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'EF-R1 WP4',
    gitSha: '54d98f9',
    artifact: 'eval/ef-r1/out/task-certification-e2e2.json',
    harness: 'the E2E checker and seed meter',
    configuration: '14 original + 8 new instances',
    datasetVersion: 'T1-T10, two seeds each',
    scorerVersion: 'certify-tasks.mjs',
    limitation: 'Offline certification; the four new templates have never met a model.',
  },
  {
    claimId: 'R1-DESIGN-FROZEN',
    claim: 'The L×G design is 120 cells (6 templates × 2 seeds × 2 replicates × 5 arms) with an 18-cell reserve, frozen and not executed.',
    evidenceLevel: 'Constraint',
    experimentId: 'EF-R1 WP4',
    gitSha: '54d98f9',
    artifact: 'eval/ef-r1/out/ablation-design.json',
    harness: 'zero-request preflight',
    configuration: 'E0, E0-L, E0-G, E0-LG, E1',
    datasetVersion: '12 task instances',
    scorerVersion: 'exact McNemar, planned',
    limitation: 'No authorization and no run. The requested envelope is not granted.',
  },
  {
    claimId: 'R1-RESEARCH-ARCHIVE',
    claim: 'The 96-cell raw evidence is preserved in a 1,224-file, 38 MB package with a verified git bundle and zero credentials found by the scan.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'EF-R1 WP0',
    gitSha: '19532b9',
    artifact: 'eval/e2e/out/research-archive.json',
    harness: 'copy + SHA256SUMS + git bundle verify + credential scan',
    configuration: 'external archive; repository pointer only',
    datasetVersion: '6 campaigns, 96 cells',
    scorerVersion: 'archive-research.mjs',
    limitation: 'The archive is external; the repository carries only its hashes. The scan covers text files, not the compressed bundle.',
  },
  {
    claimId: 'R1-CANDIDATE',
    claim: 'The EF-R1 tarball installs and mounts basic/economy/quality with semantic continuity off, and contains no raw run, credential or checkout path.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'EF-R1 WP5',
    gitSha: 'HEAD',
    artifact: 'eval/ef-r1/out/candidate-build.json',
    harness: 'installed-tarball smoke',
    configuration: 'basic/economy/quality; semantic off',
    datasetVersion: '1,397,673-byte tarball',
    scorerVersion: 'candidate-smoke.mjs',
    limitation: 'Construction and composition only; no provider request and no behavioural claim.',
  },
  {
    claimId: 'R1-NO-LIVE-CALLS',
    claim: 'EF-R1 made zero provider requests and zero remote Git operations.',
    evidenceLevel: 'Constraint',
    experimentId: 'EF-R1',
    gitSha: 'HEAD',
    artifact: 'eval/ef-r1/out/ablation-design.json',
    harness: 'no runner was invoked',
    configuration: 'offline only',
    datasetVersion: 'not applicable',
    scorerVersion: 'not applicable',
    limitation: 'A constraint on this round, not evidence about the product.',
  },
]

function main() {
  mkdirSync(OUT, { recursive: true })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const claims = CLAIMS.map(claim => {
    const path = join(ROOT, claim.artifact)
    const present = existsSync(path)
    return {
      ...claim,
      gitSha: claim.gitSha === 'HEAD' ? head : claim.gitSha,
      artifactPresent: present,
      artifactSha256: present ? sha256(path) : null,
      status: present ? 'current' : 'artifact-missing',
    }
  })
  const output = {
    schemaVersion: 1,
    work: 'EF-R1',
    generatedAt: new Date().toISOString(),
    evaluatedCommit: head,
    claims,
    missing: claims.filter(claim => !claim.artifactPresent).map(claim => claim.claimId),
    note: 'The C0 registry is unchanged. This file adds EF-R1 claims; a missing artifact is reported, never inferred.',
  }
  writeFileSync(join(OUT, 'evidence-claims.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`ef-r1 claims: ${claims.length}, missing ${output.missing.length}\n`)
  for (const claim of claims) {
    process.stdout.write(`  ${claim.claimId} ${claim.status} ${claim.artifactSha256?.slice(0, 12) ?? '-'}\n`)
  }
  if (output.missing.length > 0) process.exit(1)
}

main()
