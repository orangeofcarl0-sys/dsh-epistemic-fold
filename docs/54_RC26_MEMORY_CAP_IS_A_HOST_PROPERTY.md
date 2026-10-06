# RC26 — the memory cap is a property of the host, not of the repository

Found while running the §1 precondition table of `docs/50_PHASE7_HANDOFF.md` on the
host that host's own instructions were written for.

## 1. The claim, and what the machine says

The handoff, the runner and all three LHTB configs asserted that the WSL memory cap
is **8 GB**, one of them "verified three ways". On the machine running Phase 7:

| asserted | measured here |
|---|---|
| `~/.wslconfig` says `memory=8GB` | `memory=24GB` (`processors=24`, `swap=8GB`) |
| its own comment records a 2026-09-24 reduction from 12 GB to 8 GB **on a 15.2 GB host** | no such comment, and this machine has **31.2 GB** of visible RAM |
| `docker info` `MemTotal` = 8,326,361,088 bytes = 7.75 GiB | **25,197,441,024 bytes = 23.47 GiB** |

So the value two revisions called "false" — 24 GB — was the correct one here, and the
"correction" to 8 GB substituted one machine's measurement for another's.

## 2. Why it survived: the assertions could not fail

This is the part worth keeping. `tests/lhtb-parallelism.spec.ts` hardcoded
`const WSL_CAP_GB = 8` and used it in two assertions. At the measured cells
(192.8 + 15.7 = 208.5 MiB = 0.204 GiB), **both pass at any plausible value**:

```
cap = 8     <cap: true   <cap/2: true
cap = 24    <cap: true   <cap/2: true
cap = 0.5   <cap: true   <cap/2: true
```

The constant was decorative with respect to its own assertions. It could be wrong by
3x, or by 48x, and nothing changed. That is the `roots=0` shape once more — a number
that could not mean what it claimed, read as if it did — except inverted: here the
number was not a detector that could never fire but a **constant that could never
matter**, surrounding a claim ("this host has room") that only the host can answer.

## 3. Worse: the gate enforced the error

RC25 added a gate to stop the configs repeating the "24 GB" claim. It did that by
requiring them to match `cap IS 8 GB | memory=8GB` and rejecting `cap is 24 GB`.
Replaying that gate's own regexes against candidate prose:

```
FAIL  truthful-on-this-host (24 GB)
PASS  the committed text (8 GB)
PASS  a machine-agnostic sentence
```

Correcting the prose to match the machine **turned the suite red**. A gate cannot
answer a host question from a committed constant; one that tries will enforce
whichever host it was written on, and it will look green while doing it.

The file also disagreed with itself: its own module header said the cap "had already
been raised to 24 GB in `~/.wslconfig`" — true here — while the constant below it
held 8. Nothing read the machine, so nothing could notice.

## 4. What changed

**The spec asks the host.** `runtimeCapGb()` reads `docker info --format
'{{.MemTotal}}'` — the memory the runtime will actually hand a container, which is
what decides whether two cells fit — and falls back to parsing `~/.wslconfig`. It
returns `undefined` on a host that cannot be asked, and the cap assertion is behind
`it.skipIf`: **skipped, never passed on a default**. An unmeasured cap is not a
passing cap; this is the `ef-collect` rule applied to a host fact.

**The gate forbids the class, not one value.** No committed file may state a numeric
cap at all — the three configs and `scripts/run-lhtb.sh`, because all four ship to
other machines. The spec also fails if it regains a `WSL_CAP_GB` literal or stops
calling `docker info`. The rule is the host-independent one: a `memory_mb` is a
cgroup limit and not a reservation, plus the measured cells.

**The prose was corrected** in the runner, the three configs, the handoff §3, and as
a dated correction (not a rewrite) in `docs/51` §3 and `docs/53` §4, which are
records of what was believed then.

## 5. Verified

- The spec reads **23.47 GiB** on this host and the cell assertion passes against it.
- Reintroducing a numeric cap into any of the four files fails the gate; the runner
  was added to that list and the check was confirmed against each file in turn.
- With Docker unreachable the cap assertion **skips** — checked by asking for a cap
  on a host with no `docker` on PATH — rather than passing.
- The measured-cell gates (108 vs 193 MiB, and the combined figure) are untouched and
  still pass.

## 6. What this does not change

The conclusion the configs draw is unaffected and was never the problem: two
concurrent cells fit, with room for the build and verifier spikes. That reasoning is
host-independent — it rests on `memory_mb` being a limit rather than a reservation,
and on cells that measured two orders of magnitude under their declared limits. On
this host it holds with 23.47 GiB of headroom instead of the 8 GB the files claimed.
