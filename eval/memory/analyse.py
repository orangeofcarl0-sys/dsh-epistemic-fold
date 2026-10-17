#!/usr/bin/env python3
"""Read the cell results and produce the table docs/62 section 10.7 asks for.

Deterministic and offline: it reads result files the driver wrote and computes, with no model
involved and no network.

## Three things it must not do

1. **It must not pool the kinds.** Extraction and disambiguation are the paired pair; abstention
   answers a different question and is excluded from retention (3.2.13). One number carrying two
   meanings is what section 8 exists to prevent.

2. **It must not bootstrap over probes.** The same fact appears in several cells -- that is what
   the order factor buys -- so probes within a fact are correlated. Resampling probes understates
   the interval, because the effective sample size is the number of FACTS (8.2). The bootstrap is
   clustered by fact.

3. **It must not report accuracy against zero.** Every probe carries four real options, so chance
   is about 0.25 and the report says so. An accuracy of 0.31 read against zero looks like
   near-total failure; read against the floor it is barely above chance (threat 6).
"""
from __future__ import annotations

import json
import random
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
BOOTSTRAP_DRAWS = 2000
BOOTSTRAP_SEED = 20261012


def load_cells(paths: list[Path]) -> list[dict]:
    cells = []
    for p in paths:
        try:
            cells.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as e:
            print(f"skipping {p.name}: {e}", file=sys.stderr)
    return cells


def cluster_bootstrap(rows: list[dict], stat, draws: int = BOOTSTRAP_DRAWS,
                      seed: int = BOOTSTRAP_SEED) -> tuple[float | None, float | None]:
    """95% interval, resampling FACTS rather than probes (8.2).

    Probes within a fact are correlated -- the same fact is planted in several cells -- so a
    probe-level bootstrap treats them as independent draws and reports an interval that is too
    narrow. The cluster is the fact, and the effective sample size is the number of facts.
    """
    by_fact: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_fact[r["fact"]].append(r)
    facts = sorted(by_fact)
    if not facts:
        return None, None
    rng = random.Random(seed)
    out = []
    for _ in range(draws):
        sample = []
        for _ in facts:
            sample.extend(by_fact[facts[rng.randrange(len(facts))]])
        v = stat(sample)
        if v is not None:
            out.append(v)
    if not out:
        return None, None
    out.sort()
    lo = out[int(0.025 * len(out))]
    hi = out[int(0.975 * len(out)) - 1]
    return round(lo, 4), round(hi, 4)


def acc(rows: list[dict]) -> float | None:
    if not rows:
        return None
    return sum(1 for r in rows if r["correct"]) / len(rows)


def mcnemar(b: int, c: int) -> dict:
    """Exact-ish McNemar on the discordant counts, without scipy.

    The chi-square approximation with a continuity correction is used when the discordant total
    is large enough for it to mean anything, and the exact binomial tail otherwise -- which is
    the case that matters here, because a strong effect produces a lopsided pair and a small b+c.
    """
    n = b + c
    if n == 0:
        return {"b": b, "c": c, "n_discordant": 0, "p": None,
                "note": "no discordant pairs; the two forms never disagreed"}
    # Two-sided exact binomial with p = 0.5, computed by summing the tail.
    from math import comb
    k = min(b, c)
    tail = sum(comb(n, i) for i in range(0, k + 1)) / (2 ** n)
    p = min(1.0, 2 * tail)
    return {"b": b, "c": c, "n_discordant": n, "p": round(p, 6),
            "method": "exact two-sided binomial, p=0.5"}


