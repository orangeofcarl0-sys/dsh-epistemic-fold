# 60 — Parallel run report: three task lines, one apparatus

Status: **RUNNING**. The apparatus sections are complete and verified; the results
section carries interim numbers and is filled in when the episodes end.

Three lines run in parallel inside the 8-cell concurrency measured safe
(`cefe514`): unknown-config-semantics in four tiers, riscv-core-debug, and
commit0-multilib-tdd.

| line | cells | budget | started |
|---|---|---|---|
| unknown-config (basic/economy/balanced/quality) | 4 | 28800 s | 04:12 |
| riscv-core-debug | 2 | 21600 s | 04:19 |
| commit0-multilib-tdd | 1 | 18000 s | 04:12 |

---

## 1. What had to be true before these numbers meant anything

Every item below was **checked in a running container or a real trial**, not inferred
from the source. That distinction is the whole point of this section: five of the
defects found tonight were invisible to reading and obvious to running.

### 1.1 The oracle was closed (unknown-config)

The July image shipped `/opt/cfg/cfgd_data.json` — keys `pool` and `seed` — with
`spec.md` carrying all five `===REVISION` blocks. A task that pays for reading the
answer cannot measure inference. Verified in the live cell:

    CFG_DATA=/opt/cfg/cfgd_public.json
    CFG_SECRET=/opt/cfg/cfgd_secret.json
    cfgd_data.json: No such file or directory
    spec.md revision blocks: 0

### 1.2 The task could be imported (commit0)

`import tinydb` and `import sortedcontainers` raised before an agent could read a
line, because five stubbed helpers are executed while a module or class body evaluates
(`with_typehint`, `__make_cmp` in two files, `recursive_repr`, and
`__make_raise_attributeerror`). None is named by the graded tests, so implementing them
would have earned nothing either — forced and unpaid at once. Repaired by deferring each
to call time, and the build now imports all three libraries and fails if any raises.
Verified: `all import: True`, 376 stubs remaining, `__eq__` still raises.

### 1.3 The graded artifact is archived

riscv declared `/app/output/rtl`, which nothing writes; the grader reads the agent's
`hw/rtl` from `/app/output/workspace`. Confirmed by a real trial's manifest:

    /app/output/workspace/hw/rtl -> artifacts/rtl (directory)  status: ok

Artifacts resolve at verification time, so the correction reached trials that had already
started.

### 1.4 The score is dense and normalised (unknown-config)

The reward was gated behind a submission, so 40 archived engines ranging 0.3678 to 0.8894
all recorded a bare 0. Now:

    reward = (raw - floor) / (1 - floor)      floor = the engine as shipped, 0.3678

Verified in the real image against an archived engine with NO submissions:
`raw_ungated=0.8894`, `baseline_ungated=0.3678`, `reward=0.825`.

This is not a refinement. Section 3 shows the gate requires 21 fully-correct probe rounds
per stage; if the four tiers never clear one, the old scoring would record 0 for all four
and the dense score is the only thing still producing information.

### 1.5 The transport reaches the provider

    direct  0 ok / 20 requests      proxy  6 ok / 14x HTTP 429

Direct is not the good route; it dies outright while the proxy degrades. The port is now
**discovered** (7890/7897/10808/1080/7891) rather than assumed, because the hardcoded
10808 had moved — and a refused connection is indistinguishable from a broken proxy, which
is how the wrong conclusion was reached the first time. All three lines log
`proxy: enabled (http://127.0.0.1:7890)`.

The residual ~70% rejection is provider-side capacity on this model tier: it came back
identically through both routes with zero network errors.

### 1.6 No call can hang forever

`modelTurn()` passed no signal to `llm.stream()`, so a stalled provider call blocked the
episode until its timeout. Two riscv cells sat at 0% CPU with no error anywhere. The fold
path had been fixed for exactly this; the main call had not. `STEP_TIMEOUT_MS` (900 s)
now bounds it, and a cut call becomes an ordinary counted transport failure.

---

## 2. Defects found and fixed this session

Ordered by how much damage they would have done to the results.

