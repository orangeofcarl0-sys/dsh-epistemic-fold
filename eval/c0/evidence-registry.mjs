#!/usr/bin/env node
/**
 * EF-C0 WP4 — claim-level evidence registry and baseline comparison manifest.
 *
 * The claims are CURATED; the artifact identity is COMPUTED. A claim whose
 * artifact is missing or whose recorded hash no longer matches is reported as
 * `artifact-missing` / `artifact-changed`, not silently trusted.
 *
 * Unknown metadata stays `Unknown`. The brief is explicit: if a field cannot
 * be confirmed, mark it Unknown rather than infer it.
 *
 * @module eval/c0/evidence-registry
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DATA = join(ROOT, 'docs', 'convergence', 'data')
const OUT = join(HERE, 'out')

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const exists = path => existsSync(join(ROOT, path))

/**
 * Evidence levels, strongest to weakest, plus two non-evidence classes:
 * `Decision` (a governance outcome) and `Constraint` (a contract that is true
 * by construction). Neither is a measurement and neither is promoted.
 */
const LEVELS = [
  'Deterministic Contract',
  'Mechanism Certified',
  'Behavioral Observation',
  'Product-level Evidence',
  'Hypothesis',
  'Invalid / Superseded',
  'Decision',
  'Constraint',
]

