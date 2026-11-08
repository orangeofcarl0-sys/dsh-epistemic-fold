# EF-C1 — Decision

Status: EF-C1A and EF-C1B are complete offline. No live experiment was run.
This document answers the six required questions and records the Track B
handoff.

## A. Evidence isolation

**Which real scripts wrote historical files?**

Measured before the fix (`eval/c1/out/observation-pre-*.json`):

| Trigger | Rewritten |
|---|---|
| `npm ci` | `cordis.patch.yml` |
| `tests/r33-live-entry.spec.ts` | `eval/r33/out/live-report.json`, `live-check.json` |
| `tests/r33-arms.spec.ts` | `eval/r33/out/offline-report.json`, `.md` |
| `tests/r1-report.spec.ts` | `docs/12_R1_EVALUATION_REPORT.md`, `docs/MANIFEST.json` |

**Which were legitimate candidate generation?** The R33 and R37 generators, the
preset/map generators, and `scripts/vendor-basic.mjs`. They are explicit
commands, not tests.

**Which were ordinary-test side effects?** All four rows above. The R1 test was
a generator disguised as a test; the R33 tests spawned a runner that wrote a
convenience copy; `prepare` rewrote the preset block on every install.

**After the fix**, all four triggers change **0** protected artifacts
(`observation-post-*.json`). `tests/c1-evidence-isolation.spec.ts` re-derives
the property for the cheap compare modes on every run.

**Is explicit generation preserved?** Yes:

- R1 report: `eval:r1-report:generate` (candidate) and `eval:r1-report:write`
  (promote).
- R33 offline report: `eval:r33-offline-report` (candidate).
- Docs manifest: `--output` / `--write`.
- Preset block: `--output` / `--write`; `--check` exits 2 on drift.
- Resolution maps: `--output` / default write; `--check` exits 2 on drift.

The historical reports were stale and were **promoted as an explicit,
authorized operation** in the C1 follow-up. Their pre-promotion drift is
declared with a cause and a digest in
`docs/convergence/data/report-baselines.json`; the previous bytes remain in git
at `327598f`.

- R1 report: a `checkpoint-root` attribution bucket was added; totals unchanged.
- R33 offline report: scorerVersion 2 → 3, with the R36/R37 behaviour fields.
- R33 live check: scorerVersion 3 and four fixture arms.
- R33 live report: a superseded refusal record (not promoted).

Promotion used `eval:r1-report:write`, `eval:r33-offline-report:promote` and
`live.mjs --check`; no test promoted anything implicitly.

## B. Test accounting

**Why 33 vs 24?** The C0 convergence suite added 33 tests. The full-suite net
gain was 24 because 9 tests stopped executing:

```text
tests/r38-native-context.spec.ts   9 -> 0
```

That file imports `eval/r38/native-context-smoke.mjs`, which imports
`@deepseek-ai/dsh-agent-loop`. The package was present in the R38 worktree's
`node_modules` but absent from `package.json` and `package-lock.json`. A clean
install cannot collect the file (0 tests, not 9 failures).

EF-C1 declares `@deepseek-ai/dsh-agent-loop@0.2.1-rc.3`; the 9 tests collect and
pass again. The arithmetic now closes:

```text
R38 1800 + 33 new = 1833
C0  1824 +  9 restored = 1833
```

**Which identities?** `eval/c1/out/test-accounting.json` lists all 33 added and
all 9 missing identities. The full lists are ~600 KB each and live under
`eval/c1/out/raw/` (gitignored), pinned by SHA-256 in the accounting file.

**Which disappeared or changed?** Exactly the 9 above; 0 status changes among
the 1791 identities common to both runs.

**Runner/environment differences?** Both runs used vitest 5.0.5, Node 24.14.1,
and the same installed DSH `0.2.1-rc.3`. The difference was the undeclared
package, not the runner.

**Irrecoverable historical data?** No identity was lost: the R38 and C0 suites
were re-run from their commits to reconstruct the lists. The R38 worktree's
`node_modules` state was not reproducible from the lock, which is the defect
recorded above.

## C. DSH compatibility

**Which combination is actually supported?** The CI pinned lane
(`vendor 0.2.0-rc.2` + install `0.2.1-rc.3`) is the declared supported lane. It
is a mixed lane and this round could not reproduce it locally. The local lanes
are:

```text
main worktree          vendor 0.1.7-rc.2 + install 0.1.7-rc.2   experimental
research worktrees     no vendor        + install 0.2.1-rc.3   experimental probe
CI pinned              vendor 0.2.0-rc.2 + install 0.2.1-rc.3   declared
```

**What is vendored Basic from?** `dsh-v0.1.7-rc.2`, per the `SOURCE` header in
`src/basic/config.ts`. The README's claim that the vendored checkout is
`0.2.0-rc.2` is false for this machine.

**What are the 12 failures?** Classified by identity in
`C1_DSH_COMPATIBILITY.md` §3:

```text
environment mismatch (no vendor tree)        4
host API hardening / fixture incompatibility 2
known upstream drift                         4
stale generated configuration                1
eval query bug (fixed)                       1
real plugin regression confirmed             0
```

11 remain after the B04 fix (4 + 2 + 4 + 1).

**Which are real compatibility risks?** None of the 12 is a confirmed product
defect. The only candidate was `eval-corpus > B04-failure-resolution`: the eval
query `verifiedFailureIds` read the raw `ef/anchor` type, while the 0.2.1
plugin-record transport writes `plugin:epistemic-fold/anchor`. The production
reducer already read both; the query now uses `efPluginRecordOf` and
`tests/eval-corpus.spec.ts` passes 19/19. No `src/` change was needed.

