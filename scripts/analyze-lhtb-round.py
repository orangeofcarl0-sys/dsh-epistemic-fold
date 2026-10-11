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
        "task": "vector-db" if cell.name.startswith("vector-db") else "unknown-config",
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

    records = []
    for job in sorted(args.jobs.iterdir()):
        if not job.is_dir() or not job.name.startswith(args.prefix):
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
    for arm in ("basic", "economy"):
        for task in ("unknown-config", "vector-db"):
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