const CLAIMS = [
  {
    claimId: 'RC13-QUALITY',
    claim: 'On the RC1.3 retrieval probe, economy with semanticMode none matched Basic\'s measured quality (3.00/3) after the retrieval-ergonomics fix.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'RC1.3 / RC1.3.1',
    gitSha: 'f29b6ae',
    model: 'Unknown',
    route: 'Unknown',
    harness: 'RC1.3 retrieval probe, one window, n=9 per arm',
    configuration: 'economy; semanticMode none; retrieval hint in the framing section',
    datasetVersion: 'one probe: three facts in one message',
    scorerVersion: '0-3 fact score (RC1.3)',
    rawArtifact: 'docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md',
    resultSummary: 'un-hinted 2.33/3 -> 3.00/3 (run A), 3.00/3 (run B); hinted unchanged; economy-none matches Basic on this probe.',
    limitations: 'n small, one probe shape, one route. The 2.33 -> 3.00 step rests on 2 of 9 runs. Model/route not recorded in the document.',
    status: 'current for the zero-LLM config; NOT transferable to today\'s economy tier, which makes one rationale call per fold',
  },
  {
    claimId: 'RC13-COST',
    claim: 'On the n=5 RC1.2 sample, economy-none cost about 0.00166 per run against Basic\'s 0.02778, roughly 17x cheaper at equal measured quality.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'RC1.3 (cost sample carried from RC1.2)',
    gitSha: 'f29b6ae',
    model: 'Unknown',
    route: 'Unknown',
    harness: 'RC1.2/RC1.3 sample, n=5',
    configuration: 'economy; semanticMode none; no auxiliary calls',
    datasetVersion: 'RC1.2 sample',
    scorerVersion: 'RC1.3 quality probe',
    rawArtifact: 'docs/22_RC1_3_RETRIEVAL_ERGONOMICS.md',
    resultSummary: '0.00166 vs 0.02778 per run; cost gate remains OPEN.',
    limitations: 'n=5, one route, one price list, no cache-separation analysis recorded. Does not include a rationale call, so it does not describe today\'s economy tier.',
    status: 'current for the zero-LLM config only',
  },
  {
    claimId: 'CORE-TRANSACTION',
    claim: 'A fold writes its CheckpointBundle before the lossy surface replacement commits; an archive failure aborts the transaction.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'EF Core transaction suite',
    gitSha: '0067020',
    model: 'none',
    route: 'none',
    harness: 'Vitest, real engine, scripted adapter',
    configuration: 'all modes',
    datasetVersion: 'fixtures',
    scorerVersion: 'n/a',
    rawArtifact: 'src/fold/engine.ts',
    resultSummary: 'the publish path writes the bundle before returning the summary to Basic.',
    limitations: 'A test suite proves the code path, not a production crash-consistency rate.',
    status: 'current',
  },
  {
    claimId: 'R33-LIVE-NOT-EXECUTED',
    claim: 'R33\'s live evaluation was not executed: no budget permission and no resolved route; 0 provider requests.',
    evidenceLevel: 'Constraint',
    experimentId: 'R33 live',
    gitSha: 'ad3020d',
    model: 'none',
    route: 'none',
    harness: 'live gate + scripted self-test',
    configuration: 'n/a',
    datasetVersion: 'r33-semantic-continuity-v2',
    scorerVersion: 'v2 (later v3)',
    rawArtifact: 'docs/semantic-continuity/R33_LIVE_EVALUATION.md',
    resultSummary: 'exit 3, not-executed; 17/17 scripted self-test proves plumbing only.',
    limitations: 'No behavioral claim is available from R33. The generated eval/r33/out/live-report.json is rewritten by the test suite, so the committed document is the stable artifact.',
    status: 'current',
  },
  {
    claimId: 'R34-NO-REAL-MODEL',
    claim: 'R34 has no real-model result; its 68/68 four-arm self-test is a plumbing result.',
    evidenceLevel: 'Constraint',
    experimentId: 'R34',
    gitSha: '8db92f4',
    model: 'none',
    route: 'none',
    harness: 'real host, scripted model',
    configuration: 'four arms',
    datasetVersion: 'r33-semantic-continuity-v2',
    scorerVersion: 'v2',
    rawArtifact: 'docs/semantic-continuity/R34_REAL_MODEL_RESULTS.md',
    resultSummary: '0 provider requests; 68/68 valid and task success under a scripted adapter.',
    limitations: 'Not model behavior.',
    status: 'current',
  },
  {
    claimId: 'R35-WRITER-RECALL',
    claim: 'The real writer extracted facts, but the automatic exact scorer reported 0 recall because the model paraphrased and used its own coordinates.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'R35 writer-only',
    gitSha: '914ed31',
    model: 'deepseek-v4.1-flash',
    route: 'https://opencode.ai/zen/go/v1',
    harness: 'R35 writer harness',
    configuration: 'semantic writer, 16 scored outputs',
    datasetVersion: 'r33-semantic-continuity-v2',
    scorerVersion: 'v2',
    rawArtifact: 'docs/semantic-continuity/R35_WRITER_RESULTS.md',
    resultSummary: '16 scored outputs; automatic recall 0; manual adjudication found the facts were present but paraphrased.',
    limitations: 'Scorer-coordinate mismatch, not a writer coverage result. One model/route.',
    status: 'superseded as a recall measurement by the R36/R37 scorer corrections',
  },
  {
    claimId: 'R36-INTERFACE',
    claim: 'R36 ran 845 provider requests and aligned the W1 writer contract with the validator; the B1/S comparison is exploratory.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'R36',
    gitSha: 'b8274bb',
    model: 'deepseek-v4.1-flash',
    route: 'local ZCode proxy 127.0.0.1:7866 (provider c15ab109)',
    harness: 'custom tool loop, W0/W1',
    configuration: 'writer W0 vs W1; continuation',
    datasetVersion: 'r33-semantic-continuity-v2 (digest 407148f0...)',
    scorerVersion: 'v3',
    rawArtifact: 'docs/semantic-continuity/R36_HANDOFF.md',
    resultSummary: '12 writer + 833 continuation requests; W1 is the better writer contract.',
    limitations: 'Exploratory; one model/route; harness floor documented separately.',
    status: 'current as an interface result, not as a product benefit',
  },
  {
    claimId: 'R37B-CONTRACT-HARM',
    claim: 'Under the R37-B Stage 2 conditions, the Active arm showed a negative contract difference: 9 damage vs 1 rescue over 36 pairs.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'R37-B Stage 2',
    gitSha: '5ef6781',
    model: 'deepseek-v4.1-flash',
    route: 'local omnigate2api, http://127.0.0.1:7866/v1',
    harness: 'H-protocol-e / P3e, custom six-case harness',
    configuration: 'Active (S) vs B1 (EF Basic arm)',
    datasetVersion: 'A1-v2, D1-v2, B2, C1, F1, H1; 6 replicates',
    scorerVersion: 'R37-B scorer (version not recorded as a single field)',
    rawArtifact: 'eval/r37/out/r37b-stage2-results.json',
    resultSummary: '36 pairs: contract rescue 1, damage 9, both 17, neither 9; task rescue 2, damage 7, both 20, neither 7.',
    limitations: 'Custom harness; B1 is NOT Native DSH Basic; protocol confounds; case-clustered; one model/route; Stage 1 not pooled.',
    status: 'current: Active not supported under these conditions; a harm signal, not a population estimate',
  },
  {
    claimId: 'R37C-MEASUREMENT-CORRECTION',
    claim: 'The semantic funnel metric overstated commit/recall; the corrected measurement separates pipeline, writer and scorer effects.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'R37-C C0-B/C0-C',
    gitSha: '045cccf',
    model: 'n/a',
    route: 'n/a',
    harness: 'artifact re-analysis',
    configuration: 'historical R36/R37 artifacts',
    datasetVersion: 'R36/R37 frozen artifacts',
    scorerVersion: 'corrected funnel',
    rawArtifact: 'eval/r37c/out/measurement-vs-pipeline.json',
    resultSummary: 'the correction is recorded; earlier recall numbers are not reused.',
    limitations: 'A measurement correction, not a new behavioral result.',
    status: 'current; supersedes the earlier funnel numbers',
  },
  {
    claimId: 'R37C-C1D-NOT-VERIFIABLE',
    claim: 'R37-C gate C1-D (Stage 1 admission) is gate-not-verifiable; Stage 1 cannot be used as a confirmatory batch.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'R37-C gates',
    gitSha: '045cccf',
    model: 'n/a',
    route: 'n/a',
    harness: 'gate evaluation',
    configuration: 'n/a',
    datasetVersion: 'n/a',
    scorerVersion: 'n/a',
    rawArtifact: 'eval/r37c/out/gate-status-r37c.json',
    resultSummary: '9 passed, 0 failed, 1 non-pass (C1-D); product deployment-hold.',
    limitations: 'Historical; not repaired by a new threshold.',
    status: 'current',
  },
  {
    claimId: 'R37D-PROCESS-PILOT',
    claim: 'The 24-cell process pilot completed with 17/24 legacy contract, 17/24 operational completion and 8/24 strict finish; the process sentence helps D1 and hurts B2.',
    evidenceLevel: 'Behavioral Observation',
    experimentId: 'R37-D process pilot',
    gitSha: '7a2c974',
    model: 'deepseek-v4.1-flash',
    route: 'Unknown (not recorded in the pilot artifact)',
    harness: 'custom-json-loop, P3s, scorer v3',
    configuration: 'B1/S x P0/P1; finish guard off; step budget 8',
    datasetVersion: 'B2, D1-v2; 3 replicates per condition',
    scorerVersion: 'v3',
    rawArtifact: 'eval/r37d/out/process-pilot-results.json',
    resultSummary: '24/24 cells; legacy 17; operational 17; strict finish 8; B2 P0 5/6 -> P1 3/6; D1 P0 3/6 -> P1 6/6.',
    limitations: 'Exploratory; 3 replicates; one model; two cases; route not recorded; the process prompt is not a uniform fix.',
    status: 'current, exploratory',
  },
  {
    claimId: 'R38-RELATION-AUTHORITY',
    claim: 'A tool-grounded finding cannot retire a user constraint: the claim is accepted and the retirement is refused with insufficient-authority.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'R38-M0 WP1',
    gitSha: '0067020',
    model: 'none',
    route: 'none',
    harness: 'real validate/plan/apply path',
    configuration: 'semantic continuity active',
    datasetVersion: '8 relation fixtures',
    scorerVersion: 'n/a',
    rawArtifact: 'eval/r38/out/relation-security-audit.json',
    resultSummary: '8/8 scenarios; pre-fix reproduction retired the constraint; post-fix it stays active.',
    limitations: 'Mechanism only; no live writer. The decision authority domain still does not distinguish a user decision from an assistant decision.',
    status: 'current',
  },
  {
    claimId: 'R38-REVISION-IDENTITY',
    claim: 'Claim identity is separate from revision identity: the same claim with a new supersession plan has the same deltaId and can contribute its operations; an exact repeat is refused.',
    evidenceLevel: 'Deterministic Contract',
    experimentId: 'R38-M0 WP1',
    gitSha: '0067020',
    model: 'none',
    route: 'none',
    harness: 'real validate/plan/apply/replay path',
    configuration: 'semantic continuity active',
    datasetVersion: '7 idempotency checks',
    scorerVersion: 'n/a',
    rawArtifact: 'eval/r38/out/revision-idempotency.json',
    resultSummary: '7/7; replay once matches; a double application is detected by the commit-state digest.',
    limitations: 'The reducer is idempotent for declares; the once-only boundary is the commit digest, not the reducer.',
    status: 'current',
  },
  {
    claimId: 'R38-N5',
    claim: 'N5 is reproducible and detected: an incomplete revision leaves the rejected outbox active and the auditor reports stale-negative-knowledge; a complete revision clears it.',
    evidenceLevel: 'Mechanism Certified',
    experimentId: 'R38-M0 WP2',
    gitSha: '0067020',
    model: 'none',
    route: 'none',
    harness: 'read-only auditor over packets',
    configuration: 'n/a',
    datasetVersion: '9 audit cases',
    scorerVersion: 'n/a',
    rawArtifact: 'eval/r38/out/integrity-audit.json',
    resultSummary: '9/9; the incomplete case is requires-review, the complete case is clean.',
    limitations: 'A lexical candidate, not a truth verdict; nothing is auto-retired.',
    status: 'current; permanent regression',
  },
  {
    claimId: 'R38-SELECTION',
    claim: 'Task-aware selection improves critical-fact coverage under budget pressure and fixes the prefix selector\'s break defect.',
    evidenceLevel: 'Mechanism Certified',
    experimentId: 'R38-M0 WP3',
    gitSha: '0067020',
    model: 'none',
    route: 'none',
    harness: 'ablation over fixtures',
    configuration: 'S0 recency vs S1 task-aware',
    datasetVersion: '4 cases',
    scorerVersion: 'n/a',
    rawArtifact: 'eval/r38/out/working-set-ablation.json',
    resultSummary: '5/5; B2 critical 0/1 -> 1/1; scope tokens 122 -> 76; greedy skip keeps C.',
    limitations: 'Fixtures only; eval code, not a production default; no model behavior.',
    status: 'Mechanism Certified, not a product candidate',
  },
  {
    claimId: 'R38-RECOVERY',
    claim: 'Bounded archive recovery recovers facts that never entered active state, with honest coverage statuses.',
    evidenceLevel: 'Mechanism Certified',
    experimentId: 'R38-M0 WP4',
    gitSha: '0067020',
    model: 'none',
    route: 'none',
    harness: 'real FileBundleStore + recall',
    configuration: 'S0/S1/S2',
    datasetVersion: '5 cases',
    scorerVersion: 'n/a',
    rawArtifact: 'eval/r38/out/archive-recovery-ablation.json',
    resultSummary: '8/8; 2/5 fixtures recovered archive-only; a genuine miss and a descriptor-bound miss get different statuses.',
    limitations: 'Synthetic bundles; no engine-level recovery test; no gold leakage but also no live query.',
    status: 'Mechanism Certified, not a product candidate',
  },
  {
    claimId: 'R38-NATIVE-OVERLAY',
    claim: 'The context overlay is delivered through the real DSH runtime-context channel with stable digests; the journal and checkpoint are not modified.',
    evidenceLevel: 'Mechanism Certified',
    experimentId: 'R38-M0 WP6',
    gitSha: '0067020',
    model: 'scripted',
    route: 'none',
    harness: 'real host + RecordingAdapter',
    configuration: 'overlay order 900',
    datasetVersion: '6 smoke checks',
    scorerVersion: 'n/a',
    rawArtifact: 'eval/r38/out/native-context-smoke.json',
    resultSummary: '6/6; identical steps produce one snapshot; a JSONL resume delivers the same digest; journalModified false.',
    limitations: 'Scripted adapter; proves the delivery path, not model behavior.',
    status: 'Mechanism Certified, not a product candidate',
  },
  {
    claimId: 'PRODUCT-DECISION',
    claim: 'EF Active remains on deployment hold; no product-level benefit has been demonstrated.',
    evidenceLevel: 'Decision',
    experimentId: 'R37-B / R37-D / R38-M0',
    gitSha: '0067020',
    model: 'n/a',
    route: 'n/a',
    harness: 'n/a',
    configuration: 'Active',
    datasetVersion: 'n/a',
    scorerVersion: 'n/a',
    rawArtifact: 'eval/r38/out/gate-status.json',
    resultSummary: 'deployment-hold; deploymentEligible false; R38 made 0 live calls.',
    limitations: 'A decision, not a measurement. It is revisited only with new behavioral evidence.',
    status: 'current',
  },
]

