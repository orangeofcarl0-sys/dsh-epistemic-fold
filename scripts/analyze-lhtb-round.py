#!/usr/bin/env python3
"""Summarise an LHTB round: hard scores, efficiency, and the section-4 invariants.

## What it reads, and what it refuses to infer

Per cell it reads the EF transcript's telemetry and the verifier's output, then
reports them SEPARATELY rather than folding them into one number. That is
deliberate: the composite reward hides information. A cell with recall 0.9010 and
a 368x distance ratio scored 0.0778, because the task's own recall floor (0.95)
gates the ratio out entirely -- reporting only the composite would present an
excellent index as a failure.

## The three layers, kept apart

  HARD     recall plus the distance-computation ratio; deterministic, and the only
           thing that should decide whether an arm worked
  EFFORT   tokens, and tokens per hard point earned; machine-independent
  SOFT     wall clock, the official speedup reward, stage progression; recorded
           because it is what the benchmark reports, never gated on

## Missing is not zero

A cell whose vector-db implementation never ran has NO ratio. It is reported as
absent, never as 0.0, because 0.0 is a measurement and absence is not.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics as stats
import sys
from pathlib import Path

INVARIANTS = ("I1", "I2", "I3")


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def pick(pattern: str, text: str):
    import re
    found = re.search(pattern, text)
    return found.group(1) if found else None


TASK_LABELS = {
    "vector-db-iterative-build": "vector-db",
    "unknown-config-semantics": "unknown-config",
    "riscv-core-debug": "riscv",
    "commit0-multilib-tdd": "commit0",
}


def cell_record(cell: Path) -> dict | None:
    transcript = read_json(cell / "agent" / "ef-transcript.json")
    if transcript is None:
        return None
    telemetry = transcript.get("telemetry") or {}
    stdout = ""
    path = cell / "verifier" / "test-stdout.txt"
    if path.exists():
        stdout = path.read_text(encoding="utf-8", errors="replace")
    reward_path = cell / "verifier" / "reward.txt"
    reward = None
    if reward_path.exists():
        try:
            reward = float(reward_path.read_text(encoding="utf-8").strip())
        except ValueError:
            reward = None
    # ## riscv's reward is a weighted GATE SUM, and the gates are the interesting part
    #
    # riscv-core-debug writes verifier/scorecard.json alongside reward.txt: per-gate
    # weights and scores, plus a tamper check over the read-only harness. A bare 0.28 says
    # nothing about whether the model failed to build, failed the directed tests, or never
    # started -- the gates say which. Read here so the report can attribute rather than
    # just rank.
    # ## The fields that decide whether a number may be TRUSTED at all
    #
    # Two of the three tasks ship integrity evidence beside the reward and the analyser was
    # reading neither:
    #
    #   unknown-config  reward.json carries raw_ungated and baseline_ungated. The reward is
    #                   normalised as (raw - floor) / (1 - floor); without both ends the
    #                   normalisation cannot be checked, and a reward that looks low could
    #                   be a floor that moved.
    #   commit0         score_breakdown.json carries sandbox_sealed and, when the guard
    #                   fires, cheat_warning. Its libraries are public, so a reachable
    #                   network means the real sources could simply be fetched -- in which
    #                   case the score is zeroed and is not a measurement of anything.
    #
    # A reward with its integrity flag unread is a number of unknown provenance.
    reward_json = read_json(cell / "verifier" / "reward.json") or {}
    breakdown = read_json(cell / "verifier" / "score_breakdown.json") or {}
    scorecard = read_json(cell / "verifier" / "scorecard.json") or {}
    gates = [
        {"id": g.get("id"), "weight": g.get("weight"), "score": g.get("score")}
        for g in (scorecard.get("gates") or [])
        if isinstance(g, dict)
    ]
    tamper = scorecard.get("tamper") or {}
    results = read_json(cell / "verifier" / "test_results.json") or {}
    metrics = results.get("metrics") or {}
    ratio_text = pick(r"Distance ratio:\s*([0-9.]+)x", stdout)
    # Recall@10 carries a literal "@". An earlier revision of this file used "@" as a
    # placeholder for a backtick and rewrote it here too, so the pattern searched for
    # "Recall`10" and matched nothing -- every cell that HAD a recall printed a
    # dash, silently. A placeholder that can occur in the content it fills is not one.
    recall_text = pick(r"Recall@10:\s*([0-9.]+)", stdout)
    official = pick(r"OFFICIAL REWARD:\s*([0-9.]+)", stdout)
    return {
        "cell": f"{cell.parent.name}/{cell.name}",
        "job": cell.parent.name,
        # ## The task comes from the cell's own directory name, not from a default
        #
        # This was "vector-db" if the name starts with vector-db else "unknown-config" --
        # a binary that silently files EVERY other task under unknown-config. With three
        # tasks now running in parallel it would have reported riscv-core-debug and
        # commit0-multilib-tdd cells as unknown-config cells, and every per-task mean
        # would have been an average over tasks that have nothing to do with each other.
        # The cell directory is named <task>__<id>, so read that.
        "task": TASK_LABELS.get(cell.name.split("__")[0], cell.name.split("__")[0]),
        "reward": reward,
        "recall": float(recall_text) if recall_text else metrics.get("recall"),
        "ratio": float(ratio_text) if ratio_text else metrics.get("distance_ratio"),
        "official": float(official) if official else None,
        "tokens": telemetry.get("tokensTotal"),
        "tokens_per_point": (round(telemetry["tokensTotal"] / reward, 1)
                             if reward and telemetry.get("tokensTotal") else None),
        # ## The cost axis is a COMPOSITION, not a total
        #
        # tokensTotal conflates three things a provider prices differently: input
        # served from cache, input charged at the miss price, and output. Read as a
        # total it once said economy was 40% MORE expensive than basic (2.09M against
        # 1.41M) when economy had simply made more calls -- per call its UNCACHED
        # input was 31% LOWER. A total cannot separate "did more work" from "carried
        # more context per step", and only the second is what a compression runtime
        # changes. Cache reads are a near-free consequence of a stable prefix; the
        # miss-priced input is the figure the policy actually moves.
        "calls": telemetry.get("modelCalls"),
        "uncached": telemetry.get("tokensUncachedInput"),
        "cache_read": telemetry.get("tokensCacheRead"),
        "output": telemetry.get("tokensOutput"),
        "cost": telemetry.get("costTotal"),
        "gates": gates,
        "raw_ungated": reward_json.get("raw_ungated"),
        "baseline_ungated": reward_json.get("baseline_ungated"),
        "submits": reward_json.get("submits"),
        "per_library": breakdown.get("per_library"),
        "sandbox_sealed": breakdown.get("sandbox_sealed"),
        "cheat_warning": breakdown.get("cheat_warning"),
        "tamper_checked": tamper.get("checked"),
        "tamper_modified": len(tamper.get("modified") or []),
        "folds": telemetry.get("folds"),
        "bundle_writes": telemetry.get("bundleWrites"),
        "pending": telemetry.get("pendingIntents"),
        "compaction_failures": telemetry.get("compactionFailures"),
        "failure_kinds": telemetry.get("compactionFailureKinds") or {},
        "provider_failures": telemetry.get("providerFailures"),
        "termination": telemetry.get("termination"),
        "pruner_mounted": telemetry.get("prunerMounted"),
    }


def arm_of(job: str) -> str:
    # Every tier, not just the first two. balanced and quality used to fall through to
    # "other", so two of the four arms were reported as an unnamed group -- and a
    # comparison that silently drops half its arms reports a confident number about
    # something else.
    for arm in ("quality", "balanced", "economy", "basic"):
        if arm in job:
            return arm
    return "other"


def invariants(record: dict) -> list[str]:
    problems: list[str] = []
    folds = record.get("folds") or 0
    writes = record.get("bundle_writes") or 0
    if writes < folds:
        problems.append(f"I1 revoked work: {writes} bundle writes < {folds} folds")
    if record.get("pending") not in (0, None):
        problems.append(f"I2 {record['pending']} intents never resolved")
    return problems


def mean(values: list[float]):
    clean = [v for v in values if v is not None]
    return round(stats.fmean(clean), 4) if clean else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", type=Path,
                        default=Path(os.environ.get("LHTB_ROOT", ".")) / "jobs")
    parser.add_argument("--prefix", required=True,
                        help="job-name prefix, e.g. lhtb-ef-20261010-13")
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()

    # ## Jobs that ran on stale pre-fix images are not data
    #
    # harbor reused cached images (force_build: false with dated tags), so a whole wave ran
    # against July and June images -- the unknown-config cells with the probe pool and all
    # five spec revisions readable, the commit0 cells unable to import their own libraries.
    # Averaging those in contaminates every per-arm figure with cells that were never
    # measuring this task. Excluded by name rather than deleted, so the exclusion is
    # auditable: ef-phase7-logs/INVALID-JOBS.txt.
    invalid_path = (Path(__file__).resolve().parent.parent
                    / "ef-phase7-logs" / "INVALID-JOBS.txt")
    invalid = set()
    if invalid_path.exists():
        invalid = {ln.strip() for ln in
                   invalid_path.read_text(encoding="utf-8").splitlines()
                   if ln.strip() and not ln.strip().startswith("#")}

    records = []
    for job in sorted(args.jobs.iterdir()):
        if not job.is_dir() or not job.name.startswith(args.prefix):
            continue
        if job.name in invalid:
            print(f"  EXCLUDED {job.name}: stale pre-fix image (INVALID-JOBS.txt)")
            continue
        for cell in sorted(job.iterdir()):
            if cell.is_dir():
                record = cell_record(cell)
                if record:
                    record["arm"] = arm_of(job.name)
                    records.append(record)

    if not records:
        print("no cells with transcripts under", args.prefix)
        return 1

    print(f"{'cell':>10} {'arm':>8} {'task':>15} {'HARD':>8} {'recall':>7} "
          f"{'ratio':>10} {'tokens':>9} {'tok/pt':>13} {'folds':>6} {'prov':>5} {'term':>26}")
    for record in sorted(records, key=lambda r: (r["arm"], r["task"], r["job"])):
        ratio = f"{record['ratio']:.2f}x" if record.get("ratio") is not None else "-"
        hard = f"{record['reward']:.4f}" if record.get("reward") is not None else "pending"
        recall = f"{record['recall']:.4f}" if record.get("recall") is not None else "-"
        tokens = str(record["tokens"] or "-")
        per_point = f"{record['tokens_per_point']:.0f}" if record.get("tokens_per_point") else "-"
        print(f"{record['cell'][-10:]:>10} {record['arm']:>8} {record['task']:>15} {hard:>8} "
              f"{recall:>7} {ratio:>10} {tokens:>9} {per_point:>13} "
              f"{str(record['folds']):>6} {str(record['provider_failures']):>5} "
              f"{str(record['termination'])[:26]:>26}")

    print("\n=== by arm and task ===")
    # ## Iterate what is PRESENT, not what someone listed last time
    #
    # These loops were hardcoded to arms ("basic", "economy") and tasks
    # ("unknown-config", "vector-db"). Every arm and every task added since then was
    # silently dropped from the table: balanced and quality have never appeared in a
    # by-arm row, and with three tasks running in parallel riscv and commit0 would have
    # been dropped too. arm_of() had the identical defect and was fixed the same way --
    # a hardcoded enumeration of a growing set goes stale without ever erroring.
    for arm in sorted({r["arm"] for r in records}):
        for task in sorted({r["task"] for r in records}):
            group = [r for r in records if r["arm"] == arm and r["task"] == task]
            if not group:
                continue
            scored = [r for r in group if r.get("reward") is not None]
            ratios = [r["ratio"] for r in group if r.get("ratio") is not None]
            impl = len([r for r in group if (r.get("recall") is not None)])
            work = [r for r in group if (r.get("folds") or 0) > 0]
            print(f"  {arm:>8} {task:>15}  n={len(group):>2}  scored={len(scored):>2}"
                  f"  mean HARD={mean([r['reward'] for r in scored])}"
                  f"  mean tokens={mean([r['tokens'] for r in group])}"
                  f"  folds>0: {len(work)}"
                  + (f"  mean ratio={mean(ratios)}" if ratios else ""))

    # ## Attribution for tasks whose reward is a gate sum
    #
    # A single number cannot distinguish "the model built nothing" from "it built and
    # failed the directed tests" from "it never got started". riscv-core-debug's scorecard
    # carries the split, so print it rather than making the reader guess from the total.
    gate_cells = [r for r in records if r.get("gates")]
    if gate_cells:
        print("\n=== riscv gate breakdown (scorecard.json) ===")
        for r in gate_cells:
            label = r["cell"].split("/")[-1][-7:]
            print(f"  {label}  reward={r['reward']}  "
                  f"tamper: {r.get('tamper_checked')} checked, "
                  f"{r.get('tamper_modified')} modified")
            for g in r["gates"]:
                print(f"      {str(g['id']):<16} weight={g['weight']:<6} score={g['score']}")

    # ## Provenance: what each number is, and whether it may be believed
    prov = [r for r in records if r.get("raw_ungated") is not None
            or r.get("sandbox_sealed") is not None]
    if prov:
        print("\n=== reward provenance ===")
        for r in prov:
            label = r["cell"].split("/")[-1][-7:]
            bits = [f"reward={r['reward']}"]
            if r.get("raw_ungated") is not None:
                bits.append(f"raw={r['raw_ungated']} floor={r['baseline_ungated']}")
            if r.get("submits") is not None:
                bits.append(f"submits={r['submits']}")
            if r.get("sandbox_sealed") is not None:
                bits.append(f"sealed={r['sandbox_sealed']}")
            print(f"  {label}  " + "  ".join(bits))
            if r.get("cheat_warning"):
                print(f"      !! {str(r['cheat_warning'])[:150]}")
            for lib, d in (r.get("per_library") or {}).items():
                print(f"      {lib:<16} {d.get('passed')}/{d.get('expected_total')} passed")

    print("\n=== section 4 invariants ===")
    bad = 0
    for record in records:
        problems = invariants(record)
        if problems:
            bad += 1
            print(f"  {record['cell']}: " + "; ".join(problems))
    basic_cells = [r for r in records if r["arm"] == "basic"]
    breached = [r for r in basic_cells if (r.get("bundle_writes") or 0) != 0]
    print(f"  I1/I2 violations: {bad}")
    print(f"  I3 (basic must write no bundles): {len(breached)} of {len(basic_cells)} breached")

    print("\n=== cost axis: composition PER CALL, not a total ===")
    print(f"{'arm':>8} {'cells':>5} {'calls':>6} {'cacheRead':>10} {'uncached':>10} "
          f"{'output':>9} {'hit%':>6} {'unc/call':>9} {'out/call':>9} {'$/call':>9}")
    for arm in ("basic", "economy", "balanced", "quality", "other"):
        group = [r for r in records if r["arm"] == arm and r.get("uncached") is not None]
        if not group:
            continue
        calls = sum(r["calls"] or 0 for r in group)
        cr = sum(r["cache_read"] or 0 for r in group)
        un = sum(r["uncached"] or 0 for r in group)
        ou = sum(r["output"] or 0 for r in group)
        cost = sum(r["cost"] or 0 for r in group)
        hit = 100 * cr / max(1, cr + un)
        print(f"{arm:>8} {len(group):>5} {calls:>6} {cr:>10} {un:>10} {ou:>9} "
              f"{hit:>5.1f} {un / max(1, calls):>9.0f} {ou / max(1, calls):>9.0f} "
              f"{cost / max(1, calls):>9.4f}")
    print("  uncached/call is the figure a compression policy moves: the context the")
    print("  model must actually READ. hit% is largely a consequence of a stable")
    print("  prefix, and output/call is the model's own verbosity, so neither is")
    print("  attributable to the runtime on its own.")

    print("\n=== provider health ===")
    total_pf = sum(r.get("provider_failures") or 0 for r in records)
    mounted = [r for r in records if r.get("pruner_mounted")]
    print(f"  providerFailures total: {total_pf}")
    print(f"  pruner mounted: {len(mounted)} of {len(records)}")
    kinds: dict[str, int] = {}
    for record in records:
        for kind, count in (record.get("failure_kinds") or {}).items():
            kinds[kind] = kinds.get(kind, 0) + count
    print(f"  compaction failure kinds: {kinds or '{}'}")

    if args.json:
        args.json.write_text(json.dumps(records, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