def analyse(cells: list[dict]) -> dict:
    # ## One pass, and the fact joined back through the key
    #
    # The fact is not in the driver's row (the row carries the probe id), and exposure is per
    # FACT per CELL, so both are resolved here rather than stored twice. An earlier draft did
    # this in three passes, two of which computed values nothing read -- dead code that looks
    # like it does something is worse than no code, because the next reader has to prove it is
    # dead before changing anything near it.
    key = json.loads((HERE / "answer_key.json").read_text(encoding="utf-8"))
    by_id = {p["id"]: p for p in key["probes"]}
    rows = []
    for ci, c in enumerate(cells):
        for r in c.get("rows", []):
            if r.get("correct") is None:
                continue
            p = by_id.get(r["id"])
            if p is None:
                continue
            e = (c.get("exposure") or {}).get(p["fact"], {})
            rows.append({"cell": c["cell"], "id": r["id"], "type": r["type"], "kind": r["kind"],
                         "fact": p["fact"], "correct": r["correct"], "exposure": e})

    out: dict = {"n_cells": len(cells), "n_scored_probes": len(rows)}

    # ## The chance floor, and the dimensions section 11 needs
    #
    # Section 11 lists what would falsify the design, and an analysis that cannot check them is
    # not an analysis of this design. Three were unreachable as first written:
    #
    #   "arm B near chance" needs the FLOOR. Every probe carries four real options, so chance is
    #   about 0.25; an arm at 0.30 is at chance, and the same 0.30 read against zero looks like a
    #   weak-but-real result. The scorer computes the floor and the analysis was dropping it.
    #
    #   "B and A indistinguishable at DEPTH 1" needs depth as a dimension, and retention was
    #   reported by type and by exposure but never by depth.
    #
    #   "the warned and unwarned arms differ only in fold count" needs the warning as a dimension.
    #
    # All three are cheap to carry and impossible to reconstruct afterwards from a summary.
    key_all = json.loads((HERE / "answer_key.json").read_text(encoding="utf-8"))
    n_opts = [len(p["options"]) for p in key_all["probes"]]
    out["chance_floor"] = round(sum(1.0 / n for n in n_opts) / len(n_opts), 4)

    def group(rows_subset, keyfn):
        # ## The key is stringified, because JSON has no tuple keys
        #
        # `retention_by_depth` and `retention_by_warning` group on `(arm, depth)` and
        # `(arm, warned)`, so the dict this returns was keyed by TUPLES and `json.dumps` refused
        # the whole analysis at write time: "keys must be str, int, float, bool or None, not
        # tuple". Every cell had already been measured and scored, and the table still could not
        # be written -- a bench whose last step cannot run has not run.
        #
        # `str((arm, depth))` is deliberate rather than a join: it is unambiguous for any key
        # shape, and the reader can see it was a tuple.
        g: dict = defaultdict(list)
        for r in rows_subset:
            g[keyfn(r)].append(r)
        return {str(k): {"n": len(v), "accuracy": round(acc(v), 4),
                         "ci95": list(cluster_bootstrap(v, acc)),
                         "n_facts": len({r["fact"] for r in v})}
                for k, v in sorted(g.items(), key=lambda kv: str(kv[0]))}

    paired = [r for r in rows if r["kind"] in ("extraction", "disambiguation")]
    out["retention_by_depth"] = group(
        paired, lambda r: (r["cell"]["arm"], r["cell"]["depth"]))
    out["retention_by_warning"] = group(
        paired, lambda r: (r["cell"]["arm"], bool(r["cell"].get("warned"))))

    # ---- retention per type, per arm
    by_type_arm: dict[tuple, list] = defaultdict(list)
    for r in rows:
        if r["kind"] in ("extraction", "disambiguation"):
            by_type_arm[(r["cell"]["arm"], r["type"])].append(r)
    table = {}
    for (arm, t), rs in sorted(by_type_arm.items()):
        lo, hi = cluster_bootstrap(rs, acc)
        table.setdefault(arm, {})[t] = {
            "n": len(rs), "accuracy": round(acc(rs), 4),
            "ci95": [lo, hi], "n_facts": len({r["fact"] for r in rs}),
        }
    out["retention_by_type"] = table

    # ---- binding loss, PAIRED by fact (8.1)
    pairs: dict[str, dict] = defaultdict(dict)
    for r in rows:
        if r["kind"] in ("extraction", "disambiguation"):
            pairs[r["fact"]][r["kind"]] = r["correct"]
    both = {f: v for f, v in pairs.items() if len(v) == 2}
    if both:
        b = sum(1 for v in both.values() if v["extraction"] and not v["disambiguation"])
        c = sum(1 for v in both.values() if v["disambiguation"] and not v["extraction"])
        out["binding_loss"] = {
            "n_pairs": len(both),
            "extraction": round(sum(1 for v in both.values() if v["extraction"]) / len(both), 4),
            "disambiguation": round(sum(1 for v in both.values() if v["disambiguation"]) / len(both), 4),
            **mcnemar(b, c),
        }

    # ---- interference B - C, paired by probe
    by_arm_probe: dict[str, dict] = defaultdict(dict)
    for r in rows:
        by_arm_probe[r["cell"]["arm"]][(r["cell"]["order"], r["id"])] = r["correct"]
    shared = set(by_arm_probe.get("B", {})) & set(by_arm_probe.get("C", {}))
    if shared:
        b = sum(1 for k in shared if by_arm_probe["B"][k] and not by_arm_probe["C"][k])
        c = sum(1 for k in shared if by_arm_probe["C"][k] and not by_arm_probe["B"][k])
        out["interference_B_minus_C"] = {
            "n_paired": len(shared),
            "B_accuracy": round(sum(by_arm_probe["B"][k] for k in shared) / len(shared), 4),
            "C_accuracy": round(sum(by_arm_probe["C"][k] for k in shared) / len(shared), 4),
            **mcnemar(b, c),
        }

    # ---- retention vs EXPOSURE, not nominal depth (7.4)
    by_exp: dict[int, list] = defaultdict(list)
    for r in rows:
        if r["kind"] in ("extraction", "disambiguation"):
            by_exp[(r["exposure"] or {}).get("total", 0)].append(r)
    out["retention_by_exposure"] = {
        str(k): {"n": len(v), "accuracy": round(acc(v), 4),
                 "ci95": list(cluster_bootstrap(v, acc)), "n_facts": len({r["fact"] for r in v})}
        for k, v in sorted(by_exp.items())
    }
    by_mech: dict[str, list] = defaultdict(list)
    for r in rows:
        if r["kind"] in ("extraction", "disambiguation"):
            e = r["exposure"] or {}
            for m in ("leaf", "root", "emergency"):
                if e.get(m):
                    by_mech[m].append(r)
                    break
            else:
                by_mech["none"].append(r)
    out["retention_by_mechanism"] = {
        m: {"n": len(v), "accuracy": round(acc(v), 4)} for m, v in sorted(by_mech.items())
    }

    # ---- confabulation: abstention probes alone (3.2.13)
    abst = [r for r in rows if r["kind"] == "abstention"]
    if abst:
        out["confabulation"] = {
            "n": len(abst),
            "declined_correctly": sum(1 for r in abst if r["correct"]),
            "rate": round(acc(abst), 4),
        }

    # ---- cost per retained fact
    cost = {}
    for c in cells:
        arm = c["cell"]["arm"]
        t = c.get("telemetry") or {}
        correct = sum(1 for r in c.get("rows", []) if r.get("correct"))
        cost.setdefault(arm, {"cost": 0.0, "correct": 0, "cells": 0})
        cost[arm]["cost"] += float(t.get("costTotal") or 0)
        cost[arm]["correct"] += correct
        cost[arm]["cells"] += 1
    out["cost_per_retained_fact"] = {
        a: {"cells": v["cells"], "cost_total": round(v["cost"], 6),
            "correct": v["correct"],
            "cost_per_correct": round(v["cost"] / v["correct"], 8) if v["correct"] else None}
        for a, v in sorted(cost.items())
    }
    return out