const artifacts = new Map()
function artifactIdentity(path) {
  if (artifacts.has(path)) return artifacts.get(path)
  const full = join(ROOT, path)
  const row = existsSync(full)
    ? { path, present: true, bytes: readFileSync(full).length, sha256: sha256(full) }
    : { path, present: false, bytes: null, sha256: null }
  artifacts.set(path, row)
  return row
}

const rows = CLAIMS.map(claim => {
  const artifact = artifactIdentity(claim.rawArtifact)
  return {
    ...claim,
    artifactPresent: artifact.present,
    artifactBytes: artifact.bytes,
    artifactSha256: artifact.sha256,
    // A claim is not "supported" merely because a file exists; the status says
    // what the evidence means. `artifactPresent` is a separate, narrower fact.
    artifactStatus: artifact.present ? 'present' : 'missing',
  }
})

const registry = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work: 'EF-C0-WP4',
  levels: LEVELS,
  note:
    'Evidence level is assigned per claim. Mechanism Certified is never promoted to '
    + 'Product-level Evidence. Decision and Constraint are non-measurement classes.',
  counts: {
    claims: rows.length,
    byLevel: Object.fromEntries(LEVELS.map(level => [level, rows.filter(row => row.evidenceLevel === level).length])),
    missingArtifacts: rows.filter(row => !row.artifactPresent).length,
  },
  claims: rows,
}

