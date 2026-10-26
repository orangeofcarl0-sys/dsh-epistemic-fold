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
import re
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


# ## Deterministic fact extraction -- the BENCH's, not EF's
#
# The corpus states each fact in a fixed shape ("The retry helper uses max_attempts = 8."), and
# the errata corrects one in a second fixed shape. Two regexes read both. Nothing here is a
# model call, deliberately: an LLM deciding what the state says is an LLM deciding what the
# next fold treats as authoritative, which is the hazard `rationale.ts` exists to keep out of
# the semantic path.
#
# This is a property of THIS CORPUS, and any result that depends on it is a result about
# structured extraction, not about EF.
# ## Two statement forms, and neither may match the pooled filler
#
# The corpus states a fact one of two ways:
#
#     max_attempts = 8.                    assignment form
#     The on-call retry_budget is 6.       prose form
#
# Measured 2026-10-27: matching only the assignment form recovered 62 of the 100
# coordinates the answer key asks about, because 38 are stated in prose. And the pooled
# filler source contains real code (`(options, args) = parser.parse_args()`,
# `(typ, [data]) = <instance>.check()`), so an unanchored `=` match invents facts from
# sample code -- which is the worst kind of failure here, because it manufactures authority.
#
# So the assignment form is anchored to a line with no brackets or commas, and the prose form
# requires the line to open with `The`.
_FACT = re.compile(r"^[^=()\[\],]*\b([a-z][a-z0-9_]*)\s*=\s*([^()\[\],]+?)\.\s*$")
_PROSE = re.compile(r"^The\b[^.]*?\b([a-z][a-z0-9_]*)\s+is\s+([^()\[\],]+?)\.\s*$")
_ERRATA_FIELD = re.compile(r"\b([a-z][a-z0-9_]*) was previously published as\b")
# The errata sentence is `The corrected value is 11. The earlier figure is superseded ...`, so
# stopping at the first period is required -- and a bare `+?` would stop inside `0.29`. The
# value is either a decimal or a token, then one period.
_ERRATA_VALUE = re.compile(r"corrected value is\s*(\d+\.\d+|[A-Za-z0-9_-]+)\.")
_HEADER = re.compile(r"^#\s*([A-Za-z0-9_-]+)\s*")


def extract_facts(text: str, doc_key: str) -> list[tuple[str, str, str]]:
    """(entity, property, value) triples stated by one document.

    The project comes from the document's header line rather than from its path, so a
    reordering cannot silently attribute facts to the wrong project.
    """
    project = project_of(doc_key)
    # The header names the project for a document, but an errata's header reads
    # `# ERRATA -- coding-2`, so the header would capture `ERRATA` and attribute the
    # correction to a project that does not exist. Measured offline before any run.
    if not doc_key.endswith("/ERRATA.md"):
        header = _HEADER.match(text.split("\n", 1)[0])
        if header is not None:
            project = header.group(1)
    facts: list[tuple[str, str, str]] = []
    if doc_key.endswith("/ERRATA.md"):
        field_match = _ERRATA_FIELD.search(text)
        value_match = _ERRATA_VALUE.search(text)
        if field_match is not None and value_match is not None:
            facts.append((project, field_match.group(1), value_match.group(1)))
        return facts
    for line in text.split("\n"):
        stripped = line.strip()
        match = _FACT.match(stripped) or _PROSE.match(stripped)
        if match is not None:
            facts.append((project, match.group(1), match.group(2).strip()))
    return facts


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




def _residency(bridge) -> dict:
    """The bridge's checkpoint residency report, as a plain dict."""
    return (bridge._send({"op": "checkpoints"}) or {}).get("report") or {}


def _checkpoint_ids(bridge) -> list[str]:
    """Ids of the checkpoints currently on the surface."""
    report = _residency(bridge)
    return [site["checkpointId"] for site in (report.get("sites") or []) if site.get("onSurface")]