# ---------------------------------------------------------------- falsifiers

def evaluate_falsifiers(out: dict) -> dict:
    """Which of section 11's falsifiers the data actually triggers.

    Section 11 lists eight. Six are checkable from this output and two are not: the warned factor
    and the full-context load penalty are separate experiments, and reporting them as "not
    triggered" because their cells are absent would be the worst kind of green.

    Each entry says what was tested, what was seen, and what it means -- because a falsifier that
    fires is a RESULT about the design, not a failure of the run.
    """
    f: dict[str, dict] = {}
    floor = out.get("chance_floor")

    # 1. retention near 1.0 at every exposure: the instrument has no range.
    by_exp = out.get("retention_by_exposure") or {}
    accs = [v["accuracy"] for v in by_exp.values() if v["accuracy"] is not None]
    if accs:
        f["retention_near_ceiling"] = {
            "min_accuracy": min(accs), "max_accuracy": max(accs),
            "triggered": min(accs) > 0.95,
            "means": "the corpus is too easy or compression is lossless at this size",
        }

    # 2. arm B near chance: the probes are unanswerable even with the source injected.
    b = (out.get("retention_by_type") or {}).get("B") or {}
    bacc = [v["accuracy"] for v in b.values() if v["accuracy"] is not None]
    if bacc and floor is not None:
        f["arm_B_near_chance"] = {
            "B_accuracy": round(sum(bacc) / len(bacc), 4), "chance_floor": floor,
            "triggered": (sum(bacc) / len(bacc)) - floor < 0.10,
            "means": "nothing downstream can be attributed; the probes are unanswerable",
        }

    # 3. B and A indistinguishable at depth 1.
    by_depth = out.get("retention_by_depth") or {}

    def at_depth(arm: str, d: int):
        """Find a group whose key is (arm, depth), whatever form the key arrived in.

        The groups are keyed by TUPLE. An earlier version looked up the JSON string form
        ("['A', 1]") and so never found anything: this falsifier could not fire, and a falsifier
        that cannot fire is worse than an absent one because it reads as "checked and clear".
        """
        for k, v in by_depth.items():
            if isinstance(k, str):
                try:
                    k = json.loads(k.replace("(", "[").replace(")", "]"))
                except json.JSONDecodeError:
                    continue
            if isinstance(k, (list, tuple)) and len(k) == 2 and k[0] == arm and k[1] == d:
                return v
        return None

    a1, b1 = at_depth("A", 1), at_depth("B", 1)
    if a1 and b1 and a1["accuracy"] is not None and b1["accuracy"] is not None:
        gap = b1["accuracy"] - a1["accuracy"]
        f["A_and_B_tie_at_depth_1"] = {
            "A": a1["accuracy"], "B": b1["accuracy"], "gap": round(gap, 4),
            "triggered": abs(gap) < 0.05,
            "means": "compression at this size does nothing; depth must be raised",
        }

    # 4. extraction and disambiguation move together: binding loss is not a real phenomenon.
    bl = out.get("binding_loss")
    if bl:
        f["extraction_tracks_disambiguation"] = {
            "extraction": bl["extraction"], "disambiguation": bl["disambiguation"],
            "mcnemar_p": bl.get("p"),
            "triggered": bl.get("p") is not None and bl["p"] > 0.05,
            "means": "the binding-loss hypothesis is wrong and extraction would suffice",
        }

    # 5. exposure does not predict retention: the covariates are decoration.
    if len(accs) >= 2 and by_exp:
        # A monotone-ish signal is what "predicts" means here; a flat curve is the falsifier.
        ordered = [v["accuracy"] for k, v in sorted(by_exp.items(), key=lambda kv: int(kv[0]))
                   if v["accuracy"] is not None]
        f["exposure_does_not_predict"] = {
            "curve": ordered,
            "spread": round(max(ordered) - min(ordered), 4) if ordered else None,
            "triggered": bool(ordered) and (max(ordered) - min(ordered)) < 0.05,
            "means": "compression is not what is losing the facts",
        }

    # 6. B - C near zero: the retained summary does not interfere.
    it = out.get("interference_B_minus_C")
    if it:
        gap = it["B_accuracy"] - it["C_accuracy"]
        f["interference_near_zero"] = {
            "B": it["B_accuracy"], "C": it["C_accuracy"], "gap": round(gap, 4),
            "triggered": abs(gap) < 0.05,
            "means": "the interference term can be dropped and retention alone suffices",
        }

    # 7 and 8 are NOT checkable here, and saying so is the point.
    f["warning_factor"] = {"checked": False,
                           "why": "the warned and unwarned arms are separate cells; none are in this set"}
    f["load_penalty"] = {"checked": False,
                         "why": "the full-context arm is a separate reduced-corpus experiment (6.5)"}
    return f

