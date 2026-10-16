# 123 — The archive already contains folds: 21-47 of them, on the OTHER model

Status: answering "what about the other sweep tasks". 2026-10-16. Parent `445cbcf`.

## A. There are only two sweep tasks, and one of them is unusable

`eval/lhtb/lhtb-ef-sweep.yaml:127-129`:

```yaml
task_names:
- unknown-config-semantics
- vector-db-iterative-build
```

Measured across the four archived arms (2026-10-05):

```
task                        calls        folds
unknown-config-semantics    212 - 372    21 - 47
vector-db-iterative-build     3 -  20     0 -  1
```

**`vector-db-iterative-build` terminates in 3-20 calls and barely folds at all.** It is not a fold
vehicle. The config already said why in prose (`:86-88`): "vector-db needs fewer turns ... one is
turn-hungry, the other is not."

## B. The fold HAS been observed -- on a model I stopped using

```
arm       cell                          calls   folds
economy   unknown-config-semantics      372      31
economy   unknown-config-semantics      243      21
quality   unknown-config-semantics      369      47
quality   unknown-config-semantics      212      23
balanced  unknown-config-semantics      179      13
basic     unknown-config-semantics       48       4
basic     unknown-config-semantics      277      32
```

**And the cell's own config records which model:**

```json
"model_name": "openai/space-bunny-free",
"override_timeout_sec": 10800.0
```

## C. The comparison that answers the question

```
                      2026-10-05 archive        my recent runs
model                 space-bunny-free          cat-jam-free / deepseek-v4.1-flash
calls                 179 - 372                 62 - 75
FOLDS                 13 - 47                   0
tokLast               ~13,000 - 16,000          30,245 - 59,391
```

**Same task, same EF arms, opposite outcome -- and the variable is the model.** `space-bunny-free` kept
working for 179-372 calls; cat-jam finished the task at 62 and deepseek was cut by the output budget at
75. **The fold is not unreachable. It has simply not been reached since the model changed.**

**This supersedes the window analysis of `docs/122` as the primary explanation.** `docs/122` measured
that cat-jam's window is 1,048,576 and that 65,536 is 6.25% of it -- a real calibration problem -- but
the archive shows folds happening on a model that simply keeps going, which is the larger effect.

## D. Where that model lives, and why that matters today

```
/zen/go/v1   ->  space-bunny        (37 models)
/zen/v1      ->  space-bunny-free   (49 models)     <- what the archive used
```

**`space-bunny-free` is on `/zen/v1`, the route whose THREE gates were solved today**
(`docs/110`: time-encoded session id, `stream: true`, and tool declarations named `read`/`bash`).
Before today that route answered `403 FreeTierError` to every call, which is why the model was
abandoned -- **and the reason it was abandoned is now fixed.**

## E. What this implies for the next run

```
task      unknown-config-semantics      the fold-capable one
model     space-bunny-free              the one that folds
route     https://opencode.ai/zen/v1    needs EF_LIVE_ZEN_FREE=1 + EF_LIVE_STREAM=1
turns     >= 400                        the archive ran 179-372 calls
```

Two caveats, stated rather than assumed: the free tier's per-IP quota was exhausted earlier today
(`429 FreeUsageLimitError`, docs/111), so availability must be re-checked first; and the threshold is
still 65,536, which `docs/122` shows is a calibration problem in its own right.
