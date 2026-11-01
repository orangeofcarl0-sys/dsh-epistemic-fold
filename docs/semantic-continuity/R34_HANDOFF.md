# R34 — Handoff

## State

```text
Repository        orangeofcarl0-sys/dsh-epistemic-fold
Branch            rc34-live-causal-pilot
Base              ad3020df0e22587f78490c19550fe6986f55af3f (R33 HEAD)
Worktree          F:/Codex_Work_Space/DSH plugin/ef-r34-pilot
Development set   r33-semantic-continuity-v2
Dataset digest    407148f0c3280ada831b72150640ac6cdf14dceae600c3dcdbf2a61bd8e0c87f
Holdout           r33-semantic-continuity-holdout-v1
Holdout digest    af22eb7a91155507998750f0428be8bb7c6285696179128a75e83f3eeaada663
Scorer            v2
Live status       not-executed / blocked (0 provider requests)
```

The primary worktree and the R30/R31/R32/R33 worktrees are untouched. R33 is
preserved as a fixed comparison baseline.

## What changed

- The live budget is enforced at the HTTP-attempt edge, with immutable
  snapshots and separate observed/reserved/unknown/partial usage.
- Child processes receive an environment allowlist; secrets are not inherited.
- Every replicate has a fresh workspace; a collision is an error.
- The hidden checker runs in a trusted bootstrap outside the workspace; import
  time cannot spoof its result; checks are declared and validated.
- Gold quotes are bound to every authoritative sourceRef; corroborating
  citations are separate.
- Claim correctness no longer falls back to a same-coordinate counter-claim;
  source support is scored separately.
- `compareTreatment` replaces the reversed `pairwise` API.
- FM-1/FM-2/FM-3 are reported separately.
- A missing receipt without a bundle state witness now fails closed; legitimate
  current-format recovery still works.
- The live/self-test rows record writer call/protocol/raw output, proposals,
  refusals, committed state, checkpoint, and source event seqs.
- B1/S/O1/O2 are executable through the real fold host; O1 traverses the real
  validator/journal/working set.
- Dataset v2 is frozen, the separate holdout is frozen, and v1 is preserved.

## Commands

```bash
npm run build                    # rebuild lib/ (gitignored, required by live.mjs)
npm run eval:r33-freeze          # freeze/verify v2 development set
npm run eval:r33-verify
node eval/r33/freeze.mjs --holdout --verify

npm run eval:r33                 # R33 + R33.1 targeted suites
npm run eval:build               # build eval/live/dist for a live run
npm run eval:r33-live-check      # interface, no credentials
npm run eval:r33-self-test       # four arms, real host, scripted model, no provider

# Live is BLOCKED without all of:
#   R33_LIVE=1, a resolved route, positive limits, maxOutputTokens,
#   and an explicit cost authorization.
R33_LIVE=1 node eval/r33/live.mjs --run --manifest eval/r33/live-manifest.example.json
```

The example manifest contains environment variable NAMES, never values. Do not
put credentials or authorization headers in it.

## Results

- Scripted offline: B1 7/17, S 15/17, O1 16/17, O2/OR/F 17/17, N 3/17,
  FM-1 detected 8/8. S rescues 8 B1 failures with 0 damage.
- S failures: H1 (writer omitted the fact) and F4 (12-delta limit). O1 fixes H1
  but also hits F4, separating writer coverage from runtime capacity.
- Four-arm self-test: 68/68 through the real fold host; S 17 writer calls/30
  accepted, O1 17 oracle calls/33 accepted, B1/O2 no semantic path.
- Full suite: 1421 passed, 4 failed, 66 skipped. Three failures are the known
  installed-vs-vendored DSH drift assertions; the fourth is a load-sensitive
  host-suite test that changes identity between runs and passes alone. No
  R33/R33.1 test fails.
- Live: 0 requests, 0 tokens. The gate returns `not-executed`; an absent route
  returns `provider-unavailable`; neither sends a request.

## Known limits

- The custom text-JSON loop is NOT the production DSH agent loop.
- `recall` searches the frozen transcript, not production `context_search`.
- Same-user code is not OS-sandboxed; `ISOLATION_LEVEL.osSandbox` says `none`.
- The holdout is frozen but not executed.
- No Handoff-Only/Delta-Only ablation and no real retrieval-trigger run.
- The scripted 15/17 result is not a real-model accuracy.

## Next step (requires the user)

Run the live writer-only pilot first, on 4–6 cases, with:

- explicit authorization to spend credits;
- a resolved provider + model id;
- a positive request, input, output, and wall-clock budget;
- a per-request `maxOutputTokens`;
- a secure route environment (the key only in an environment variable).

Save the raw output and usage before changing any writer prompt. If the live
writer shows a coverage failure, R35 targets the writer; if it reproduces the
F4 capacity limit, R35 targets capacity; if retrieval is the gap, R35 studies a
gap hint or bounded prefetch. Do not start a new memory subsystem before that
evidence exists.

## Review package

`R34_REVIEW_PACKAGE/` (not committed) contains the patch, commit patches,
test logs, manifests, reports, docs, and checksums. It contains no credentials,
authorization headers, or private environment values.