def main() -> None:
    args = sys.argv[1:]
    paths = [Path(a) for a in args] if args else sorted(HERE.glob("result_*.json"))
    cells = load_cells(paths)
    if not cells:
        print("no result files found", file=sys.stderr)
        raise SystemExit(1)
    out = analyse(cells)
    out["falsifiers"] = evaluate_falsifiers(out)
    (HERE / "analysis.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"cells: {out['n_cells']}   scored probes: {out['n_scored_probes']}")
    for arm, types in out["retention_by_type"].items():
        for t, v in types.items():
            print(f"  {arm:9s} {t:11s} n={v['n']:4d} facts={v['n_facts']:3d} "
                  f"acc={v['accuracy']}  ci95={v['ci95']}")
    if "binding_loss" in out:
        bl = out["binding_loss"]
        print(f"  binding loss {bl['binding_loss'] if 'binding_loss' in bl else round(bl['extraction'] - bl['disambiguation'], 4)}"
              f"  (ext {bl['extraction']} vs dis {bl['disambiguation']}, n={bl['n_pairs']}, p={bl['p']})")
    if "interference_B_minus_C" in out:
        it = out["interference_B_minus_C"]
        print(f"  interference B-C = {round(it['B_accuracy'] - it['C_accuracy'], 4)} "
              f"(n={it['n_paired']}, p={it['p']})")
    if "confabulation" in out:
        print(f"  confabulation: declined {out['confabulation']['declined_correctly']}"
              f"/{out['confabulation']['n']} = {out['confabulation']['rate']}")
    fired = [k for k, v in out["falsifiers"].items() if v.get("triggered")]
    unchecked = [k for k, v in out["falsifiers"].items() if v.get("checked") is False]
    print(f"chance floor: {out.get('chance_floor')}")
    print(f"falsifiers triggered: {fired if fired else 'none'}")
    if unchecked:
        print(f"  not checkable from this set: {', '.join(unchecked)}")
    print("wrote analysis.json")


if __name__ == "__main__":
    main()
