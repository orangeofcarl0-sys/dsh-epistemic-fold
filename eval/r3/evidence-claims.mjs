#!/usr/bin/env node
/**
 * EF-R3 — the round's claim registry.
 *
 * One falsifiable sentence, the artifact that supports it, its SHA-256, the
 * commit that owns it, and the limitation that keeps it from being promoted
 * further than it goes. The EF-R1 and EF-R2 registries are unchanged.
 *
 *   node eval/r3/evidence-claims.mjs
 *
 * @module eval/r3/evidence-claims
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const OUT = join(HERE, 'out')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const CLAIMS = [
  {
    claimId: 'R3-LEDGER',
    claim: 'The confirm has 23 valid cells, 1 unresolved cell and 30 never-started cells; the 31 no-valid-outcome cells are T13=4, T14=9, T15=9 and T16=9. T13-s1-B0-r2 was transport-failed and then successfully retried, so it is one valid cell, not an invalid cell plus an unexecuted one.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r3/out/live-confirm-reconciliation.json',
    harness: 'immutable manifests, results and reports; Attempt and Unique Cell ledgers',
    limitation: 'A correction of the historical merge arithmetic; no new live call and no historical file rewritten.',
  },
  {
    claimId: 'R3-LEDGER-CONTRACT',
    claim: 'Six synthetic fixtures distinguish failed-then-valid, failed-unresolved, duplicate-valid, partial-usage, never-started and manifest/cell mismatch; the earliest valid attempt decides a cell and transport-failed attempts never enter the denominator.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r3/out/ledger-contract.json',
    harness: '19 assertions over throwaway results/reports',
    limitation: 'Synthetic reports; it proves the identity rule, not model behaviour.',
  },
  {
    claimId: 'R3-TRANSPORT',
    claim: 'Both EF-R2 transport failures are T13/B0. The failed summary of T13-s1-B0-r2 was 75,603 characters and failed in 6 ms; the same cell succeeded on the resume with a 75,603-character summary in 5,858 ms. T13-s2-B0-r1 remains unresolved.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r3/out/transport-diagnosis.json',
    harness: 'raw request logs and the attempt ledger',
    limitation: 'n=2, one local route, no socket identity or keep-alive trace; this is a description, not a provider-level causal estimate.',
  },
  {
    claimId: 'R3-TRANSPORT-CONTRACT',
    claim: 'A local mock server that destroys the socket makes the adapter emit LIVE_TRANSPORT with no usage, and a mid-response reset is never accepted as a silent empty success; partial usage is a valid task outcome with costValid=false.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r3/out/transport-contract.json',
    harness: '13 assertions against a localhost mock; no provider request',
    limitation: 'The real proxy is not in the repository; the contract proves classification, not route stability.',
  },
  {
    claimId: 'R3-CONFIG-DRIFT',
    claim: 'The R2 manifest declared rationaleHintTokens 800, but host.mjs did not forward it, so E1 ran the economy preset value 400. The drift affects 18 confirm E1 cells and 6 pilot E1 cells; the forwarded-config preflight passes and would catch a future mismatch.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r3/out/config-preflight.json',
    harness: 'declared vs effective resolveEfConfig, plus the historical host contract',
    limitation: 'The historical cells are not re-run. A 400-pinned completion is comparable to the 23 valid cells; an 800 or shipped-preset run is a different treatment.',
  },
  {
    claimId: 'R3-SPAN-GAP',
    claim: 'Economic admission prices the widest legal span (retain 0) while execution folds the span left after spec.retainTokens. In a 60-case deterministic matrix the median gap was 516, 2,064 and 3,096 tokens at retain 0.04, 0.16 and 0.24; at the default floors no large-span case flipped, and all 3 floor-sensitivity cases flipped admission=true, execution=false.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r3/out/span-economics.json',
    harness: 'keyless controlled adapter over the real engine and token meter; 60 default-floor cases plus 3 floor-sensitivity cases',
    limitation: 'A keyless matrix, not live model behaviour. The R2 live reports predate the probe, so their exact-span economics is unavailable, not zero.',
  },
  {
    claimId: 'R3-PROBE-NONBEHAVIORAL',
    claim: 'The opt-in exact-span probe is observational: it records widest/executed spans, estimated and actual checkpoint cost, and the surface delta without changing a verdict, span or exception path; the engine self-test report reconciles actual reclaim with the surface delta.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r3/out/span-economics.json',
    harness: 'unit tests plus a scripted E2E self-test',
    limitation: 'The probe is off in product deployments and enabled only by the benchmark harness; it measures, it does not fix the admission/execution mismatch.',
  },
  {
    claimId: 'R3-PRESET-EVIDENCE',
    claim: 'The current economy, balanced and quality tiers are hypotheses for their effective configs. RC1.3 measured the explicit zero-LLM economy profile (semanticMode: none); the current economy tier adds rationale and system-dedup framing, so that result does not transfer.',
    evidenceLevel: 'Constraint',
    artifact: 'eval/r3/out/preset-evidence.json',
    harness: 'TIERS metadata plus resolveEfConfig; 3 tier tests',
    limitation: 'Metadata-only correction; no tier value or product default changed. The underlying RC1.3 result remains valid for the profile it measured.',
  },
  {
    claimId: 'R3-ELIGIBILITY',
    claim: 'Task outcome, treatment exposure and cost completeness are separate. Three confirm cells and three pilot cells have partial usage; only 5/7 confirm B0/E1 pairs and 4/6 pilot pairs are cost-valid, while the recorded 7-pair and 6-pair deltas still reproduce the R2 numbers.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r3/out/product-frontier.json',
    harness: 'per-cell usage, witness summaries and paired task/replicate joins',
    limitation: 'No imputation of missing usage; recorded and cost-valid tables are both reported. The valid confirm subset is task-type biased.',
  },
  {
    claimId: 'R3-USER-NUMBERS',
    claim: 'The user-supplied paired economics are reproduced exactly: pilot E1-B0 = +1 pass, -30 requests, -204,950 uncached input, +43,904 cache read, -25,577 output; confirm = 0, -28, +169,138, -186,496, -18,954.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r3/out/product-frontier.json',
    harness: 'six pilot pairs and seven confirm pairs from the immutable reports',
    limitation: 'The numbers are recorded, not cost-complete; the cost-valid pair deltas differ in magnitude and are reported separately.',
  },
  {
    claimId: 'R3-CONFIRM-TERMINATION',
    claim: 'The old 54-cell confirm is explicitly terminated as a stress-lane result with 23 valid, 1 unresolved and 30 never-started cells; no further live calls will be spent on its non-product treatment. The partial evidence and corrected ledger are preserved.',
    evidenceLevel: 'Analysis Decision',
    artifact: 'eval/r3/out/confirm-termination.json',
    harness: 'the corrected unique-cell ledger and the product decision',
    limitation: 'A decision not to complete a non-product treatment; it is not a claim about what the missing cells would have shown.',
  },
  {
    claimId: 'R3-PRODUCT-DECISION',
    claim: 'The R3 decision is no product candidate and Deployment Hold remains. The confirm is explicitly terminated as a stress-lane result, the paired pass difference is 0 in the confirm, the economics direction is unstable, cost validity is incomplete, and the stress lane is not a shipped preset.',
    evidenceLevel: 'Analysis Decision',
    artifact: 'eval/r3/out/product-decision.json',
    harness: 'the product-frontier report and the eligibility ledger',
    limitation: 'A decision not to promote on current evidence; it is not a claim that E1 is ineffective.',
  },
  {
    claimId: 'R3-ARCHIVE',
    claim: 'The EF-R2 live evidence is archived incrementally: 548 files, 46,853,151 bytes, 43 raw attempts (18 pilot + 25 confirm attempts), 23 valid confirm cells, 2 transport-failed attempts and 30 never-started cells, with zero credentials found and a verified git bundle.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r3/out/research-archive-r2-live.json',
    harness: 'verbatim copy + SHA256SUMS + git bundle verify + credential scan',
    limitation: 'The second copy is another local volume (E:), not an off-machine backup.',
  },
  {
    claimId: 'R3-ARCHIVE-VERIFY',
    claim: 'Both the primary archive and the E: copy match all 548 SHA256SUMS entries and the pointer; the scan found zero credentials.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r3/out/archive-verification-r2-live-copy.json',
    harness: 'eval/e2e/src/verify-archive.mjs against the repository pointer',
    limitation: 'A local copy on a second volume, not an off-machine backup.',
  },
  {
    claimId: 'R3-COMPLETION-DESIGN',
    claim: 'A 31-cell completion design is frozen for the 1 unresolved and 30 never-started cells, interleaved across T13-T16, pinned to the effective R2 config (hint 400), with a new manifest hash and executionAuthorized=false.',
    evidenceLevel: 'Constraint',
    artifact: 'eval/r3/out/completion-design-r3.json',
    harness: 'unique-cell ledger + R2 manifest + protocol amendment',
    limitation: 'Design only. It requires a new explicit authorization and a passing representative transport health probe; unused R2 envelope capacity is not permission.',
  },
  {
    claimId: 'R3-PRODUCT-LANE-DESIGN',
    claim: 'A 72-cell product-representative lane is designed with the shipped economy/balanced/quality configs and a proposed 32k first window; it has no frozen task set, no live data and executionAuthorized=false.',
    evidenceLevel: 'Constraint',
    artifact: 'eval/r3/out/product-lane-design-r3.json',
    harness: 'resolveEfConfig for the shipped presets + stress/product config diff',
    limitation: 'Design only. The R2 tasks need an offline exposure audit at the proposed window, or new instances.',
  },
  {
    claimId: 'R3-PRODUCT-TASK-AUDIT',
    claim: 'At 32k with the shipped economy values, all 16 audited seed surfaces cross the threshold and reach the fold path, and 16 commit at least one fold. The six pilot instances T11-p1 through T16-p1 each commit two folds with no refusal; the R2 T16 stress instances show a retry false admission.',
    evidenceLevel: 'Behavioral Observation',
    artifact: 'eval/r3/out/product-lane-exposure-audit.json',
    harness: 'keyless E2E host, seeded task histories, scripted summarizer, exact-span probe',
    limitation: 'Exposure and the fold path only; the scripted summary is not a live model and task quality is not measured.',
  },
  {
    claimId: 'R3-ADMISSION-CANDIDATE',
    claim: 'The exact-span admission candidate would refuse the 4 audited false admissions (all T16-s1/s2 retries) and has 0 false refusals in the audit. No default change is justified; the product pilot tests the shipped preset as-is.',
    evidenceLevel: 'Analysis Decision',
    artifact: 'eval/r3/out/admission-candidate.json',
    harness: 'the exposure audit probes; candidate = admission on the executed span',
    limitation: 'A single compactIfNeeded call per surface with compactionRetries=1; a candidate refusal would take the rebase handoff, whose final pressure is not simulated.',
  },
  {
    claimId: 'R3-COST-PREFLIGHT',
    claim: 'The historical confirm and pilot each have 3 cost-invalid cells; the product pilot sets strictUsage=true and the runner stops with provider-usage-incomplete on any unknownUsage.',
    evidenceLevel: 'Deterministic Contract',
    artifact: 'eval/r3/out/cost-preflight.json',
    harness: 'the unique-cell ledger, the product manifest, and the runner source',
    limitation: 'The strict-usage rule is enforced for the product pilot; historical runs are not retroactively changed.',
  },
  {
    claimId: 'R3-ZERO-LIVE',
    claim: 'EF-R3 made no provider request: the only new run is a scripted self-test with 0 requests, no new results file was created, and both live designs remain executionAuthorized=false.',
    evidenceLevel: 'Constraint',
    artifact: 'eval/r3/out/zero-live-audit.json',
    harness: 'baseline timestamp + new run/results directory audit',
    limitation: 'A worktree audit, not a network capture; it covers the artifacts this round created.',
  },
  {
    claimId: 'R3-BASELINE',
    claim: 'R3 started at 4affdee on chore/ef-c1-evaluation-foundation with a clean worktree (excluding ignored run output and eval/r3), PR #5 open and the supported CI lane green; all 22 immutable R2 artifacts are present and hashed.',
    evidenceLevel: 'Constraint',
    artifact: 'eval/r3/out/baseline-r3.json',
    harness: 'git/gh metadata + SHA-256 inventory',
    limitation: 'The PR and CI state are a snapshot at the start of R3.',
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
    work: 'EF-R3',
    generatedAt: new Date().toISOString(),
    evaluatedCommit: head,
    claims,
    missing: claims.filter(claim => !claim.artifactPresent).map(claim => claim.claimId),
    note: 'The EF-R1 and EF-R2 registries are unchanged. A missing artifact is reported, never inferred.',
  }
  writeFileSync(join(OUT, 'evidence-claims.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(`ef-r3 claims: ${claims.length}, missing ${output.missing.length}\n`)
  for (const claim of claims) {
    process.stdout.write(`  ${claim.claimId} ${claim.status} ${claim.artifactSha256?.slice(0, 12) ?? '-'}\n`)
  }
  if (output.missing.length > 0) process.exit(1)
}

main()
