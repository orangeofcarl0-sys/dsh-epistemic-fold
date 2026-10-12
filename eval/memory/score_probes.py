#!/usr/bin/env python3
"""Render the probe turn, parse the replies, and score them deterministically.

Implements docs/62_MEMORY_PRESSURE_TASK_DESIGN.md sections 5.5 and 8. No LLM is involved: every
answer is a letter, and a letter either matches the key or does not.

## Three properties that are easy to get wrong

1. **A parse failure is recorded as a parse failure.** A reply the parser cannot read is not the
   same fact as a reply that was read and was wrong, and scoring the first as the second inflates
   the apparent loss. Section 5.5 says so explicitly.

2. **Accuracy is reported against the CHANCE FLOOR, not against zero.** Every probe has four real
   options, so a model answering at random scores about 0.25. A result reported as "0.31" without
   that floor reads as near-total failure when it is barely above chance (threat 6).

3. **Per-kind results are not pooled.** Extraction and disambiguation are the paired pair;
   abstention answers a different question entirely and is excluded from the retention ratio
   (3.2.13). One number carrying two meanings is what this file exists to avoid.
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
LETTERS = "ABCD"


def render_probe_turn(public: dict) -> str:
    """The whole probe set as ONE turn (section 5.3).

    Batching across turns would let a fold fall between probes and change the exposure of the
    later ones, which is the decoupling section 7 exists to establish.
    """
    lines = [
        "Answer each question with ONE letter. Reply with exactly one line per question, "
        'in the form "N: X".',
        "",
    ]
    for p in public["probes"]:
        lines.append(f"{p['id']}. {p['q']}")
        lines.append("   " + "   ".join(
            f"{LETTERS[i]}) {o}" for i, o in enumerate(p["options"])
        ))
    return "\n".join(lines)


# Pass 1: the format the turn asks for.
_STRICT = re.compile(r"^\s*(\d+)\s*[:.)]\s*([A-Da-d])\b")
# Pass 2: a looser shape, for a model that answers in prose. It still requires a NUMBER and a
# STANDALONE letter, in that order and close together, which is what keeps it from inventing an
# answer.
#
# The obvious fallback -- "take the first letter of the line" -- is WRONG and was the first thing
# written here: it reads "Answer 1 is C" as A, from the word "Answer", and would have recorded a
# confident wrong answer for every line of a prose reply. A fallback that can produce a WRONG
# answer is worse than no fallback, because it is indistinguishable from a real one.
_LOOSE = re.compile(r"\b(\d{1,3})\D{1,24}?\b([A-Da-d])\b")


def parse_answers(text: str, expected_ids: list[int]) -> dict:
    """Letters by probe id, plus the ids that could not be read, plus which pass read them.

    What the parser must NOT do is guess: an id with no readable answer is reported as unparsed
    rather than filled in, because "unreadable" and "wrong" are different facts about a run and
    scoring the first as the second inflates the apparent loss.
    """
    known = set(expected_ids)
    found: dict[int, str] = {}
    strict, loose = 0, 0
    for line in text.splitlines():
        m = _STRICT.match(line)
        if m and int(m.group(1)) in known:
            found[int(m.group(1))] = m.group(2).upper()
            strict += 1
            continue
        m = _LOOSE.search(line)
        if m and int(m.group(1)) in known and int(m.group(1)) not in found:
            found[int(m.group(1))] = m.group(2).upper()
            loose += 1
    unparsed = [i for i in expected_ids if i not in found]
    return {"answers": found, "unparsed": unparsed,
            "parsed_strict": strict, "parsed_loose": loose}


def score(key: dict, parsed: dict) -> dict:
    """Per-probe outcomes and the aggregates, with the floor stated."""
    by_id = {p["id"]: p for p in key["probes"]}
    rows = []
    for pid, p in by_id.items():
        letter = parsed["answers"].get(pid)
        if letter is None:
            rows.append({"id": pid, "type": p["type"], "kind": p["kind"],
                         "outcome": "unparsed", "correct": None})
            continue
        idx = LETTERS.index(letter)
        correct = idx == p["answer_index"]
        rows.append({"id": pid, "type": p["type"], "kind": p["kind"],
                     "outcome": "correct" if correct else "wrong", "correct": correct,
                     "chose": p["options"][idx] if idx < len(p["options"]) else None})

    def rate(rs: list[dict]) -> dict:
        scored = [r for r in rs if r["correct"] is not None]
        right = sum(1 for r in scored if r["correct"])
        return {
            "n": len(rs), "scored": len(scored), "unparsed": len(rs) - len(scored),
            "correct": right,
            "accuracy": round(right / len(scored), 4) if scored else None,
        }

    by_kind = defaultdict(list)
    by_type = defaultdict(list)
    for r in rows:
        by_kind[r["kind"]].append(r)
        by_type[r["type"]].append(r)

    # The floor is 1/len(options), averaged, because option counts can differ.
    floors = [1.0 / len(by_id[r["id"]]["options"]) for r in rows]
    floor = round(sum(floors) / len(floors), 4) if floors else None

    overall = rate(rows)
    return {
        "overall": {**overall, "chance_floor": floor},
        "by_kind": {k: rate(v) for k, v in sorted(by_kind.items())},
        "by_type": {k: rate(v) for k, v in sorted(by_type.items())},
        # Binding loss is only meaningful as a PAIR, so it is computed from the two kinds that
        # share a fact rather than from two independent samples (8.1).
        "binding_loss": _binding_loss(rows, by_id),
        "rows": rows,
    }


def _binding_loss(rows: list[dict], by_id: dict) -> dict:
    """extraction accuracy minus disambiguation accuracy, PAIRED by fact."""
    pairs: dict[str, dict] = defaultdict(dict)
    for r in rows:
        if r["kind"] in ("extraction", "disambiguation") and r["correct"] is not None:
            pairs[by_id[r["id"]]["fact"]][r["kind"]] = r["correct"]
    both = {f: v for f, v in pairs.items() if len(v) == 2}
    if not both:
        return {"n_pairs": 0, "note": "no fact has both forms scored"}
    ext = sum(1 for v in both.values() if v["extraction"]) / len(both)
    dis = sum(1 for v in both.values() if v["disambiguation"]) / len(both)
    # McNemar's discordant counts: the paired test needs these, not the two rates alone.
    b = sum(1 for v in both.values() if v["extraction"] and not v["disambiguation"])
    c = sum(1 for v in both.values() if v["disambiguation"] and not v["extraction"])
    return {
        "n_pairs": len(both),
        "extraction_accuracy": round(ext, 4),
        "disambiguation_accuracy": round(dis, 4),
        "binding_loss": round(ext - dis, 4),
        "mcnemar_b": b, "mcnemar_c": c,
        "note": "paired by fact; b and c are the discordant counts McNemar needs",
    }


def main() -> None:
    key = json.loads((HERE / "answer_key.json").read_text(encoding="utf-8"))
    public = json.loads((HERE / "public_probes.json").read_text(encoding="utf-8"))
    reply = sys.stdin.read() if not sys.stdin.isatty() else ""
    ids = [p["id"] for p in key["probes"]]
    parsed = parse_answers(reply, ids)
    result = score(key, parsed)
    (HERE / "last_score.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    o = result["overall"]
    print(f"overall: {o['correct']}/{o['scored']} = {o['accuracy']}  "
          f"(chance floor {o['chance_floor']}, unparsed {o['unparsed']})")
    for k, v in result["by_kind"].items():
        print(f"  {k:14s} {v['correct']:3d}/{v['scored']:3d} = {v['accuracy']}")
    bl = result["binding_loss"]
    if bl.get("n_pairs"):
        print(f"  binding loss   {bl['binding_loss']}  "
              f"(extraction {bl['extraction_accuracy']} vs disambiguation "
              f"{bl['disambiguation_accuracy']}, n={bl['n_pairs']} pairs)")
    print(f"parsed: {parsed['parsed_strict']} strict, {parsed['parsed_loose']} loose, "
          f"{len(parsed['unparsed'])} unparsed")
    print("wrote last_score.json")


if __name__ == "__main__":
    main()
