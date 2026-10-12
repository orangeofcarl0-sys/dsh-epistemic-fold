#!/usr/bin/env python3
"""Drive one memory-pressure cell, or a calibration sweep.

Implements docs/62_MEMORY_PRESSURE_TASK_DESIGN.md section 10.5. The ordering in that sequence is
not arbitrary and each constraint is marked where it is enforced.

    init(system prompt, NO tools)      push paradigm: the model acts not at all (6.7)
    append every document              phase 1, ingestion
    compact N times                    the independent variable (section 4)
    inject, for arms B and C           AFTER compaction, or the injection is folded (5.4)
    compaction OFF                     measure a state, do not change one (5.4)
    step(probe turn)                   phase 2, ONE turn (5.3)
    score                              deterministic, no LLM

Calibration is the same sequence stopped early: ingest, then fold repeatedly, recording the
surface size after each fold, so the depth that reaches the target size is found rather than
guessed (10.6).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
EF_ROOT = HERE.parent.parent
sys.path.insert(0, str(EF_ROOT / "eval" / "bridge"))
sys.path.insert(0, str(HERE))

from ef_bridge_client import ARM_SPECS, EpistemicFoldBridge  # noqa: E402
import score_probes  # noqa: E402

# Minimal on purpose (6.9): any instruction to be concise or to summarise changes what the
# compressor does and contaminates the independent variable.
SYSTEM_PUSH = (
    "You will receive a series of documents. Read them as they arrive. "
    "After the last one you will be asked questions about them."
)
# The warning factor (6.3). The statement reaches the SUMMARISER too, so it may change what the
# compressor keeps rather than what the model attends to; the telemetry can tell those apart.
SYSTEM_WARNED = SYSTEM_PUSH + " You will be asked to recall specific details, so retain them."


def step_with_retry(bridge, max_attempts: int = 6, base_sleep: float = 5.0) -> tuple[dict, int]:
    """One model call, retried through a provider failure.

    The probe turn is the whole measurement, so a 429 that lands on it would report a cell as
    total retention failure when nothing was measured at all. The retry is bounded and backs off,
    and the number of attempts is recorded, because "the provider was busy" and "the model could
    not recall" are different findings.
    """
    failures = 0
    for attempt in range(max_attempts):
        reply = bridge.step()
        if not reply.get("error"):
            return reply, failures
        failures += 1
        time.sleep(min(base_sleep * (2 ** min(failures, 4)), 120))
    return reply, failures


def load(name: str) -> dict:
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def run_calibration(arm: str, order_name: str, max_depth: int, target_frac: float) -> dict:
    """Ingest once, then fold repeatedly, recording the surface size after each fold.

    The target is a RATIO of the ingested size, not an absolute: an absolute silently stops being
    matched when the corpus is resized (10.6).
    """
    orders = load("orderings.json")
    docs = load("documents.json")
    by_key = {f"{pid}/{d['name']}": d for pid, ds in docs.items() for d in ds}

    bridge = EpistemicFoldBridge(arm=arm, bundle_root=str(HERE / "_bundles"),
                                 domain="memory", task_id=f"calib-{arm}-{order_name}")
    bridge.init(SYSTEM_PUSH, [])
    for key in orders[order_name]:
        d = by_key.get(key)
        if d is not None:
            bridge.append({"role": "user", "content": d["text"]})

    # Measured after the LAST append: the telemetry carried by `init` describes an empty
    # session, and reading it there reported an ingested size of zero for a full corpus.
    # Measured after the last append: the telemetry carried by `init` describes an empty session.
    ingested = bridge.last_telemetry.get("promptTokensLast", 0)
    target = int(ingested * target_frac)
    sweep = []
    for i in range(1, max_depth + 1):
        committed = bridge.compact()
        t = bridge.last_telemetry
        sweep.append({
            "attempt": i, "committed": committed,
            "tokens": t.get("promptTokensLast"), "nodes": t.get("surfaceNodesLast"),
            "folds": t.get("folds"), "roots": t.get("roots"), "emergencies": t.get("emergencies"),
        })
        if committed and (t.get("promptTokensLast") or 0) <= target:
            break
    bridge.close()
    reached = [s for s in sweep if s["committed"] and (s["tokens"] or 0) <= target]
    return {
        "arm": arm, "order": order_name, "ingested_tokens": ingested,
        "target_frac": target_frac, "target_tokens": target,
        "sweep": sweep,
        "depth_to_target": reached[0]["attempt"] if reached else None,
        # A mechanism that cannot reach the target is a FINDING, not something to hide by
        # choosing a target it happens to hit (10.6).
        "reached": bool(reached),
    }


def run_cell(arm: str, order_name: str, depth: int, mode: str, warned: bool,
             inject: bool, limit_docs: int | None) -> dict:
    orders = load("orderings.json")
    docs = load("documents.json")
    public = load("public_probes.json")
    key = load("answer_key.json")
    by_key = {f"{pid}/{d['name']}": d for pid, ds in docs.items() for d in ds}

    bridge = EpistemicFoldBridge(arm=arm, bundle_root=str(HERE / "_bundles"),
                                 domain="memory", task_id=f"{mode}-{arm}-{order_name}")
    bridge.init(SYSTEM_WARNED if warned else SYSTEM_PUSH, [])

    seq = orders[order_name]
    if limit_docs:
        seq = seq[:limit_docs]
    appended = 0
    for k in seq:
        d = by_key.get(k)
        if d is not None:
            bridge.append({"role": "user", "content": d["text"]})
            appended += 1
    # Read AFTER the last append. The first draft read it from the telemetry carried by `init`,
    # which describes an empty session, so a full corpus reported an ingested size of zero.
    ingested = bridge.last_telemetry.get("promptTokensLast", 0)
    ingested_docs = appended

    folds = 0
    for _ in range(depth):
        if bridge.compact():
            folds += 1

    # Injection AFTER compaction, so the injected tokens cannot be folded (5.4).
    if inject:
        needed = sorted({p for pr in key["probes"] for p in pr.get("needs", [])})
        for pid in needed:
            for d in docs.get(pid, []):
                bridge.append({"role": "user", "content": d["text"]})

    # Measure a state, do not change one (5.4).
    compaction_on = bridge.set_compaction(False)

    turn = score_probes.render_probe_turn(public)
    started = time.monotonic()
    reply, probe_failures = step_with_retry(bridge)
    elapsed = time.monotonic() - started
    text = reply.get("content") or ""
    parsed = score_probes.parse_answers(text, [p["id"] for p in key["probes"]])
    result = score_probes.score(key, parsed)
    telemetry = bridge.last_telemetry
    bridge.close()

    return {
        "cell": {"arm": arm, "order": order_name, "depth": depth, "mode": mode,
                 "warned": warned, "inject": inject, "compaction_disabled": not compaction_on},
        "ingested_tokens": ingested, "ingested_docs": ingested_docs,
        "folds_requested": depth, "folds_committed": folds,
        "probe_turn_chars": len(turn), "probe_seconds": round(elapsed, 1),
        "probe_provider_failures": probe_failures,
        # The first 400 characters of the reply, so a parse failure is diagnosable from the
        # result file rather than only from a rerun.
        "reply_head": text[:400],
        "parsed": {"strict": parsed["parsed_strict"], "loose": parsed["parsed_loose"],
                   "unparsed": len(parsed["unparsed"])},
        "score": {k: v for k, v in result.items() if k != "rows"},
        "rows": result["rows"],
        "telemetry": {k: telemetry.get(k) for k in
                      ("folds", "roots", "emergencies", "compactionFailures",
                       "compactionFailureKinds", "promptTokensLast", "surfaceNodesLast",
                       "costTotal", "providerFailures")},
        "foldLineage": telemetry.get("foldLineage", []),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", default="quality", choices=sorted(ARM_SPECS))
    ap.add_argument("--order", default="logical", choices=["random", "temporal", "logical"])
    ap.add_argument("--depth", type=int, default=5)
    ap.add_argument("--mode", default="A", choices=["A", "B", "C", "N"])
    ap.add_argument("--warned", action="store_true")
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--max-depth", type=int, default=40)
    ap.add_argument("--target-frac", type=float, default=0.20)
    ap.add_argument("--limit-docs", type=int, default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.calibrate:
        out = run_calibration(args.arm, args.order, args.max_depth, args.target_frac)
    else:
        inject = args.mode in ("B", "C")
        out = run_cell(args.arm, args.order, args.depth, args.mode, args.warned,
                       inject, args.limit_docs)

    path = Path(args.out) if args.out else (HERE / f"result_{args.mode}_{args.arm}_{args.order}.json")
    path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    if args.calibrate:
        print(f"calibration {args.arm}/{args.order}: ingested {out['ingested_tokens']} tokens, "
              f"target {out['target_tokens']} ({out['target_frac']:.0%}), "
              f"depth_to_target={out['depth_to_target']} reached={out['reached']}")
        for s in out["sweep"][:12]:
            print(f"  attempt {s['attempt']:2d} committed={str(s['committed']):5s} "
                  f"tokens={s['tokens']} nodes={s['nodes']}")
    else:
        o = out["score"]["overall"]
        print(f"cell {args.mode}/{args.arm}/{args.order} depth={args.depth}: "
              f"folds {out['folds_committed']}/{out['folds_requested']}, "
              f"accuracy {o['accuracy']} (floor {o['chance_floor']}, unparsed {o['unparsed']})")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