| defect | fix | verification |
|---|---|---|
| Three lines ran **June/July images** (`force_build: false`, dated tags): oracle open, commit0 unimportable | `force_build: true`, stale images deleted | rebuilt images inspected before relaunch |
| `modelTurn` unbounded — a stalled call burns the whole episode | `STEP_TIMEOUT_MS` with a real AbortController | file mtime 04:06 precedes every live cell start |
| Provider ceiling counted **attempts**, not elapsed time | `PROVIDER_OUTAGE_MAX_SEC` (2 h) | riscv's 97-min outage killed a working episode |
| Consecutive-failure counter was **never incremented** (my own earlier fix) | the increment | the run that died printed `0 consecutive, 61 total` |
| `ef-ucs.sh` swept **every container**; restarting riscv deleted five cells | scoped per task | docker events showed five deaths in one second |
| `ef-calib-riscv.sh` had the same sweep, unfixed | scoped per task | the sweep matched the comment explaining it, too |
| Analyzer filed **every non-vector-db task as unknown-config** | read the cell's directory prefix | riscv and commit0 now report separately |
| Analyzer's by-arm loops were **hardcoded** to 2 arms, 2 tasks | iterate what is present | balanced/quality had never appeared |
| Analyzer averaged in cells from stale images | `INVALID-JOBS.txt`, honoured by name | `basic n=7` became `n=1` |
| Dense score's guard sat **after the first max()** | moved above every max() | verified in-image, no submissions |

### The recurring shape

Six of these are **a correct fix applied to one instance of a class**: the counter fixed
but not incremented, the arm list fixed in one place but not the report, the fold timeout
fixed but not the step, the oracle split on the public half but not the private, the
container sweep fixed in one driver but not the other, the consecutive counter fixed but
the bound left in attempts. **Reading the fix was not enough in any of them.**

---

## 3. Measured results

### 3.1 Cost composition — per call, not a total

Measured on the live wave (`basic` aggregates 4 cells: unknown-config basic, commit0, and
2 riscv).

    arm       cells  calls  cacheRead  uncached  output  hit%  unc/call  out/call  $/call
    basic      4     126    958,912   280,022   79,542  77.4    2,222      631   0.0009
    economy    1      41    248,000    55,175   20,316  81.8    1,346      496   0.0006
    balanced   1      35    312,512    63,358   24,874  83.1    1,810      711   0.0009
    quality    1      64    563,392   129,197   22,007  81.3    2,019      344   0.0008

**Every folding arm carries less miss-priced context per call than basic.** This is the
figure a compression policy moves; a total cannot separate "did more work" from "carried
more context per step". `hit%` is largely a consequence of a stable prefix and
`out/call` is the model's own verbosity, so neither is attributable to the runtime alone.

### 3.2 Projected turns against budget

    cell     task         calls  已过    rate/min  budget   projected
    zAccq9a  commit0        61   20min   3.05    18000s     914
    ZpoHbvA  ucs-basic      22   20min   1.10    28800s     530
    W6iKhAT  ucs-economy    43   20min   2.17    28800s    1040
    ak3ti6B  ucs-balanced   43   20min   2.18    28800s    1044
    wwCynox  ucs-quality    66   20min   3.36    28800s    1611
    7LQXQzz  riscv           21   13min   1.60    21600s     574
    WgtrcFG  riscv           38   13min   2.89    21600s    1039

This **corrects an earlier estimate in this session**, which held that commit0's budget was
infeasible (136 turns for ~5k LOC). That estimate used 132 s/turn borrowed from a wave that
ran while the proxy was broken. The measured rate is 18–55 s/turn, and commit0 projects
~914 turns. **The budget is not the binding constraint on any line.**

### 3.3 The gate, read from the daemon

    stages         : A:0/21  B:0/21  C:0/21  D:0/21  E:0/21
    sample budget  : 39 left (of 45)
    time floor     : 50s between gated calls (sample/probe/submit)
    ACTIVE STAGE   : A (core scalars) -> fields ['workers','retries','batch_size']
       need 21 fully-correct probe rounds; have 0.

At 22 minutes all four tiers had `probe=0`. Reading their commands shows why, and it is
not failure: they are sampling for labelled examples, reading `cfg_daemon.py`, and one is
rewriting `engine.py` while grepping `spec.md` for field-name synonyms. The coherent order
is sample → infer → implement → probe → submit, and probe grades the engine, so probing
first would be backwards.