**Is there a fully passing supported Core Lane?** Not on this machine. The
`0.2.1-rc.3` lane has the 12 failures above; the `0.1.7` lane has the
`bridge-loads` version mismatch and cannot run the `>=0.2.0` APIs. The CI lane
is the only declared lane and is not locally reproducible.

## D. Basic compatibility

**Is EF `mode: basic` the same as the original source?** At the source level,
`rc7-vendored-basic.spec.ts` compares every module byte-for-byte against the
vendor reference; it passes when the vendor tree is present and reports
`not-verifiable` when it is absent (this worktree).

**Which behaviors match the current host?** On the shared fixture, B0
(`0.2.1-rc.3`) and Bv (EF's `0.1.7` copy) produce the same checkpoint body
(347 chars), the same prefix fingerprint, the same retained tokens, no EF
bundle, and the same contract outcomes for leaf fold, tool-pair boundary,
summary failure, abort and restart.

**Which differences are legal evolution?** The four upstream-drift failures
(plugin event naming, session format, host persistence capability) are version
evolution, not EF defects. The `frameCheckpoint` absence is by design: EF owns
the base class to supply the seam.

**Do tool pairing, abort and restart hold?** Yes, on both arms:
a call/result pair stays inside one span; an aborted fold writes no checkpoint
and changes no surface; a checkpoint is readable byte-identically after
event-log reconstruction.

## E. EF Core baseline

**Is E0 truly zero auxiliary calls?** Yes: `calls = 0` under the scripted
adapter, with one checkpoint and two archive writes.

**Does E1 add only the rationale?** Yes: `calls = 1`, `rationaleCalls = 1`,
`writerCalls = 0`.

**Do E0 and E1 share the fold policy?** Yes: same legal span (1-10), same
surface node count after the fold, same checkpoint count, same archive writes.
The checkpoint is 20 characters longer under E1 (47 → 67) and 5 prompt tokens
heavier (20 → 25); that is the rationale text.

**Token / checkpoint / cache differences?** The checkpoint and prompt-side token
differences are recorded. Cache read/write is **not measured**: the scripted
adapter has no provider cache. No cost claim is made.

**Is a real product economics comparison ready?** The arms and the offline
certification are ready; the experiment is not authorized. See
`C1_LIVE_PREREGISTRATION.md`: status `not-authorized`, 0 provider calls, six
blocking conditions.

## F. Git and scope

**Was any R30-R38/C0 historical evidence modified?** No. The protected registry
covers 287 artifacts; after the fixes, all 287 match their HEAD hashes. The
pre-fix mutations were restored, and the post-fix observations show 0 drift.
The R38 and C0 worktrees were used for identity reconstruction and restored to
their commits; no historical evidence was left changed.

**Was the production semantic runtime modified?** No. `src/semantic/*` is
unchanged. The changes are tests, eval tooling, scripts, `package.json`, CI and
documentation.

**New branch / tag / push / PR?** One local branch `chore/ef-c1-evaluation-foundation`
in worktree `ef-c1-foundation`. No tag, no push, no PR, no merge, no rebase, no
deletion.

**How do Track A and Track B continue independently?**

- Track A (product) lives on `main` and the C1 foundation. Its next work is a
  supported-lane declaration and the vendor alignment.
- Track B (semantic continuity) lives on the R38 line. It must not enter the
  C1 arms; E0/E1 run with `semanticContinuity: off`.

## G. Track B handoff

**Risk still present.** The `decision` authority domain does not distinguish a
user-origin decision from an assistant-origin decision:

```text
src/semantic/retirement.ts   RETIREMENT_POWER.decision = 4
src/semantic/ops.ts          AUTHORITY_DOMAINS includes one 'decision'
src/semantic/retirement.ts   comment: "a decision was taken (user or assistant)"
```

An assistant decision therefore has the same retirement standing as a user
decision, and can retire another decision in the same scope. R38's
relation-security audit (8/8 scenarios) certifies the *rank* boundaries; it does
not split the `decision` domain.

**Evidence.** `eval/r38/out/relation-security-audit.json` (8/8, blocked at
planner 5 / validator 1 / none 2); `docs/convergence/BOUNDARY_CONTRACTS.md`
(uncertified edge); this section.

**Start SHA.** The C1 handoff commit (the final commit of this round). Branch
from it, not from R38, so the research branch inherits the evidence-isolation
foundation.

**Does it affect C1's B0/E0/E1?** No. Those arms run with
`semanticContinuity: off` and no semantic writer or commit path. The risk is in
the Active/S0 line only.

**Conditions for promotion into the product line.** All four:

1. a mechanism certification of the split (user vs assistant decision), with a
   minimal failing case;
2. an offline ablation showing the split does not lose legitimate assistant
   decisions;
3. a live experiment under the same preregistration discipline as C1;
4. an explicit deployment decision. Mechanism certification alone is not a
   product result.

## Unresolved issues

1. The local vendor tree is `0.1.7-rc.2` while the code declares `>=0.2.0-rc.2`.
   The README and the tree disagree.
2. The CI pinned lane (`0.2.0-rc.2` vendor + `0.2.1-rc.3` install) was not
   reproducible here.
3. The R1 report and the R33 offline report are now current; the next drift
   needs a new declaration, and promotion remains an explicit operation.
4. `docs/MANIFEST.json` must be regenerated after this round's docs (done in the
   final commit).
5. Semantic decision authority (Track B) remains unsplit.
6. No live experiment is authorized.
