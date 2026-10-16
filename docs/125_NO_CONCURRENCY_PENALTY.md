# 125 — Withdrawn: there is no measurable concurrency penalty here

Status: claim withdrawn; measured. 2026-10-16. Parent `0c4f96d`.

## A. What I claimed, and why it was not evidence

After the quality arm's two cells completed at `raw_ungated 0.3678` (exactly the baseline), I wrote
that this was "consistent with the measured concurrency penalty", citing `lhtb-ef-sweep.yaml:71-81`:

```
concurrency   sec/call   calls/cell   cells that scored
8             39.3       138          1/8
```

**That table is a record of a DIFFERENT run** -- a different date, model and route. Quoting it as
evidence about this one was inference dressed as measurement.

## B. Measured instead

`telemetry.timing.series[].c` is the per-call duration. Eight concurrent cells against three
single-run cells, same model (`cat-jam-free`), same route:

```
8-WAY CONCURRENT SWEEP CELLS
  balanced  n=40  callMs mean 2,711  max 14,143
  balanced  n=38  callMs mean 2,993  max 19,438
  economy   n=40  callMs mean 2,650  max 16,173
  economy   n=40  callMs mean 2,025  max 12,377
  quality   n=40  callMs mean 2,198  max 10,698
  quality   n=32  callMs mean 1,639  max  7,099
  basic     n=40  callMs mean 2,849  max 13,516
  basic     n=40  callMs mean 2,070  max  8,311

SINGLE-RUN CELLS (no concurrency)
  204636    n=40  callMs mean 4,428  max 37,516
  235047    n=40  callMs mean 3,056  max 11,173
  183321    n=40  callMs mean 30,309 max 127,728
```

**The concurrent cells are FASTER per call (1.6-3.0s) than the single runs (3.0-4.4s).** No
concurrency penalty is visible in the model-call latency. **The claim is withdrawn.**

## C. What is actually observable

```
quality cell A   42 calls  raw_ungated 0.3678   model-reported-completion
quality cell B   32 calls  raw_ungated 0.3678   model-reported-completion
```

And the config says what that means structurally (`lhtb-ef-sweep.yaml:83-88`):

> unknown-config's stage A needs **21 fully-correct probe rounds**, so a cell needs on the order of
> **140 turns** to have a chance. At 51 turns all sixteen cells scored zero -- **not because the task
> is unsolvable but because the budget of turns was taken away.**

**A cell that finishes at 32 or 42 turns cannot pass stage A**, whatever the concurrency. The baseline
score follows from doing too few turns, and the termination reason is `model-reported-completion` --
**the model declared itself done**, not a budget cutting it off.

## D. What is NOT established

**Why these cells finish in 32-50 turns when the single runs did 62-72.** The candidates I can name --
the reduced reply budget (`EF_LHTB_REPLY_MAX_TOKENS=16384`), the arm, the `force_build` config -- I
have not separated, and **naming one would repeat exactly the mistake this document corrects.**

## E. The lesson worth keeping

A comment in a config file describing a measurement made elsewhere is **not** a measurement here.
I reached for it because it agreed with what I expected, which is the failure mode, not a shortcut.
