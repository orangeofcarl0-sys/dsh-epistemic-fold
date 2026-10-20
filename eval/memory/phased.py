#!/usr/bin/env python3
"""Multi-phase memory protocol: ingest a phase, probe THAT phase, then the next.

## Why this is a separate driver rather than a flag on run_cell

run_cell implements one shape: ingest the whole corpus, fold, then ask every probe. That
shape has no moment at which any content is DONE -- everything is either in the context or
folded into a summary that is still in the context -- so the EXIT mechanism has nothing to
retire and no later probe whose accuracy could show what retiring it cost. The mechanism is
unmeasurable on that surface by construction, not by oversight.

This driver keeps run_cell intact and adds the missing surface beside it. run_cell produced a
96-cell matrix; rewriting it to serve a second protocol would put that record at risk for no
measurement gain.

## The phase boundaries are already in the corpus

Nothing new is generated. The 20 composition probes form four cross-project chains

    generation-N -> coding-N -> execution-N -> reasoning-N -> generation-N

and the logical ordering is project-contiguous, so cutting it into four segments puts
coding in phase 1, execution in 2, reasoning in 3, and generation plus all four errata in 4.
That makes 15 of the composition probes GENUINE cross-phase dependencies:

    coding-N -> execution-N      asked in phase 2, needs phase 1
    execution-N -> reasoning-N   asked in phase 3, needs phase 2
    reasoning-N -> generation-N  asked in phase 4, needs phase 3
    generation-N -> coding-N     asked in phase 4, needs phases 1 and 4

and the 4 update probes need the errata, which phase 4 carries. Those 19 probes are the
instrument: retire a phase and their accuracy is what pays for it.

## A probe is asked in the phase where its dependencies are ALL available

Not where its own project lives. A composition probe spans two projects; asking it in the
earlier one would test a link that has not been established yet, and the miss would read as
a comprehension failure rather than as the ordering error it is.
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

from ef_bridge_client import EpistemicFoldBridge  # noqa: E402
import run_cell as rc  # noqa: E402
import score_probes  # noqa: E402


def _count_kinds(probes: list[dict]) -> dict:
    """Probe kinds in one phase, so a phase that is all extraction and no composition is
    visibly unrepresentative rather than quietly different."""
    counts: dict[str, int] = {}
    for probe in probes:
        counts[probe["kind"]] = counts.get(probe["kind"], 0) + 1
    return counts


def project_of(doc_key: str) -> str:
    return doc_key.split("/", 1)[0]

def build_phases(seq: list[str], probes: list[dict], errata: list[dict],
                 n_phases: int) -> list[dict]:
    """Cut the ingest sequence into phases and place every probe.

    ## The cut is at PROJECT boundaries, not at equal document counts

    The first version split the sequence into n equal slices, and every slice cut through a
    project: phase 1 held all of coding plus ONE document of execution-1, and phase 4 opened
    with two errata from phase-1 projects. A project split across phases has no phase, so
    "retire phase 1" would have retired half of execution-1 as well.

    Projects are grouped by TYPE (coding / execution / reasoning / generation) and the types are
    distributed across the phases in order, so a project is never divided.

    ## Every errata is placed in the LAST phase, whatever project it corrects

    This is forced by the probe set, not chosen. Each corrected fact carries BOTH an extraction
    probe that expects the OLD value (id 9: "What is max_attempts for coding-2?" -> 2) and an
    update probe that expects the corrected one (id 181 -> 11). Asking them in one turn is what
    the single-phase protocol already does; asking the extraction one AFTER the errata arrived
    would make the expected answer wrong. So the errata are held back to the phase that also
    asks the update probes, which is what orderings.json does by putting them at 85%.
    """
    groups: list[tuple[str, list[str]]] = []
    group_index: dict[str, int] = {}
    errata_docs: list[str] = []
    for doc_key in seq:
        project = project_of(doc_key)
        if doc_key.endswith("/ERRATA.md"):
            errata_docs.append(doc_key)
            continue
        kind = project.rsplit("-", 1)[0]
        if kind not in group_index:
            group_index[kind] = len(groups)
            groups.append((kind, []))
        groups[group_index[kind]][1].append(doc_key)

    total = sum(len(d) for _, d in groups) or 1
    buckets: list[list[str]] = [[] for _ in range(n_phases)]
    running = 0
    for _kind, group_docs in groups:
        index = min(int(running / total * n_phases), n_phases - 1)
        buckets[index].extend(group_docs)
        running += len(group_docs)
    # The errata answer the update probes, so they arrive with the phase that asks them.
    buckets[-1].extend(errata_docs)

    content_phase: dict[str, int] = {}
    errata_phase: dict[str, int] = {}
    for index, bucket in enumerate(buckets):
        for doc_key in bucket:
            project = project_of(doc_key)
            if doc_key.endswith("/ERRATA.md"):
                errata_phase[project] = index
            else:
                content_phase.setdefault(project, index)

    phases = [{"index": i + 1, "docs": bucket, "probes": []} for i, bucket in enumerate(buckets)]
    unplaced: list[dict] = []
    for probe in probes:
        fact = probe["fact"]
        needed: set[int] = set()
        if "->" in fact:
            left, right = fact.split("->", 1)
            if left not in content_phase or right not in content_phase:
                unplaced.append(probe)
                continue
            needed = {content_phase[left], content_phase[right]}
        else:
            project = fact.split(".", 1)[0]
            if project not in content_phase:
                unplaced.append(probe)
                continue
            needed = {content_phase[project]}
            if probe["kind"] == "update" and project in errata_phase:
                needed.add(errata_phase[project])
        phases[max(needed)]["probes"].append(probe)

    if unplaced:
        raise SystemExit(
            "phased: " + str(len(unplaced)) + " probe(s) name a project that never arrives: "
            + ", ".join(sorted({p["fact"] for p in unplaced}))[:200]
        )
    return phases




def run_phased_cell(arm: str, order_name: str, n_phases: int, parts_per_phase: int,
                    fs_root: str | None) -> dict:
    docs = rc.load("documents.json")
    key = rc.load("answer_key.json")
    public = rc.load("public_probes.json")
    orders = rc.load("orderings.json")
    by_key = rc.corpus_with_errata(docs, key["errata"])
    seq = [k for k in orders[order_name] if k in by_key]
    phases = build_phases(seq, public["probes"], key["errata"], n_phases)

    bridge = EpistemicFoldBridge(arm=arm, bundle_root=str(HERE / "_bundles"),
                                 domain="memory", task_id=f"P-{arm}-{order_name}")
    bridge.init(rc.SYSTEM_PUSH, [], fs_root=fs_root)
    # The engine never chooses when to compress. Each driven fold re-enables it for one call.
    bridge.set_compaction(False)

    fold_events: list[dict] = []
    records: list[dict] = []
    answers: dict[int, str] = {}
    unparsed: list[int] = []
    probe_failures = 0
    committed_total = 0
    started = time.monotonic()

    for phase in phases:
        weights = [max(1, len(by_key[k]["text"]) // 4) for k in phase["docs"]]
        parts = rc.split_into_parts(phase["docs"], weights, parts_per_phase)
        appended = 0
        for part in parts:
            for doc_key in part:
                bridge.append({"role": "user", "content": by_key[doc_key]["text"]})
                appended += 1
            before = bridge.last_telemetry.get("promptTokensLast", 0)
            enabled = bridge.set_compaction(True)
            ok = bridge.compact()
            bridge.set_compaction(False)
            after = bridge.last_telemetry.get("promptTokensLast", 0)
            fold_events.append({
                "phase": phase["index"], "docs_appended": appended,
                "tokens_before": before, "tokens_after": after,
                "span_tokens": before - after, "committed": bool(ok),
                "set_compaction_returned": enabled,
            })
            if ok:
                committed_total += 1

        surface_before_probe = bridge.last_telemetry.get("promptTokensLast", 0)
        phase_answers: dict[int, str] = {}
        phase_unparsed: list[int] = []
        phase_failures = 0
        if phase["probes"]:
            ids = {p["id"] for p in phase["probes"]}
            batch_public = {"probes": [p for p in public["probes"] if p["id"] in ids]}
            turn = score_probes.render_probe_turn(batch_public)
            bridge.append({"role": "user", "content": turn})
            if fs_root is not None:
                reply, failures, _stats = rc.step_with_tools(bridge)
            else:
                reply, failures = rc.step_with_retry(bridge)
            phase_failures = failures
            text = reply.get("content") or ""
            got = score_probes.parse_answers(text, [p["id"] for p in phase["probes"]])
            phase_answers = got["answers"]
            phase_unparsed = got["unparsed"]
            answers.update(phase_answers)
            unparsed.extend(phase_unparsed)
            probe_failures += failures

        # Score JUST this phase, against the probes it was allowed to see. This is the number
        # an exit mechanism has to be judged on: did retiring the previous phase cost THIS one
        # anything?
        phase_ids = {p["id"] for p in phase["probes"]}
        phase_key = {"probes": [p for p in key["probes"] if p["id"] in phase_ids]}
        phase_score = score_probes.score(phase_key, {"answers": phase_answers})
        records.append({
            "phase": phase["index"],
            "projects": sorted({project_of(k) for k in phase["docs"]}),
            "docs": len(phase["docs"]),
            "folds_committed": sum(1 for e in fold_events
                                   if e["phase"] == phase["index"] and e["committed"]),
            "surface_before_probe": surface_before_probe,
            "probes": len(phase["probes"]),
            "by_kind": dict(sorted(_count_kinds(phase["probes"]).items())),
            "accuracy": phase_score["overall"]["accuracy"],
            "scored": phase_score["overall"]["scored"],
            "unparsed": phase_score["overall"]["unparsed"],
            "provider_failures": phase_failures,
        })

    parsed_all = {"answers": answers}
    result = score_probes.score(key, parsed_all)
    window = int(os.environ.get("EF_MEMORY_WINDOW", "131072"))
    return {
        "cell": {"arm": arm, "order": order_name, "mode": "P",
                 "phases": n_phases, "parts_per_phase": parts_per_phase},
        "protocol": "multi-phase",
        "window": window,
        "phase_count": n_phases,
        "parts_per_phase": parts_per_phase,
        "folds_committed": committed_total,
        "folds_expected": n_phases * parts_per_phase,
        "fold_events": fold_events,
        "phases": records,
        "probe_seconds": round(time.monotonic() - started, 1),
        "probe_provider_failures": probe_failures,
        "empty_truncated_retries": rc.empty_truncated,
        "empty_silent_retries": rc.empty_silent,
        "parsed": {"unparsed": len(unparsed)},
        "score": {k: v for k, v in result.items() if k != "rows"},
        "rows": result["rows"],
        "telemetry": bridge.last_telemetry,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--arm", required=True, choices=sorted(rc.ARM_SPECS))
    ap.add_argument("--order", default="logical", choices=["random", "temporal", "logical"])
    ap.add_argument("--phases", type=int, default=4)
    ap.add_argument("--parts-per-phase", type=int, default=2)
    ap.add_argument("--fs-root", default=None)
    # ## There is no --phase-exit yet, and the flag says so instead of accepting a value
    #
    # Retiring a phase needs checkpoint-level lifecycle, which does not exist: anchors have
    # active/superseded/retired, and a checkpoint written onto the surface has none. A flag that
    # accepted "retire" and quietly did nothing would produce a baseline labelled as a treatment.
    ap.add_argument("--phase-exit", default="none", choices=["none"])
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = run_phased_cell(args.arm, args.order, args.phases, args.parts_per_phase, args.fs_root)
    path = Path(args.out) if args.out else (HERE / f"phased_{args.arm}_{args.order}.json")
    path.write_text(json.dumps(out, indent=2), encoding="utf-8", newline="\n")

    print(f"phased {args.arm}/{args.order}: {args.phases} phases, "
          f"folds {out['folds_committed']}/{out['folds_expected']}, "
          f"accuracy {out['score']['overall']['accuracy']}")
    for r in out["phases"]:
        print(f"  phase {r['phase']}: docs {r['docs']:2d}  surface {r['surface_before_probe']:>8}  "
              f"probes {r['probes']:3d}  acc {r['accuracy']}  unparsed {r['unparsed']}")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())