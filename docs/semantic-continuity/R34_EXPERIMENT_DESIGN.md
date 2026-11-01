# R34 — Experiment Design

Status: **scripts and frozen inputs complete; live run `not-executed / blocked`.**

## 1. What is being measured

The question is not "does the journal persist?" It is:

> Does the semantic knowledge EF saves and delivers make a follow-up agent more
> correct and more continuous, and is that worth the extra model, token, latency,
> and retrieval cost?

The experiment separates four layers that R33 could not distinguish:

```text
scripted pipeline          information delivery contract
live writer only           real writer protocol/extraction quality
live custom tool loop      real model continuation in this harness
production DSH agent loop  real product loop (not exercised this round)
```

No number from one layer is presented as a result from another.

## 2. Frozen development dataset v2

`r33-semantic-continuity-v2`, digest:

```text
407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
```

17 cases across eight risk classes:

| Class | Cases |
|---|---|
| persistent-constraint | A1, A2 |
| decision-override | B1, B2 |
| negative-knowledge | C1, C2 |
| validation-boundary | D1, D2 |
| cross-phase-dependency | E1, E2 |
| authority-scope | F1, F2, F3, F4 |
| history-independent | G1, G2 |
| retrieval-trigger | H1 |

Five counterfactual pairs share their workspace and task text and differ only in
the decisive fact: A1/A2, B1/B2, C1/C2, E1/E2, F1/F2. F3/F4, D1/D2, G1/G2, and
H1 are single-construct cases.

v1 is preserved in Git at `ad3020df0e22587f78490c19550fe6986f55af3f` and under
`eval/r33/frozen/v1/`. The v1→v2 changes are listed in `R34_EVALUATOR_AUDIT.md`
§C; none changed a transcript, task, gold statement, action, or hidden
assertion. The three citation corrections moved a corroborating message out of
`sourceRefs` into `corroboratingRefs`.

## 3. Frozen holdout

`r33-semantic-continuity-holdout-v1`, digest:

```text
af22eb7a91155507998750f0428be8bb7c6285696179128a75e83f3eeaada663
```

Two cases authored after the v2 instrument was frozen and kept out of the v2
digest:

| Case | Construct | Why it is not a renamed development case |
|---|---|---|
| HOLD-A | late user compatibility requirement competing with a tool-result migration note | fact location (late user turn), a competing normative-sounding tool note, different files and hidden checks |
| HOLD-B | a release value that exists only in an early tool result | retrieval trigger with a different artifact, value, and task; the visible test checks only shape, so the exact value must be recovered |

The holdout is **frozen and not executed**. No model has seen it. Running it
before the instrument is trusted would burn the only blind sample.

## 4. Arms

### B1 — real EF off

The real model performs the compaction summary. No semantic writer, no
journal commits, no semantic state. The checkpoint is the model's own summary.

R33's scripted `literalSummary(transcript)` is now only the scripted control and
is labelled as such. It is never called a real-model baseline.

### S — real EF active

```text
Writer -> Validator -> Journal -> Working Set -> Checkpoint -> Agent
```

Every proposal, refusal, limit, committed anchor, and visible checkpoint is
recorded from the engine/journal. The writer is the real model in live mode.

### O1 — oracle semantic delta

The frozen gold facts are converted to deltas and injected as the WRITER's
output only. They still traverse the real validator, commit planner, journal,
working-set compiler, and fold. The follow-up agent still calls the real model.

Handoff basis is recorded explicitly:

- `s-conditional`: S ran first for the same case and O1 reuses S's handoff, so
  only the DELTA is replaced;
- `frozen-dataset`: S was not run, so the dataset's frozen handoff is used.

O1 is a controlled intervention, not a product mode.

### O2 — oracle visible context

The follow-up agent receives the CURRENT gold facts directly. This is the
behavioural upper bound "the agent already knows the correct current facts".
Superseded facts are excluded; v1 included them, which was itself a defect.

### Optional live controls

`F` (full transcript), `N` (task only), and `OR` (current gold evidence quotes)
are still available by `--arms`. They are controls, not the four primary arms.

## 5. Shared initial conditions

Every arm for a case receives:

- the same frozen transcript and fold boundary;
- the same initial workspace files;
- the same task text;
- the same model route and request parameters (live);
- the same tool permissions and checker.

Each replicate has its own session, bundles, journal, and workspace. The fold
OUTPUT is allowed to differ because compression is the object of study; B1 and S
checkpoints are not forced to be byte-identical.

## 6. Live gate

`--run` requires all of:

```text
R33_LIVE=1
manifest.model
manifest.limits.requests / inputTokens / outputTokens / wallClockMs > 0
manifest.maxOutputTokens > 0
manifest.route.baseUrlEnv / apiKeyEnv (environment variable NAMES)
```

The route variables are resolved only after the gate passes. A missing route
returns `provider-unavailable` and makes no request. A manifest that embeds an
`authorization`, `api-key`, `x-api-key`, `x-auth-token`, or `cookie` header is
refused.

This round supplied no live authorization, provider route, or budget, so the
live status is:

```text
status: not-executed
reason: R33_LIVE is not 1; refusing to spend provider credits
HTTP requests: 0
tokens: 0
```

## 7. Follow-up agent

The live follow-up is a **custom text-JSON tool loop**, not the production DSH
agent loop:

- one JSON object per turn;
- tools `read_file`, `write_file`, `list_dir`, `run_tests`, `recall`, `finish`;
- tool results are returned as user text;
- `recall` searches the frozen transcript, not production `context_search`;
- the system prompt contains no risk class, arm name, or evaluation label.

This is sufficient for a low-cost behavioural pilot. It is not evidence about
the production loop, and the report says so.

## 8. Grading

Extraction:

```text
coordinate recall      a proposal exists at the subject (weak)
claim correctness      exact frozen statement (strong)
source support         a proposal quote occurs in the authoritative source
grounded precision     correct AND source-supported / accepted
false normative rate   accepted normative with no gold coordinate
current-state accuracy current visible, superseded not visible
direct visibility      current facts in the checkpoint alone
```

Behaviour:

```text
task success, failed checks, constraint violation, obsolete revival,
rejected retrial, false verification claim, process violation,
tests actually executed, tool calls, recall attempts/success/grounded
```

Checker status is independent: a failed check is a task failure; a checker
crash/timeout/spoof is an invalid measurement.

## 9. Statistics

- per-case outcome is the primary table;
- per-family outcome groups the five counterfactual pairs;
- `compareTreatment({baselineArm, treatmentArm})` reports rescue/damage with
  explicit roles;
- `pairedBootstrap` resamples FAMILIES, not individual cases, because pair
  variants are correlated;
- every interval is labelled **exploratory**. The scripted 15/17 interval is not
  evidence of a real-model effect.

## 10. What this round does not do

- no live provider request;
- no production DSH agent-loop result;
- no Handoff-Only / Delta-Only live ablation (requires the first live result);
- no retrieval-trigger live measurement (requires a real agent);
- no memory prefetcher, no vector database, no new journal schema, no second
  compaction engine;
- no claim that the scripted 68/68 self-test is a model result.