def run_phased_cell(arm: str, order_name: str, n_phases: int, parts_per_phase: int,
                    fs_root: str | None, phase_exit: str = "none",
                    anchors: bool = False) -> dict:
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
    # ## What EXIT would retire, decided by the DRIVER
    #
    # Same split as the fold cadence: the engine implements the operation, the driver chooses
    # the occasion. The driver knows which phase it just probed; the engine cannot know that,
    # and a retirement inferred by the engine would make the treatment depend on the corpus and
    # the provider, so no two cells could be compared.
    #
    # The ids are diffed against the set observed BEFORE the phase's ingest, so what is retired is
    # exactly the checkpoints this phase created -- including the content they carry forward from
    # earlier phases, which is where the cost of retiring shows up.
    seen_ids: set[str] = set()
    if phase_exit == "retire":
        seen_ids = set(_checkpoint_ids(bridge))
    answers: dict[int, str] = {}
    unparsed: list[int] = []
    probe_failures = 0
    committed_total = 0
    anchors_declared = 0
    started = time.monotonic()

    for phase in phases:
        weights = [max(1, len(by_key[k]["text"]) // 4) for k in phase["docs"]]
        parts = rc.split_into_parts(phase["docs"], weights, parts_per_phase)
        appended = 0
        for part in parts:
            for doc_key in part:
                reply = bridge.append({"role": "user", "content": by_key[doc_key]["text"]})
                appended += 1
                if anchors:
                    # Each fact is declared against the seq of the message that stated it, so
                    # provenance is the document itself and the authority gate has something to
                    # check. A re-statement of the same coordinate SUPERSEDES rather than adding:
                    # that is the reducer's rule, and it is what bounds the state by coordinate.
                    source_seq = (reply.get("seqs") or [None])[0]
                    if source_seq is not None:
                        for entity, prop, value in extract_facts(by_key[doc_key]["text"], doc_key):
                            bridge._send({"op": "anchor", "entity": entity,
                                          "property": prop, "value": value,
                                          "sourceSeq": source_seq})
                            anchors_declared += 1
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

        # ## Retire AFTER the probe, never before it
        #
        # The phase is measured first and retired second, so the treatment cannot change the
        # state that was just measured. Retiring before the probe would fold the exit into the
        # measurement and there would be nothing left to compare against.
        exit_record: dict = {}
        reply_retire: dict = {}
        if phase_exit == "retire":
            current = _checkpoint_ids(bridge)
            fresh = [cid for cid in current if cid not in seen_ids]
            if fresh:
                reply_retire = bridge._send({"op": "retire", "ids": fresh,
                                             "reason": f"phase {phase['index']} complete",
                                             "remove": True})
                outcomes = reply_retire.get("outcomes") or []
                exit_record = {
                    "retire_requested": len(fresh),
                    "retire_written": reply_retire.get("written"),
                    # How many were actually REMOVED from the surface. A written-but-not-removed
                    # retirement is what `conflicts` catches; recording the two separately means the
                    # artifact distinguishes "the engine refused" from "the removal failed".
                    "retire_removed": reply_retire.get("removed"),
                    "retire_refused": {o.get("refusal"): 0 for o in outcomes if o.get("refusal")},
                    "retired_ids": fresh,
                }
                # Refusals counted per reason, because `no-such-checkpoint` (wrong id) and
                # `already-retired` (asked twice) mean different mistakes and only one of them
                # is a driver bug.
                for outcome in outcomes:
                    reason = outcome.get("refusal")
                    if reason:
                        exit_record["retire_refused"][reason] += 1
                seen_ids = set(current)
            else:
                exit_record = {"retire_requested": 0, "retire_written": 0,
                               "retire_refused": {}, "retired_ids": []}
            residency = (reply_retire.get("report") if fresh else None) or _residency(bridge)
            exit_record["residency_after"] = {
                "resident": residency.get("resident"),
                "archived": residency.get("archived"),
                "retired": residency.get("retired"),
                # Must reach zero once removal exists. Until then it counts retirements that were
                # recorded and not honoured -- the state in which a measurement would compare a
                # baseline against a baseline while the artifact called it a treatment.
                "conflicts": residency.get("conflicts"),
            }
        else:
            seen_ids = set()

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
            "anchors_declared": anchors_declared,
            "coordinates": (bridge._send({"op": "state"}) or {}).get("coordinates"),
            **exit_record,
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
    ap.add_argument("--phase-exit", default="none", choices=["none", "retire"])
    # Declare the corpus's stated facts as `ef/anchor` coordinates, so the checkpoint has a
    # bounded representation to render instead of only model prose. See extract_facts.
    ap.add_argument("--anchors", default="off", choices=["off", "on"])
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = run_phased_cell(args.arm, args.order, args.phases, args.parts_per_phase, args.fs_root,
                          args.phase_exit, args.anchors == "on")
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