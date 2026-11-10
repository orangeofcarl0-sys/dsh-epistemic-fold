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
    limitation: 'Post hoc. C is unknown in 35 of the 96 memory-task cells because tool text was truncated; 5 cells produced a value with no visible source in tool, checkpoint or prompt. New runs capture full primary messages, so C is decidable.',
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
    limitation: 'Certification is offline. The four new templates then ran; T10 was found ambiguous during the pilot, fixed and re-certified, but the confirm used the pre-fix version and its T10 cells are excluded.',
  },
  {
    claimId: 'R1-DESIGN-FROZEN',
    claim: 'The L×G design was frozen as 120 cells (6 templates × 2 seeds × 2 replicates × 5 arms) with an 18-cell reserve, then executed under a separate 138-cell grant.',
    evidenceLevel: 'Constraint',
    experimentId: 'EF-R1 WP4/WP5',
    gitSha: '54d98f9',
    artifact: 'eval/ef-r1/out/ablation-design.json',
    harness: 'zero-request preflight, then the native host',
    configuration: 'E0, E0-L, E0-G, E0-LG, E1',
    datasetVersion: '12 task instances',
    scorerVersion: 'exact McNemar, pre-registered',
    limitation: 'The design is the pre-registration; the execution and its T10 exclusion are recorded in ablation-analysis.json.',
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
    datasetVersion: 'final rebuilt tarball',
    scorerVersion: 'candidate-smoke.mjs',
    limitation: 'Construction and composition only; no provider request and no behavioural claim.',
  },
  {
    claimId: 'R1-ABLATION',
    claim: 'In the 120-cell L×G campaign, E0 9/24, E0-L 15/24, E0-G 15/24, E0-LG 16/24 and E1 18/24 passed; excluding the defective T10 fixture, no L/G arm is significant at 0.05.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'EF-R1 L×G confirm',
    gitSha: 'HEAD',
    artifact: 'eval/ef-r1/out/ablation-analysis.json',
    harness: 'native E2E host, 6 templates × 2 seeds × 2 replicates × 5 arms',
    configuration: 'E0, E0-L, E0-G, E0-LG, E1; 16,384-token operational budget',
    datasetVersion: '120 cells; T10 excluded from the primary estimate',
    scorerVersion: 'task checker + exact McNemar',
    limitation: 'One model, one route, one machine; 10-12 task instances per comparison. The task prompt was folded in 44/120 cells, so the L/G estimate is confounded by task recovery.',
  },
  {
    claimId: 'R1-TASK-PROMPT-FOLD',
    claim: 'The active task prompt was archived during the continuation in 44 of 120 confirmatory cells (27 of 100 excluding T10).',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'EF-R1 L×G confirm',
    gitSha: 'HEAD',
    artifact: 'eval/ef-r1/out/ablation-analysis.json',
    harness: 'first/last primary request inspection',
    configuration: '16,384-token operational budget',
    datasetVersion: '120 cells',
    scorerVersion: 'stage-attribution.mjs',
    limitation: 'Measured from the recorded primary requests; a checkpoint that paraphrases the prompt is not counted as the prompt. The rate may differ at another budget.',
  },
  {
    claimId: 'R1-STATE-WRITE-AUDIT',
    claim: 'Eight state writers are classified and the 180-pair authority/source invariant passes: a displaced head is exactly a mayRetire-allowed replacement.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'EF-R1 WP5',
    gitSha: 'HEAD',
    artifact: 'eval/ef-r1/out/state-write-audit.json',
    harness: 'source audit + 18 tests',
    configuration: 'all writers under src/',
    datasetVersion: '180 authority/source pairs',
    scorerVersion: 'exact enumeration',
    limitation: 'The privileged anchor-service retire remains a runtime operation with no claiming identity; it is classified, not removed.',
  },
  {
    claimId: 'R1-COMBINED-ARCHIVE',
    claim: 'The combined 240-cell research archive has 3,018 files, a verified git bundle, zero credentials, and a second verified copy on another local volume.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'EF-R1 WP0 follow-up',
    gitSha: 'HEAD',
    artifact: 'eval/ef-r1/out/research-archive-r1.json',
    harness: 'copy + SHA256SUMS + bundle verify + credential scan',
    configuration: 'external archive; repository pointer only',
    datasetVersion: '8 campaigns, 240 cells',
    scorerVersion: 'archive-research.mjs + verify-archive.mjs',
    limitation: 'The second copy is another volume on this machine, not an off-machine backup.',
  },
  {
    claimId: 'R1-T10-RETEST',
    claim: 'With the fixed T10 fixture, E0 0/2, E0-L 0/2, E0-G 2/2, E0-LG 1/2 and E1 2/2 passed.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'EF-R1 T10 retest',
    gitSha: 'HEAD',
    artifact: 'eval/e2e/out/results-e2e-t10-retest-1.json',
    harness: '10 cells inside the confirm envelope reserve',
    configuration: 'fixed T10, one replicate, five arms',
    datasetVersion: '10 cells',
    scorerVersion: 'task checker',
    limitation: 'n=2 per arm; a fault retest, not a powered estimate. E0-L fails with task-prompt loss; E0-LG once writes a wrong shape.',
  },
  {
    claimId: 'R1-CAMPAIGN-AUTHORIZATION',
    claim: 'The 24-cell pilot, 120-cell confirm and 10-cell T10 retest ran under two separate grants and none exceeded its request/token/time caps.',
    evidenceLevel: 'Constraint',
    experimentId: 'EF-R1 campaigns',
    gitSha: 'HEAD',
    artifact: 'eval/e2e/out/results-e2e-lg-confirm-1.json',
    harness: 'runner budget ledger',
    configuration: 'pilot 32-cell cap; confirm 138-cell cap, retest from its reserve',
    datasetVersion: '154 new cells',
    scorerVersion: 'runner usage report',
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