/** The arms a future experiment must freeze. */
const arms = [
  {
    arm: 'B0',
    name: 'Native DSH Basic',
    definition: 'the host compaction backend, no EF',
    semanticMode: 'n/a',
    semanticContinuity: 'n/a',
    foldPolicy: 'Basic',
    retention: 'Basic default',
    rationaleBudget: 'n/a',
    checkpointBudget: 'Basic default',
    toolProtocol: 'host',
    model: 'must be frozen per experiment',
    route: 'must be frozen per experiment',
    harness: 'must be frozen per experiment',
    runtime: 'must be frozen per experiment',
    dataset: 'must be frozen per experiment',
    scorer: 'must be frozen per experiment',
    costLedger: 'required',
    status: 'not yet measured under a converged manifest',
  },
  {
    arm: 'E0',
    name: 'EF zero-LLM semantic',
    definition: 'EF core with no auxiliary semantic call',
    semanticMode: 'none',
    semanticContinuity: 'off',
    foldPolicy: 'tier (economy by default)',
    retention: 'tier',
    rationaleBudget: '0',
    checkpointBudget: 'semanticCheckpointTokens (reporting)',
    toolProtocol: 'host',
    model: 'must be frozen per experiment',
    route: 'must be frozen per experiment',
    harness: 'must be frozen per experiment',
    runtime: 'must be frozen per experiment',
    dataset: 'must be frozen per experiment',
    scorer: 'must be frozen per experiment',
    costLedger: 'required',
    status: 'certified deterministic; no behavioral result under a converged manifest',
  },
  {
    arm: 'E1',
    name: 'EF with rationale',
    definition: 'EF core plus one rationale call per fold',
    semanticMode: 'rationale',
    semanticContinuity: 'off',
    foldPolicy: 'tier',
    retention: 'tier',
    rationaleBudget: 'tier hint (400/800/1600)',
    checkpointBudget: 'semanticCheckpointTokens',
    toolProtocol: 'host',
    model: 'must be frozen per experiment',
    route: 'must be frozen per experiment',
    harness: 'must be frozen per experiment',
    runtime: 'must be frozen per experiment',
    dataset: 'must be frozen per experiment',
    scorer: 'must be frozen per experiment',
    costLedger: 'required',
    status: 'certified deterministic; no behavioral result under a converged manifest',
  },
  {
    arm: 'S0',
    name: 'EF Semantic Continuity Active',
    definition: 'one combined writer call; validated, authorized commits become state',
    semanticMode: 'rationale',
    semanticContinuity: 'active',
    foldPolicy: 'tier',
    retention: 'tier',
    rationaleBudget: 'tier hint',
    checkpointBudget: 'semanticCheckpointTokens',
    toolProtocol: 'host',
    model: 'must be frozen per experiment',
    route: 'must be frozen per experiment',
    harness: 'must be frozen per experiment',
    runtime: 'must be frozen per experiment',
    dataset: 'must be frozen per experiment',
    scorer: 'must be frozen per experiment',
    costLedger: 'required',
    status: 'deployment-hold; R37-B harm signal under a custom harness',
  },
  {
    arm: 'B1-HISTORICAL',
    name: 'R37-B B1 (EF Basic arm)',
    definition: 'EF delegating to Basic inside the R37 custom harness',
    semanticMode: 'n/a',
    semanticContinuity: 'off',
    foldPolicy: 'Basic',
    retention: 'Basic',
    rationaleBudget: 'n/a',
    checkpointBudget: 'Basic',
    toolProtocol: 'P3e',
    model: 'deepseek-v4.1-flash',
    route: 'local omnigate2api',
    harness: 'H-protocol-e / P3e',
    runtime: 'custom',
    dataset: 'A1-v2, D1-v2, B2, C1, F1, H1',
    scorer: 'R37-B scorer',
    costLedger: 'eval/r37/out/r37b-stage2-results.json (cost block)',
    status: 'historical; NOT equivalent to B0',
  },
  {
    arm: 'S-HISTORICAL',
    name: 'R37-B S (EF Active arm)',
    definition: 'EF semantic continuity active inside the R37 custom harness',
    semanticMode: 'rationale',
    semanticContinuity: 'active',
    foldPolicy: 'EF',
    retention: 'EF',
    rationaleBudget: 'frozen R37 value',
    checkpointBudget: 'frozen R37 value',
    toolProtocol: 'P3e',
    model: 'deepseek-v4.1-flash',
    route: 'local omnigate2api',
    harness: 'H-protocol-e / P3e',
    runtime: 'custom',
    dataset: 'A1-v2, D1-v2, B2, C1, F1, H1',
    scorer: 'R37-B scorer',
    costLedger: 'eval/r37/out/r37b-stage2-results.json (cost block)',
    status: 'historical; negative contract difference',
  },
]