### 3.4 riscv's 0.28 is entirely scaffolding

The one completed riscv episode, decomposed by its own scorecard:

    reward = 0.28    tamper: 7705 files checked, 0 modified
        G_build        0.06 x 1.0
        G_directed     0.60 x 0.0    <- the primary signal
        G_compliance   0.06 x 1.0
        G_torture      0.05 x 1.0
        G_cosim        0.05 x 1.0
        G_formal       0.06 x 1.0
        G_journal      0.12 x 0.0

0.28 is exactly the sum of the scaffolding gates. **"riscv scored 0.28" does not mean
"28% of the bugs were fixed"** — it means the harness works, the RTL builds, and not one
injected defect was addressed. That episode also died of the provider outage at 97 minutes
of a 6-hour budget, so `G_directed = 0` is equally consistent with "never got far enough"
and "could not do it"; the gates establish which KIND of failure this was, which a bare
0.28 could not.

### 3.5 Final rewards — all seven cells

Every cell terminated `turn-budget-exhausted` at 401 calls (the `MAX_TURNS` cap, not the
time budget).

**The cut was NOT uniform, and an earlier version of this report said it was.** `modelCalls` is
incremented *before* the request is sent, so it counts ATTEMPTS and not successes, and the budget
logic in force when these cells ran counted iterations rather than turns. The provider failure
counts are therefore inside the 401:

    arm       calls   provider failures   real turns   reward
    basic      401          132              269       0.7795
    economy    401          102              299       0.6545
    balanced   401           88              313       0.7114
    quality    401           94              307       0.7705

So the four arms ran **269, 299, 313 and 307** real turns, not 400 each. `d2442c7` fixed the
budget to count model turns and to charge provider failures to a separate allowance, but it landed
at 15:25 and these cells started at 04:12 — they predate it, along with the turn-lifecycle fix
(`ac68146`, 14:09) and the bounded read (`d449c93`, 16:23).

**The direction of the error matters, and it runs against the headline rather than for it.** The
winner, `basic`, had the MOST failures and therefore the FEWEST real turns — 269 against 313 for
`balanced`, which it beat by 0.068. A no-folding baseline that wins on 269 turns while a folding
arm gets 313 is a stronger result than one that wins at a matched cut, not a weaker one. But it is
a different claim from the one made above, and it is the one the data supports.

**What the four-tier comparison may therefore say** is limited to a direction: the baseline was
not beaten. It may not say the arms were compared at equal opportunity, and a rerun on the fixed
code is what would settle it. That rerun is the 17:58 wave, which is still in flight and which the
provider outage has cost several cells (see 3.7).

    task            arm       reward   raw      stages  official  folds  unc/call  $/call   cost
    unknown-config  basic     0.7795   0.8606   4       0.8592    0      1815     0.00091  0.3641
    unknown-config  quality   0.7705   0.8549   3       0.7299    15     1297     0.00053  0.2131
    unknown-config  balanced  0.7114   0.8175   0       0.0000    30     1970     0.00074  0.2973
    unknown-config  economy   0.6545   0.7816   1       0.2385    19     1276     0.00058  0.2326
    riscv           basic     0.88     --       --      --        0      2649     0.00108  0.4346
    riscv           basic     0.82     --       --      --        0      2482     0.00107  0.4309
    commit0         basic     0.074    --       --      --        0      2136     0.00098  0.3918

**The headline is not the one the study was built to find.** On unknown-config the
**no-folding baseline scored highest on both metrics** -- 0.7795 dense and 0.8592
stage-gated, against 0.7705/0.7299 for the best folding arm -- and passed the most stages
(4, against 3/1/0).

**And it was the most expensive**: $0.00091 per call against $0.00053-$0.00074. Folding
does what it claims at the per-call level -- `uncached/call` falls from 1,815 to
1,276-1,297, about 30% -- and that saving does **not** convert into score on this task at
this cut.

Cost tracks **fold count**, not retention: `balanced` folded 30 times and cost the most
among the folding arms; `quality` folded 15 times and cost the least. Each fold is a
summarization call that reads the whole surface, so folding more often costs more.

