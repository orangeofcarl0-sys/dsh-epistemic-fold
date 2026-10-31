# 146 — The long-digest regime is a model property, and exit's benefit tracks checkpoint size

Status: measured 2026-10-31 on OmniGate (`deepseek-v4.1-flash`), n=1 per cell.
Parent `d650676`. This is the first item of docs/145 section 6, and it produced a qualifier on
the headline rather than a replication.

## A. The question, and what was already true

docs/145 said docs/144 lives in the cheapest checkpoint regime the bench can produce. Checking
that first: OmniGate writes **1,178 characters per fold at 252K** (range 465-2,729) against
`cat-jam-free`'s 100-330. So docs/144 is already 3.5-5x longer than docs/139 and the claim was
too pessimistic about its own evidence.

But 1,178 characters is still only ~295 tokens of digest, so the checkpoint stays around 300-400
tokens. The question became: is digest length a CONFIGURATION lever (the preset's hint budget) or
a model property?

## B. The hint is a lever, and this model saturates at ~1,200 characters

Same tier, same protocol, three presets differing only in `rationaleHintTokens`:

| preset | hint | chars/fold | accuracy |
|---|---|---|---|
| economy | 400 | 389 | 0.8775 |
| balanced | 800 | 1,038 | 0.9167 |
| quality | 1,600 | 1,178 | 0.9010 |

The hint moves the digest -- 400 to 800 roughly triples it -- but 1,600 buys only 14% more than
800. **The model saturates near 1,200 characters per fold regardless of the ask.**

So the long-digest regime is not reachable on this route by configuration. It needs a different
model, and that is a statement about the model rather than about EF or the bench. Recorded so a
future round does not spend a sweep rediscovering it.

## C. The qualifier this puts on the headline

exit's growth reduction is not a constant. Read across every cell measured so far:

| checkpoint kind | tier | reduction | source |
|---|---|---|---|
| prose digest, ~300 tokens | 252K | **73%** | docs/144 (n=5) |
| prose digest, ~300 tokens | 475K | **84%** | docs/144 (n=5) |
| prose digest, ~300 tokens | 131K | 83% | docs/141 |
| anchored, ~166 coordinate lines | 252K | **33%** | docs/143 (n=1) |
| anchored, ~166 coordinate lines | 131K | 77% | docs/141 |

**The larger the checkpoint, the smaller the share exit removes** -- which follows from what exit
does: it tombstones the checkpoint node, and what survives is the NEXT checkpoint, which under
anchors re-renders the whole coordinate set anyway. A big checkpoint's replacement is still big.

So the deployable sentence needs its qualifier: **exit removes 71-84% of the growth of
prose-sized checkpoints, and about a third when the state is carried as coordinates.** Both are
supported; only the first was in docs/144.

## D. What this does NOT change

- The mechanism claims (docs/145 section 2) are unaffected: retirement never touches the archive,
  the tombstone carries the reference, and a checkpoint is bounded by coordinate.
- The `conflicts 0` invariant held in every cell of this round too.
- The recommendation stands that the regime where checkpoint growth actually bites -- a model
  writing multi-thousand-token digests -- is not reachable here, and is one route change away.

## E. Reproduce

    EF_LIVE_BASE_URL=http://127.0.0.1:17866/v1 EF_LIVE_MODEL=deepseek-v4.1-flash \
    EF_MEMORY_DRIVER=phased.py EF_MEMORY_WINDOW=258048 \
      bash eval/memory/run-memory.sh --arm economy|balanced|quality --phases 4 \
      --parts-per-phase 2 --anchors off --phase-exit none --out <file>