const baseline = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  work: 'EF-C0-WP4',
  note:
    'Arms are FROZEN CONFIGURATIONS, not user-visible preset names. A field that '
    + 'cannot be confirmed is "must be frozen per experiment" or Unknown, never inferred.',
  arms,
  comparability: {
    sameHarnessOnly: true,
    sameScorerOnly: true,
    historicalB1IsNotB0: true,
    mechanismIsNotBehavior: true,
    reason:
      'R37-B used a custom P3e harness and its own B1 arm; R37-D used a custom-json-loop '
      + 'and scorer v3. Pooling them with each other or with Native DSH Basic would mix '
      + 'harnesses and scorers.',
  },
  r38M1: {
    status: 'on hold pending convergence',
    authorization: 'none',
    note: 'R38-M1 is a historical research proposal. It is not executed and not authorized by EF-C0.',
  },
}

mkdirSync(DATA, { recursive: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(DATA, 'evidence-registry.json'), `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
writeFileSync(join(DATA, 'baseline-comparison-manifest.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
writeFileSync(join(OUT, 'evidence-registry-summary.json'), `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: registry.generatedAt,
  claims: registry.counts.claims,
  byLevel: registry.counts.byLevel,
  missingArtifacts: registry.counts.missingArtifacts,
  arms: arms.length,
}, null, 2)}\n`, 'utf8')

process.stdout.write(
  `claims ${registry.counts.claims}; missing artifacts ${registry.counts.missingArtifacts}; `
  + `levels ${Object.entries(registry.counts.byLevel).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ')}\n`,
)
