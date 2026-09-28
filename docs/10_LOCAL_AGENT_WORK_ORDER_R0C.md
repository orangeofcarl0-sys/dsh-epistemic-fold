# Local Agent Work Order — R0-C Evaluation Closure

> Repository: `orangeofcarl0-sys/dsh-epistemic-fold`  
> Expected start: `8e34cd767b6b374ac7574d88884c8b4b05088873`  
> Mission: build the evaluation system that decides whether Epistemic Fold should proceed to M1/M3b/M4/M5.

---

# 1. Read first

Read:

```text
README.md
docs/01_EF_RFC_001_ARCHITECTURE.md
docs/03_EF_TEST_BENCHMARK_SPEC.md
docs/05_EF_DECISIONS_AND_OPEN_QUESTIONS.md
docs/06_FINAL_REPORT.md
07_R0C_EVALUATION_CLOSURE.md
08_BOUNDARY_CORPUS_PROTOCOL.md
09_EVALUATION_METRICS_SPEC.md
```

Also inspect current DSH:

```text
packages/test-support/session-snapshot
packages/test-support/llm-replay
docs/testing.md
```

Do not invent a competing Session fixture format.

---

# 2. Preflight

Report before edits:

```bash
git rev-parse HEAD
git status --short
git branch --show-current
git rev-parse origin/main
```

Run current gates:

```bash
npm ci
npm test
npm run typecheck
```

If HEAD differs from expected start, reconcile current code before applying this plan.

---

# 3. Branch

Suggested:

```text
r0c-evaluation-closure
```

Do not mix M1/M3b/M4 feature work into this branch.

---

# 4. R0-C0 — Fix measurement semantics first

Required:

1. remove or rename `stablePrefixBytes`;
2. add true `sharedPrefixTokens`;
3. compute actual PMA ratio;
4. record total/peak/p95 prompt tokens;
5. record checkpoint/frozen-prefix recurring load;
6. record compaction auxiliary usage;
7. record recall usage;
8. update `docs/06_FINAL_REPORT.md` to stop claiming `PMA(EF)<PMA(Basic)` unless the corrected metric proves it.

Add unit tests for metric formulas.

Gate:

```text
all metrics have one unambiguous definition
same input fixture reproduces identical JSON result
```

---

# 5. R0-C1 — Build evaluation core

Create:

```text
eval/src/schema.ts
eval/src/actions.ts
eval/src/verifier.ts
eval/src/metrics.ts
eval/src/economics.ts
eval/src/incidents.ts
eval/src/report.ts
```

Responsibilities:

### schema.ts

Closed schemas for:

```text
BoundaryCase
Oracle
ActionRecord
EvalRunResult
CompressionIncident
```

### actions.ts

Normalize tool actions and duplicate-work signatures.

### verifier.ts

Machine-check scenario oracles.

### metrics.ts

Implement exact definitions from `09_EVALUATION_METRICS_SPEC.md`.

### economics.ts

Implement cache-discount curve and break-even computation.

### incidents.ts

Classify paired regressions.

### report.ts

Generate Markdown/CSV from JSON; JSON is the source of truth.

---

# 6. Integrate DSH session-snapshot

Prefer `@deepseek-ai/dsh-session-snapshot` / replay as test-support/dev infrastructure through the existing vendor mapping process.

Create the first boundary snapshot suite.

Required keyless command:

```text
npm run eval:replay
```

It must require no API key.

If upstream package integration is blocked by export/version constraints, document the exact seam and build the smallest adapter around it. Do not invent a second Session JSONL format.

---

# 7. Initial hard corpus

Implement at least:

```text
B01 explicit constraint
B02 supersession
B03 evidence-vs-narrative
B04 verified failure
B05 pending obligation
B06 exact identifier
B07 tool pairing
B08 repeated leaf
B09 root rebase
B10 session isolation
B11 restart
B12 state-only checkpoint
```

Each case must have:

```text
DSH recorded Session fixture
EF boundary sidecar
machine oracle
keyless replay test
```

---

# 8. Exploratory corpus

At least:

```text
X01 rejected path resurfaces
X02 uncertainty promotion
X03 cross-checkpoint dependency
X04 long-distance rationale
X05 old search evidence becomes relevant
X06 child-agent handoff
```

These are diagnostic.

A failure produces an incident; it does not automatically authorize M3b/M4 implementation.

---

# 9. R0-C2 — Paired runner

Create:

```text
eval/src/paired-runner.ts
eval/live/provider-runner.ts
eval/live/repeated-run.ts
```

Required arms:

```text
B1   Basic
E3a0 EF semanticMode=none
E3aR EF semanticMode=rationale
```

Optional full-history arm when feasible.

The runner must restore identical:

```text
Session snapshot
workspace
tool catalog
continuation stimulus
```

for each arm.

---

# 10. Keyless paired mode

The keyless mode is for infrastructure determinism, not intelligence simulation.

It must prove:

- all arms start from identical state;
- event/action capture is deterministic;
- verifier is deterministic;
- metrics are deterministic.

Add:

```text
npm run eval:keyless
```

to CI.

---

# 11. Live paired mode

Add an opt-in command such as:

```text
npm run eval:live -- --model <provider/model> --cases B01,B02,...
```

Requirements:

- no live credential in mandatory CI;
- provider/model recorded;
- reasoning effort/temperature recorded;
- seed recorded when supported;
- otherwise allow N replicates;
- save raw and normalized JSON results.

Do not block code completion on absence of credentials.

---

# 12. Machine verifiers first

For coding scenarios implement:

```text
workspace exact comparison
git diff/file-set comparison
test exit code
forbidden path checks
artifact checks
current EF state checks
```

Only add LLM judge for residual semantic-rationale quality.

If an LLM judge is added:

- use narrow rubrics;
- preserve raw output;
- never let it override machine correctness.

---

# 13. Behavior telemetry

Capture:

```text
all post-boundary tool calls
context_search calls
context_recall calls
file/test/search targets
workspace versions
```

Compute:

```text
DWR
RAF@1/3/5
SAF@1/3/5
TAF@1/3/5
RecallTriggerRate
RecallSuccessGivenTrigger
ContextRegret@1/3/5
```

Add false-positive tests:

```text
same file read after file changed => NOT duplicate
same test after workspace changed => NOT duplicate
time-sensitive search repeat => NOT automatically duplicate
```

---

# 14. R0-C3 — Long-horizon economics

Extend benchmark to:

```text
32
64
128
```

steps.

Add two EF maintenance modes:

```text
leaf-only
leaf + benchmark-controlled root when advice is honored
```

Name the latter explicitly as benchmark policy.

Compare:

```text
Basic
EF-state-only
EF-rationale
```

Report:

```text
totalPromptTokens
peakPromptTokens
p95PromptTokens
invalidatedSuffixTokens
sharedPrefixTokens
reclaimedTokens
PMA
frozenCheckpointTokens
rootCount
auxiliary compaction tokens
recall tokens
```

---

# 15. Context budget ladder

Run deterministic economics under multiple artificial context capacities.

At minimum:

```text
32K-equivalent
64K-equivalent
128K-equivalent
262K-equivalent
```

If scaled fixtures are used, label them “scaled synthetic windows”.

---

# 16. Cache break-even curve

Implement:

```text
rho = 0, 0.1, 0.2, 0.5, 1.0
```

and generate:

```text
Cost_rho(Basic)
Cost_rho(EF-state)
Cost_rho(EF-rationale)
```

Report crossover/break-even.

Do not make provider billing claims unless measured from provider telemetry.

---

# 17. Shadow incident package

Implement a serializer exporting one local/real boundary into:

```text
eval/incidents/<id>/
  boundary.json
  result.json
  incident.json
```

Do not export secrets by default.

Scrub at minimum:

```text
API keys
authorization headers
known credential environment values
```

One end-to-end demo is sufficient for R0-C.

---

# 18. Statistical output

For live replicated runs generate:

```text
paired mean delta
paired median delta
bootstrap 95% CI
wins/ties/losses
success counts
critical violation counts
```

Implement bootstrap locally; avoid a large stats dependency unless necessary.

---

# 19. Documentation

Add:

```text
docs/07_R0C_EVALUATION_REPORT.md
```

Generate or populate it from machine results.

Update README status using evidence-backed claims only.

Correct stale test counts and obsolete PMA wording.

---

# 20. CI

Pinned CI should add:

```text
eval metric unit tests
keyless boundary replay
keyless paired harness smoke
long-horizon deterministic economics smoke
```

Live-provider runs are not mandatory CI.

Master compatibility probe can remain `continue-on-error` until explicitly promoted.

---

# 21. Stop conditions

Stop and report if:

1. DSH snapshot/replay cannot be integrated without duplicating Session formats;
2. paired arms cannot start from demonstrably identical Session/workspace state;
3. action telemetry cannot distinguish environment-changing repeats from duplicate work;
4. metric definitions are not deterministic;
5. evaluation reveals an M0/M2/M3a correctness regression.

Fix already-promised invariant regressions if needed.

Do not begin M1/M3b/M4 feature work.

---

# 22. Final report

Use:

```markdown
# R0-C REPORT

## Baseline
EF HEAD:
DSH pinned:
DSH master probe:
working tree:

## Measurement integrity
...

## Boundary corpus
hard cases:
exploratory cases:
keyless replay:

## Paired continuation
models:
replicates:
Basic:
EF-state:
EF-rationale:

## Behavior
Task success:
DWR:
constraint violations:
recall trigger/success:
Context Regret:

## Economics
Total prompt:
Peak/P95:
PMA:
cache break-even:
root cost:

## Compression incidents
...

## Evidence-driven next-stage decision
M1 / M3b / M4 / M5 / STOP ARCHITECTURE GROWTH

## Decision
R0-C CLOSED / NOT CLOSED
```

---

# 23. Completion definition

R0-C is complete only when the project can answer, reproducibly:

1. what EF preserves;
2. how behavior changes after a fold;
3. what repeated work a fold causes or prevents;
4. how much active context is saved;
5. how much prefix locality is gained;
6. how much recurring checkpoint/root cost is added;
7. whether rationale is worth its model cost;
8. what observed failure class, if any, justifies the next architecture layer.