**riscv is the counterexample that shows the apparatus works.** Two independent cells both
fixed every injected defect (`G_directed` 11/11, compliance 84/0, torture 20/0, cosim 6/0,
formal all-pass, tamper 7705-checked/0-modified). They differ by exactly 0.06 -- the weight
of `G_build`, which scored 0 in one cell because `rv32ui/add` reported **SKIP** and
`rc=1` rather than a failure. Every other gate is byte-identical between them. Neither
wrote `JOURNAL.md`, which is a real and consistent 0.12 omission.

**commit0 is the one clear shortfall**: 58/784, sealed sandbox, and concentrated -- tinydb
55/204, sortedcontainers 3/297, cachetools 0/283 (its test file failed to collect). Three
libraries in 400 turns got through roughly one.


### 3.7 The provider outage, and what it did to the results

The endpoint began answering `HTTP 429 Upstream request failed: Rate limit exceeded` and stayed
there. The effect on the lane is measurable and is recorded here because it is the difference
between "a cell scored zero" and "a cell was never measured".

    termination                      cells   what it means
    model-reported-completion            9   the model finished; a measurement
    provider-outage-exceeded             6   the 2h ceiling; NOT a measurement
    provider-failures-exceeded          16   all at exactly 61 failures; NOT measurements
    turn-budget-exhausted                7   the pre-fix batch; see 3.5
    empty-streak                         -   the model produced nothing repeatedly

**Sixteen cells stopped at exactly 61 provider failures**, which is the consecutive-failure
ceiling doing its job: it converts an unbounded wait into a bounded, labelled outcome. Without it
those cells would have sat until their time budget expired and reported a score, and a score of
0.0 produced by an unreachable endpoint is indistinguishable in a results table from a score of
0.0 produced by a model that could not do the task.

**Several cells do carry a reward AND a high failure rate** -- `2ALnjyE` economy at R=0.0 with
252 failures in 583 calls (43%), `UeugNPr` quality at R=0.6 with 191 in 412 (46%). Those numbers
should not be read as measurements of the model, and the rule this report adopts is that **a cell
whose termination names the provider is excluded from the comparison regardless of the reward it
carries.** A reward computed from a run in which the model was denied the provider for half its
turns is a measurement of the outage.

**The limit is NOT self-inflicted, and the monitor is what settles it.** The obvious
hypothesis for a rate limit is our own concurrency -- eight cells plus probes against one endpoint.
It is testable, because `ef-monitor-provider.sh` sends **one** request every two minutes,
independent of the lane: a single request every 120 seconds cannot be rate-limited by us. It was
refused on **fourteen consecutive probes**, so the endpoint is refusing traffic it could not
plausibly be rationing.

That matters for the response rather than for the diagnosis. If the limit were ours, the fix would
be to reduce concurrency and the eight-cell measurement would be wrong. Since it is not, reducing
concurrency would cost cells and change nothing -- and the correct response is to wait, which is
what the lane is doing.

**The same probe also rules out an alternate model.** `space-bunny-free`, the model the launcher
defaults to when `EF_LIVE_MODEL` is unset, answers `HTTP 400 Model is unavailable` -- a
DETERMINISTIC failure, distinct from the 429. The retry classifier added for the memory driver
refuses to retry it, which is correct: a request that names an unavailable model will name it
again, and retrying only spends the budget.

**From the fully fixed code (`d449c93`) exactly two cells completed normally**: `qrCmKnF`
balanced at 0.7977 and `H7GD76Z` basic at 0.575. Everything else from that wave either hit the
outage ceiling or is still running. That is the honest state of the four-tier comparison: two
cells, both from the fixed apparatus, neither of which is enough to carry the claim in 3.5.

### 3.6 What the four-tier comparison may and may not say

**May say**: on this task, at 400 turns, with one cell per arm, the folding arms did not
beat the baseline, and they were cheaper per call.

**May not say**: that folding does not help. n=1 cannot separate 0.009 (basic against
quality) from noise, and it cannot separate the 0.125 spread from variance either. The
comparison needs the second attempt per arm that is still owed, and it needs the positive
control that would show the measurement can detect a difference at all.

**And it cannot say the models were given a fair shot at the task**: 400 turns is the cap
that bound, not the 28800 s budget. Whether the tiers separate when given the full budget
is a different experiment, and the cap has to move first.
