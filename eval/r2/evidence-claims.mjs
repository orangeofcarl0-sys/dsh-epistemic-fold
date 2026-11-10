#!/usr/bin/env node
/**
 * EF-R2 WP5 — the round's claim registry.
 *
 * One falsifiable sentence per claim, the artifact that supports it, its
 * SHA-256, the commit that owns it, and the limitation that keeps it from
 * being promoted further than it goes. This complements, and never rewrites,
 * `eval/ef-r1/out/evidence-claims.json`.
 *
 *   node eval/r2/evidence-claims.mjs
 *
 * @module eval/r2/evidence-claims
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
    claimId: 'R2-WITNESS-CONTRACT',
    claim: 'The witness distinguishes an attempt, a produced body, a surface replacement and a later-request delivery in seven contract scenarios, including the cases where a bundle is durable but the surface is unchanged.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r2/out/witness-contract.json',
    harness: '30 assertions over real FileBundleStore files and synthetic event logs',
    limitation: 'Synthetic events and a real bundle store; it says nothing about model behaviour.',
  },
  {
    claimId: 'R2-WITNESS-HISTORY',
    claim: 'Across 290 archived cells the witness finds 753 attempts, 673 committed, 62 refused, 6 aborted and 12 unverifiable; 12 cells had a legacy fold count higher than the committed count.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r2/out/compaction-witnesses.json',
    harness: 'offline reconstruction from reports, raw requests, full messages and bundle directories',
    limitation: 'Archived failures link an orphan bundle to an attempt by order (inferred); Basic has no EF bundle and no per-attempt delivery evidence.',
  },
  {
    claimId: 'R2-E1-ATTRIBUTION',
    claim: 'The 42 E1 attempts split into 11 committed and 31 refused; every refusal reached the shrink check, every rationale call finished with a non-empty body, and no provider or bundle error appears.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r2/out/rationale-failure-attribution.json',
    harness: 'per-attempt join of report errors, auxiliary calls and verified orphan bundles',
    limitation: 'The E1 arm ran leafAdmission legacy; this is not the shipped tier configuration.',
  },
  {
    claimId: 'R2-PRECALL-DECISION',
    claim: 'The state-only checkpoint body is 12 estimated tokens in every failed E1 attempt while the span is 58-207 tokens, so a pre-call shrink guard is not justified; retry suppression is also not justified because two retried cells committed after folding a ~9.2k-token span.',
    evidenceLevel: 'Analysis Decision',
    artifact: 'eval/r2/out/rationale-failure-attribution.json',
    harness: 'state-only rendering from the verified orphan bodies; retry spans from the committed bundles',
    limitation: 'The archived failed attempts do not retain their span seqs, so a same-span refusal cache cannot be tested on this data. The economic-admission mismatch is a hypothesis, not a measured fix.',
  },
  {
    claimId: 'R2-TIER-DIVERGENCE',
    claim: 'The 120-cell E1 arm ran with leafAdmission legacy because the E2E host does not pass that key, while all three shipped tiers set leafAdmission economic; the arm is therefore not the shipped economy tier.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r2/out/baseline.json',
    harness: 'source/default audit plus the frozen host config',
    limitation: 'The audit proves the config difference. It does not measure what economic admission would have done on these cells.',
  },
  {
    claimId: 'R2-TASK-DELIVERY',
    claim: 'The legacy 44/120 prompt-loss number is reproduced, but only 2/120 cells end with neither the task text nor the task values; 5 carry the request text in a checkpoint copy and 38 carry the task values without the wording.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r2/out/active-task-delivery.json',
    harness: 'per-primary-request digest matrix; 194 cells with full messages, 96 preview-only for prefix checks',
    limitation: 'Values-only proves the task facts survived, not that the instruction wording or its constraints did.',
  },
  {
    claimId: 'R2-E1-COVARIATE',
    claim: 'The two E1 cells whose exact task message was lost still carried the task values in a checkpoint; their 0/2 pass rate is not explained by information absence.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r2/out/active-task-delivery.json',
    harness: 'exact digest and value probes in the last primary request',
    limitation: 'n=2; a description, not an effect.',
  },
  {
    claimId: 'R2-CAUSAL',
    claim: 'The confirm reproduces E1 18/24, with 11 committed-and-delivered cells (9 pass) and 13 no-fold cells (9 pass); all eight T2/T4 E1 cells committed, delivered a checkpoint carrying both probes, and passed.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r2/out/causal-reanalysis.json',
    harness: 'ITT plus witness and delivery joins; exact McNemar reproduction',
    limitation: 'The committed/no-fold split is descriptive, not randomized. One model, route and machine; no product claim.',
  },
  {
    claimId: 'R2-COST',
    claim: 'The cost ledger reconciles with the campaign budget; E1 spent 7,083 input and 7,890 output tokens on 31 undelivered calls (47.2% of its output), of which 16 repeated calls cost 3,510 and 4,241.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r2/out/cost-ledger.json',
    harness: 'per-cell report usage and per-attempt auxiliary usage',
    limitation: 'Observed costs, not a counterfactual; no verifiable USD price is recorded.',
  },
  {
    claimId: 'R2-AUTHORITY',
    claim: 'The mixed-origin attack that the old inputs allowed is refused after the fix: the newest decision-capable citation determines the origin, and AnchorService.declare derives the producer and refuses a disagreeing label before the append.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r2/out/authority-closure.json',
    harness: 'real validator/planner plus the v2 anchor service; 12 regression tests',
    limitation: 'The rule is conservative: a user decision that cites a newer assistant restatement is refused rather than reclassified.',
  },
  {
    claimId: 'R2-ARCHIVE',
    claim: 'The post-R1 evidence is preserved incrementally: 50 valid new cells plus 8 invalid negative-evidence cells in 787 files, verified on two local volumes with a verified git bundle and zero credentials.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r2/out/research-archive-r2.json',
    harness: 'copy + SHA256SUMS + bundle verify + credential scan',
    limitation: 'The second copy is another local volume, not an off-machine backup.',
  },
  {
    claimId: 'R2-DESIGN',
    claim: 'A 72-cell B0/E0/E1 design is frozen with 12 offline-certified new instances, a 36/36 zero-request preflight, the corrected economic-admission config, and executionAuthorized false.',
    evidenceLevel: 'Constraint',
    artifact: 'eval/r2/out/live-design-r2.json',
    harness: 'offline task certification + scripted zero-request preflight',
    limitation: 'The preflight is a wiring test, not model behaviour. No live call is authorized; the envelope is a proposal.',
  },
  {
    claimId: 'R2-CANDIDATE',
    claim: 'The EF-R2 tarball installs and mounts basic/economy/quality with semantic continuity off; 13/13 smoke checks pass and the package contains no raw run, credential or checkout path.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r2/out/candidate-build.json',
    harness: 'installed-tarball smoke against a throwaway host',
    limitation: 'Construction and composition only; no provider request. The local pack reports the rc7 preset drift because the installed DSH differs from the pinned CI reference.',
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
      gitSha: head,
      artifactPresent: present,
      artifactSha256: present ? sha256(path) : null,
      status: present ? 'current' : 'artifact-missing',
    }
  })
  const output = {
    schemaVersion: 1,
    work: 'EF-R2',
    generatedAt: new Date().toISOString(),
    evaluatedCommit: head,
    claims,
    missing: claims.filter(claim => !claim.artifactPresent).map(claim => claim.claimId),
    note: 'The EF-R1 registry is unchanged. This file adds the EF-R2 claims; a missing artifact is reported, never inferred.',
  }
  writeFileSync(join(OUT, 'evidence-claims.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`ef-r2 claims: ${claims.length}, missing ${output.missing.length}\n`)
  for (const claim of claims) {
    process.stdout.write(`  ${claim.claimId} ${claim.status} ${claim.artifactSha256?.slice(0, 12) ?? '-'}\n`)
  }
  if (output.missing.length > 0) process.exit(1)
}

main()
