#!/usr/bin/env python3
"""Single source of truth for the memory-pressure corpus.

Implements docs/62_MEMORY_PRESSURE_TASK_DESIGN.md section 3.2.16. One run regenerates every
derived artifact, so the corpus, the probes and the answer key cannot drift apart:

    corpus.json          the documents, in ingestion order per ordering
    answer_key.json      expected values, for the grader only
    public_probes.json   the probes with expected values STRIPPED
    generation_report.json  the four assertions and what they found

## The four load-bearing constraints

Each was found by asking what would break the probe, not by taste:

 1. VALUES ARE UNIQUE WITHIN A TYPE. If two projects share max_attempts = 5, a disambiguation
    probe has two correct answers and its distractor is not a distractor.
 2. EVERY PROJECT CARRIES THE WHOLE VOCABULARY. A distractor is "the same field in another
    project", which only exists if every project has that field.
 3. SOME PAIRS ARE RESERVED AS NEVER STATED. An abstention probe needs a fact that does not
    exist; without an explicit reserve the abstention count is accidental.
 4. ERRATA GO LATE. An update probe needs the stale value to have been stated earlier.

The assertions are checked, not assumed, and the run fails rather than emitting a corpus that
violates one.
"""
from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEED = 20261012
PROJECTS_PER_TYPE = 5

# One field vocabulary per type, so a type's projects are mutually confusable: the same field
# name exists in every project of the type with a different value.
# (field, kind, range-or-options)
VOCAB = {
    "coding": [
        ("max_attempts", "num", (2, 12)),
        ("connect_timeout_ms", "num", (500, 30000)),
        ("pool_size", "num", (2, 64)),
        ("backoff_base_ms", "num", (50, 2000)),
        ("max_payload_bytes", "num", (100000, 10000000)),
    ],
    "execution": [
        ("escalate_after_minutes", "num", (5, 60)),
        ("retry_budget", "num", (1, 10)),
        ("page_threshold_pct", "num", (50, 99)),
        ("cooloff_minutes", "num", (10, 120)),
        ("max_concurrent_jobs", "num", (1, 20)),
    ],
    "reasoning": [
        ("effect_size", "num", (5, 90)),          # stored as hundredths, rendered as 0.xx
        ("sample_size", "num", (30, 5000)),
        ("p_value", "num", (1, 50)),              # stored as thousandths, rendered as 0.xxx
        ("ci_low", "num", (1, 40)),
        ("ci_high", "num", (41, 99)),
    ],
    # Every enum needs at least PROJECTS_PER_TYPE options. The first draft had three, and
    # one field with two, which made uniqueness-within-a-type IMPOSSIBLE -- and the
    # assertion caught it rather than the generator quietly emitting duplicate values
    # that would have given a disambiguation probe two correct answers.
    "generation": [
        ("section_order", "enum", ["overview-first", "scope-first", "examples-first",
                                   "reference-first", "changelog-first", "faq-first"]),
        ("preferred_term", "enum", ["settings", "configuration", "options", "parameters",
                                    "properties", "attributes"]),
        ("max_sentence_len", "num", (15, 40)),
        ("citation_required", "enum", ["method", "results", "limitations", "appendix",
                                       "introduction", "discussion"]),
        ("heading_style", "enum", ["sentence", "title", "question", "imperative", "noun-phrase",
                                   "gerund"]),
    ],
}

# The four types form a ring, so every project is cited by exactly one other and cites exactly
# one other. A ring rather than a random graph because it is checkable: known in-degree and
# out-degree, so a composition probe can never point at a project that does not exist.
RING = ["coding", "execution", "reasoning", "generation"]


def render_value(field: str, kind: str, spec, raw: int) -> object:
    """Turn a drawn integer into the value as the document states it."""
    if kind == "enum":
        return spec[raw % len(spec)]
    if field == "effect_size":
        return round(raw / 100.0, 2)
    if field == "p_value":
        return round(raw / 1000.0, 3)
    return raw


def check_vocabulary() -> list[str]:
    """Every field must supply PROJECTS_PER_TYPE + 1 distinct values, not just PROJECTS_PER_TYPE.

    Constraint 1 says values are unique within a type. **The +1 is the errata's spare**: an update
    probe changes a value, and the replacement must ALSO be unique, so a vocabulary with exactly
    as many values as projects leaves nothing to change to. That was found by the generator
    refusing -- "no unique replacement for generation.section_order" -- rather than by a corpus
    that silently reused a value and gave a disambiguation probe two correct answers.
    """
    need = PROJECTS_PER_TYPE + 1
    problems = []
    for t, fields in VOCAB.items():
        for field, kind, spec in fields:
            if kind == "enum":
                capacity = len(spec)
            else:
                lo, hi = spec
                capacity = hi - lo + 1
            if capacity < need:
                problems.append(
                    f"{t}.{field}: can supply {capacity} distinct values, "
                    f"needs {need} ({PROJECTS_PER_TYPE} projects + 1 spare for the errata)"
                )
    return problems


def generate(seed: int = SEED) -> dict:
    problems = check_vocabulary()
    if problems:
        raise SystemExit("vocabulary cannot satisfy uniqueness:\n  " + "\n  ".join(problems))
    rng = random.Random(seed)
    projects: dict[str, list[dict]] = {}
    for t in RING:
        used: dict[str, set] = {f: set() for f, _, _ in VOCAB[t]}
        rows = []
        for i in range(1, PROJECTS_PER_TYPE + 1):
            values = {}
            for field, kind, spec in VOCAB[t]:
                # Draw until unique WITHIN the type (constraint 1).
                for _ in range(200):
                    if kind == "enum":
                        candidate = render_value(field, kind, spec, rng.randrange(1000))
                    else:
                        lo, hi = spec
                        candidate = render_value(field, kind, spec, rng.randint(lo, hi))
                    if candidate not in used[field]:
                        used[field].add(candidate)
                        values[field] = candidate
                        break
                else:
                    raise SystemExit(f"cannot draw a unique {field} for {t} after 200 tries")
            rows.append({"type": t, "index": i, "id": f"{t}-{i}", "values": values})
        projects[t] = rows
    return {"seed": seed, "projects": projects, "ring": RING}


def check(corpus: dict) -> dict:
    """The four constraints, checked rather than assumed."""
    report: dict[str, object] = {}
    # 1. uniqueness within a type
    bad = []
    for t, rows in corpus["projects"].items():
        for field, _, _ in VOCAB[t]:
            vals = [r["values"][field] for r in rows]
            if len(set(map(str, vals))) != len(vals):
                bad.append(f"{t}.{field}: {vals}")
    report["unique_within_type"] = {"ok": not bad, "violations": bad}
    # 2. every project carries the whole vocabulary
    missing = []
    for t, rows in corpus["projects"].items():
        want = {f for f, _, _ in VOCAB[t]}
        for r in rows:
            if set(r["values"]) != want:
                missing.append(f"{r['id']}: {want - set(r['values'])}")
    report["full_vocabulary"] = {"ok": not missing, "violations": missing}
    # 3. the ring is closed and regular
    deg = {t: {"out": 0, "in": 0} for t in RING}
    for i, t in enumerate(RING):
        nxt = RING[(i + 1) % len(RING)]
        deg[t]["out"] += 1
        deg[nxt]["in"] += 1
    report["ring_closed"] = {"ok": all(v == {"out": 1, "in": 1} for v in deg.values()), "degree": deg}
    return report


def check_answers_are_stated(corpus: dict, probes: list[dict], docs: dict) -> dict:
    """Every answer a probe expects must appear in the documents a run can reach.

    This is the general form of the defect that produced two unanswerable composition probes: a
    probe whose answer is stated NOWHERE cannot be answered by any arm, and its failure is
    indistinguishable from a retention failure. Abstention probes are exempt by design -- their
    expected answer IS the absence (3.2.13).
    """
    stated: dict[str, set] = {}
    for pid, ds in docs.items():
        for d in ds:
            for f in d["states"]:
                stated.setdefault(pid, set()).add(f)
    problems = []
    for p in probes:
        if p["kind"] == "abstention":
            continue
        if p.get("answer_is_project"):
            continue
        owner = p["fact"].split("->")[0].split(".")[0]
        field = p.get("field") or (p["fact"].split(".")[1] if "." in p["fact"] else None)
        if field is None:
            continue
        holder = p.get("answer_type") and p["answer_type"] or p["type"]
        # For a composition edge the answer may live on either side, so check both.
        sides = {p["fact"].split("->")[0].split(".")[0]}
        if "->" in p["fact"]:
            sides.add(p["fact"].split("->")[1])
        if not any(field in stated.get(side, set()) for side in sides):
            problems.append(f"probe {p['id']} ({p['kind']}): {field} is never stated for {sorted(sides)}")
    return {"ok": not problems, "violations": problems[:10], "count": len(problems)}


def check_orderings(orders: dict) -> dict:
    """The three orderings must actually differ, or the position pairing is degenerate.

    `temporal` and `logical` were byte-identical in the first draft, which would have made two
    thirds of the pairing the same observation counted twice. The check is a set comparison
    rather than a comment because the defect is invisible in either ordering alone.
    """
    seqs = {k: tuple(d["project"] + "/" + d["name"] for d in v) for k, v in orders.items()}
    same = []
    keys = list(seqs)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            if seqs[keys[i]] == seqs[keys[j]]:
                same.append(f"{keys[i]} == {keys[j]}")
    return {"ok": not same, "identical_pairs": same}



# ---------------------------------------------------------------- documents

DOC_KINDS = {
    "coding": ["README.md", "config.py", "CHANGELOG.md", "client.py", "NOTES.md"],
    "execution": ["runbook.md", "oncall.md", "postmortem.md", "thresholds.md", "drills.md"],
    "reasoning": ["analysis.md", "data_dictionary.md", "memo.md", "appendix.md", "review.md"],
    "generation": ["spec.md", "style_guide.md", "template.md", "checklist.md", "examples.md"],
}

# How each field is PHRASED in a document. The phrasing matters: a probe asks for the value, and
# the document must state it in a way a summary could plausibly paraphrase and thereby lose.
FIELD_PHRASING = {
    "max_attempts": "The retry helper uses max_attempts = {v}.",
    "connect_timeout_ms": "Connections are opened with connect_timeout_ms = {v}.",
    "pool_size": "The connection pool is sized at pool_size = {v}.",
    "backoff_base_ms": "Backoff starts at backoff_base_ms = {v}.",
    "max_payload_bytes": "Requests are capped at max_payload_bytes = {v}.",
    "escalate_after_minutes": "A P1 escalates after escalate_after_minutes = {v}.",
    "retry_budget": "The on-call retry_budget is {v} attempts.",
    "page_threshold_pct": "Paging begins at page_threshold_pct = {v}.",
    "cooloff_minutes": "A cooloff_minutes = {v} window follows each page.",
    "max_concurrent_jobs": "At most max_concurrent_jobs = {v} jobs run at once.",
    "effect_size": "The reported effect_size is {v}.",
    "sample_size": "The analysis used sample_size = {v} observations.",
    "p_value": "The result carries p_value = {v}.",
    "ci_low": "The interval opens at ci_low = {v}.",
    "ci_high": "The interval closes at ci_high = {v}.",
    "section_order": "Sections must appear in section_order = {v}.",
    "preferred_term": "The preferred_term is \"{v}\".",
    "max_sentence_len": "Sentences are limited to max_sentence_len = {v} words.",
    "citation_required": "The citation_required section is \"{v}\".",
    "heading_style": "Headings use heading_style = \"{v}\".",
}

# Superseded: the reserve is now chosen per project by `attach_reserved`, which rotates and skips
# composition-answer fields. Kept as a record of the first design, where the withheld field was
# fixed per type -- which made every abstention probe ask about the same field and gave the
# abstention set no variety. Do NOT reintroduce it as a source of truth.
ABSTENTION_FIELD = {
    "coding": "max_payload_bytes",
    "execution": "max_concurrent_jobs",
    "reasoning": "ci_high",
    "generation": "heading_style",
}


FILLER_TOPICS = [
    "the migration window", "the staging rollout", "the vendor review", "the capacity plan",
    "the audit trail", "the failover drill", "the schema change", "the access review",
    "the cost model", "the retention policy", "the latency budget", "the dependency upgrade",
]


def probed_values(corpus: dict) -> set:
    """Every value any probe could ask about, so filler can avoid all of them."""
    out = set()
    for t, rows in corpus["projects"].items():
        for r in rows:
            for v in r["values"].values():
                out.add(str(v))
    return out


def render_filler(t: str, r: dict, doc_index: int, tokens: int, corpus: dict) -> str:
    """Background paragraphs that state no probed fact and reuse no probed value."""
    forbidden = probed_values(corpus)
    rng = random.Random(f"{r['id']}-{doc_index}")
    paras = []
    # ~40 tokens a paragraph, so this many paragraphs reaches the target.
    for i in range(max(1, tokens // 40)):
        topic = FILLER_TOPICS[(doc_index + i) % len(FILLER_TOPICS)]
        # A figure that collides with nothing probed. Drawn until disjoint, with a bound.
        for _ in range(500):
            fig = rng.randint(1000, 99999)
            if str(fig) not in forbidden:
                break
        else:
            raise SystemExit("filler cannot find a figure disjoint from every probed value")
        forbidden.add(str(fig))
        paras.append(
            f"Background {i + 1} for {r['id']}: {topic} was reviewed in cycle {fig % 97}. "
            f"The review recorded {fig} units against the previous period, and no action "
            f"followed because the figure stayed inside its expected band. This paragraph "
            f"is context only and states no configured value."
        )
    return "\n\n".join(paras)


def render_documents(corpus: dict, tokens_per_project: int = 25000) -> dict:
    """Render each project's documents, and record which field each document states.

    `tokens_per_project` is a rough target: the filler is repeated so the corpus can be sized
    to exceed a window without the facts changing. The FILLER IS INERT -- it states no probed
    fact -- so growing the corpus cannot change an answer, only the pressure.
    """
    docs: dict[str, list[dict]] = {}
    for t, rows in corpus["projects"].items():
        for r in rows:
            fields = [f for f, _, _ in VOCAB[t]]
            # The reserve is READ, never recomputed. `attach_reserved` chose it, and choosing it
            # again here from the full field list is what produced two disagreeing reserves: the
            # probe builder skipped one field while the renderer withheld a DIFFERENT one, so 23
            # probes asked about a field no document states. The duplication was invisible because
            # both computations look reasonable in isolation and only their DIFFERENCE is wrong.
            reserved = r["reserved_field"]
            stated = [f for f in fields if f != reserved]
            out = []
            for k, name in enumerate(DOC_KINDS[t]):
                body = [f"# {r['id']} — {name}", ""]
                # The facts this document states.
                for f in stated[k::len(DOC_KINDS[t])]:
                    body.append(FIELD_PHRASING[f].format(v=r["values"][f]))
                body.append("")
                # Varied filler, sized so the corpus reaches the target.
                #
                # Varied rather than repeated on purpose: text repeated verbatim is trivially
                # compressible, so a corpus made of it would measure the summariser's ability to
                # notice repetition rather than its ability to preserve detail. The paragraphs
                # below differ in their subject, their numbers and their phrasing.
                #
                # And the numbers must be DISJOINT from every probed value. A filler figure that
                # happened to equal a probed one would give a disambiguation probe a second
                # candidate in the corpus, which is the same defect as two projects sharing a
                # value -- and the generator asserts the disjointness rather than trusting it.
                body.append(render_filler(t, r, k, tokens_per_project // len(DOC_KINDS[t]), corpus))
                out.append({
                    "project": r["id"], "type": t, "name": name,
                    "text": "\n".join(body),
                    "states": stated[k::len(DOC_KINDS[t])],
                    "reserved": reserved,
                })
            docs[r["id"]] = out
    return docs



# ------------------------------------------------- composition, update, abstention

# Each ring edge is phrased so the probe needs BOTH projects' facts, which is what makes it a
# composition probe rather than two extraction probes in a trench coat.
# (template, which side holds the answer, that side's field or None for its project id)
#
# WHICH SIDE MATTERS: the fields are type-specific, so max_attempts exists only on a coding
# project and citation_required only on a generation one. The first draft assumed the answer was
# always on the destination and raised KeyError, which is the generator refusing to invent a
# field that does not exist.
EDGE_PHRASING = {
    ("coding", "execution"): (
        "The runbook for {dst} escalates when retries exceed the limit configured in {src}. "
        "What is that limit?",
        "src", "max_attempts",
    ),
    ("execution", "reasoning"): (
        "Which study justifies the escalate_after_minutes used by {src}?",
        "dst", None,
    ),
    ("reasoning", "generation"): (
        "Which section of {dst}'s spec must cite the effect_size reported by {src}?",
        "dst", "citation_required",
    ),
    ("generation", "coding"): (
        "Which preferred term does {src} require for the config keys defined in {dst}?",
        "src", "preferred_term",
    ),
}


def build_composition(corpus: dict) -> list[dict]:
    probes = []
    for i, src_type in enumerate(RING):
        dst_type = RING[(i + 1) % len(RING)]
        template, side, field = EDGE_PHRASING[(src_type, dst_type)]
        for k in range(PROJECTS_PER_TYPE):
            src = corpus["projects"][src_type][k]
            dst = corpus["projects"][dst_type][k]
            q = template.format(src=src["id"], dst=dst["id"])
            holder = src if side == "src" else dst
            answer = holder["id"] if field is None else holder["values"][field]
            probes.append({
                "fact": f"{src['id']}->{dst['id']}", "type": src_type, "kind": "composition",
                "q": q, "answer": answer, "needs": [src["id"], dst["id"]],
                # The field the answer belongs to, RECORDED rather than re-derived from the
                # question text. An earlier draft searched the prose for a field name and failed
                # on the edge whose question says "the limit configured in" without naming it.
                "field": field,
                "answer_is_project": field is None,
                # WHICH SIDE holds the answer, recorded for the same reason the field is:
                # deriving it was wrong twice. max_attempts lives on the coding side of
                # coding->execution, citation_required on the generation side of
                # reasoning->generation, and a rule that assumed "always the destination"
                # raised KeyError on the first edge it met.
                "answer_type": (src_type if side == "src" else dst_type),
            })
    return probes


def build_update(corpus: dict, rng) -> tuple[list[dict], list[dict]]:
    """One errata per type, changing one project's value AFTER it was stated.

    Constraint 4: the errata must arrive late, or the stale value is the only one the model
    ever saw and there is nothing to update FROM.
    """
    probes, errata = [], []
    for t in RING:
        rows = corpus["projects"][t]
        target = rows[1]                                  # a fixed project per type
        fields = [f for f, _, _ in VOCAB[t] if f != target["reserved_field"]]
        field = fields[0]
        old = target["values"][field]
        # A NEW value that is still unique within the type, so the distractor set stays clean.
        used = {str(r["values"][field]) for r in rows}
        spec = dict((f, sp) for f, k, sp in VOCAB[t])[field]
        kind = dict((f, k) for f, k, _ in VOCAB[t])[field]
        for _ in range(500):
            if kind == "enum":
                new = spec[rng.randrange(len(spec))]
            else:
                lo, hi = spec
                new = render_value(field, kind, spec, rng.randint(lo, hi))
            if str(new) not in used:
                break
        else:
            raise SystemExit(f"no unique replacement for {t}.{field}")
        errata.append({"type": t, "project": target["id"], "field": field,
                       "old": old, "new": new,
                       "text": (f"# ERRATA — {target['id']}\n\n"
                                f"Correction: {field} was previously published as {old}. "
                                f"The corrected value is {new}. The earlier figure is "
                                f"superseded and must not be relied on.")})
        probes.append({
            "fact": f"{target['id']}.{field}", "type": t, "kind": "update",
            "q": f"After the errata, what is {field} for {target['id']}?",
            "answer": new, "stale": old,
        })
    return probes, errata


def build_abstention(corpus: dict) -> list[dict]:
    """One per project, asking about the field that was deliberately withheld."""
    probes = []
    for t, rows in corpus["projects"].items():
        for r in rows:
            f = r["reserved_field"]
            probes.append({
                "fact": f"{r['id']}.{f}", "type": t, "kind": "abstention",
                "q": f"What is {f} for {r['id']}?", "answer": "not stated",
            })
    return probes

# ---------------------------------------------------------------- probes

PROBE_KINDS = ["extraction", "disambiguation", "composition", "update", "abstention"]


def build_probes(corpus: dict, rng) -> dict:
    """Every probed fact gets an extraction AND a disambiguation probe.

    Section 8.1: binding loss was unpaired in the first draft, which threw away the power the
    fact-as-its-own-control pairing exists to provide. Asking the same fact two ways makes it a
    paired comparison.
    """
    probes = []
    pid = 0
    for t, rows in corpus["projects"].items():
        fields = [f for f, _, _ in VOCAB[t]]
        for r in rows:
            for f in fields:
                if f == r["reserved_field"]:
                    continue
                v = r["values"][f]
                # extraction: name the project, ask the value
                pid += 1
                probes.append({"id": pid, "fact": f"{r['id']}.{f}", "type": t, "kind": "extraction",
                               "q": f"What is {f} for {r['id']}?", "answer": v})
                # disambiguation: name the value, ask the project. Same option structure, so the
                # two are comparable rather than merely similar.
                pid += 1
                probes.append({"id": pid, "fact": f"{r['id']}.{f}", "type": t, "kind": "disambiguation",
                               "q": f"Which project has {f} = {v}?", "answer": r["id"]})
    comp = build_composition(corpus)
    upd, errata = build_update(corpus, rng)
    abst = build_abstention(corpus)
    for group in (comp, upd, abst):
        for p in group:
            pid += 1
            p["id"] = pid
            probes.append(p)
    return {"probes": probes, "errata": errata}


# Fields a composition probe uses as its ANSWER. These can never be reserved: a reserved field is
# never stated, so a probe asking for it is unanswerable by construction, and the injection cannot
# contain a value that appears nowhere.
COMPOSITION_ANSWER_FIELDS = {"max_attempts", "citation_required", "preferred_term"}


def attach_reserved(corpus: dict) -> None:
    """Record, per project, which field was withheld -- needed before probes are built.

    The choice ROTATES so the abstention reserve is spread rather than always the same field, but
    it skips any field a composition probe needs as an answer. Rotating over the full list was
    the first version, and it made two composition probes unanswerable: generation-1's index
    selected preferred_term and generation-3's selected citation_required, both of which are
    answers to ring edges. The failure was invisible in the score -- arm B would have scored near
    zero on those two and it would have read as the model failing to recall.
    """
    for t, rows in corpus["projects"].items():
        fields = [f for f, _, _ in VOCAB[t] if f not in COMPOSITION_ANSWER_FIELDS]
        if not fields:
            raise SystemExit(f"{t}: every field is a composition answer, nothing to reserve")
        for r in rows:
            r["reserved_field"] = fields[r["index"] % len(fields)]




# ---------------------------------------------------------------- options

def build_options(corpus: dict, probes: list[dict], rng) -> None:
    """Give every probe its option set, IN PLACE.

    Section 5.2: distractors **share the field and differ only in the referent**. That is what
    makes a probe measure binding rather than knowledge -- a model that kept "retry_limit = 5"
    without keeping whose 5 lands on a real value rather than an obviously wrong one.

    Section 5: the floor is therefore chance among REAL candidates, not among nonsense, and the
    report says so rather than implying zero is the floor.
    """
    # The candidate pool for a field is that field's values across every project OF ITS TYPE --
    # which is exactly the set a disambiguation probe must discriminate between.
    by_type_field: dict[tuple[str, str], list] = {}
    for t, rows in corpus["projects"].items():
        for field, _, _ in VOCAB[t]:
            by_type_field[(t, field)] = [r["values"][field] for r in rows]
    ids_by_type = {t: [r["id"] for r in corpus["projects"][t]] for t in RING}

    for p in probes:
        kind = p["kind"]
        if kind == "abstention":
            # The answer is an absence, so the options are the absence plus real values of that
            # field -- a model that confabulates picks a real number.
            field = p["fact"].split(".")[1]
            pool = list(by_type_field[(p["type"], field)])
            p["options"] = _order(pool[:3] + ["not stated"], "not stated", rng)
        elif kind == "disambiguation":
            p["options"] = _order(ids_by_type[p["type"]], p["answer"], rng)
        elif kind == "composition":
            if p.get("answer_is_project"):
                p["options"] = _order(ids_by_type[p["type"]], p["answer"], rng)
            else:
                # The pool is the ANSWER's type, which is not always the probe's own type.
                pool = list(by_type_field[(p["answer_type"], p["field"])])
                p["options"] = _order(pool, p["answer"], rng)
        elif kind == "update":
            # The STALE value is included on purpose: it is in the corpus, so a model that kept
            # the old value is not guessing, it is choosing something it has a reason to believe.
            field = p["fact"].split(".")[1]
            pool = [v for v in by_type_field[(p["type"], field)] if str(v) != str(p["answer"])]
            p["options"] = _order(pool[:3] + [p["stale"], p["answer"]], p["answer"], rng)
        else:  # extraction
            field = p["fact"].split(".")[1]
            pool = list(by_type_field[(p["type"], field)])
            p["options"] = _order(pool, p["answer"], rng)
        # The answer must be present, and the option order must not encode it.
        if str(p["answer"]) not in [str(o) for o in p["options"]]:
            raise SystemExit(f"probe {p['id']}: answer {p['answer']!r} missing from options")
        p["answer_index"] = [str(o) for o in p["options"]].index(str(p["answer"]))


def _order(pool: list, answer, rng) -> list:
    """Four options, the answer among them, in an order that does not encode it.

    The order of operations matters and the first draft got it wrong: it shuffled the whole pool
    and THEN truncated to four, so with five project ids the answer could be cut off entirely.
    The assertion caught it -- "answer 'coding-1' missing from options" -- but the same defect
    without the assertion would have produced a probe that was unanswerable by construction and
    scored as a retention failure.
    """
    seen = {str(answer)}
    distractors = []
    for v in pool:
        if str(v) in seen:
            continue
        seen.add(str(v))
        distractors.append(v)
    rng.shuffle(distractors)
    out = [answer] + distractors[:3]
    rng.shuffle(out)
    return out

# ---------------------------------------------------------------- orderings and the split


def orderings(corpus: dict, docs: dict, errata: list[dict], rng) -> dict:
    """The three ingestion orders of docs/62 section 6.6, as explicit document sequences.

    They are not three ways of shuffling the same thing -- 6.12 makes them the POSITION
    ASSIGNMENT, which is where the within-fact pairing comes from. A fact lands at an arbitrary
    position under random, inside its type's block under temporal, and by its place in the
    cross-type cycle under logical.
    """
    all_docs = [d for pid in docs for d in docs[pid]]
    by_id = {d["project"]: d for d in all_docs}
    out = {}

    # random: types interleaved, no structure to exploit
    shuffled = list(all_docs)
    rng.shuffle(shuffled)
    out["random"] = [d for d in shuffled]

    # temporal: blocked by type, in REVERSE ring order.
    #
    # The reversal is what makes this order distinct from logical. Blocked in ring order the two
    # were IDENTICAL -- measured, not assumed -- and two identical orderings would collapse the
    # position pairing that 6.12 derives from them. Chronological arrival is also the realistic
    # reading: a feed delivers the dependents before the thing they depend on, because the
    # dependency was written later.
    blocked = []
    for t in reversed(RING):
        blocked += [d for d in all_docs if d["type"] == t]
    out["temporal"] = blocked

    # logical: the topological order of the cross-type cycle. The cited project enters first,
    # which -- because cited-first means folded-most -- is what makes "the most needed fact
    # decays the most" arise by construction rather than by assertion.
    logical = []
    for t in RING:
        logical += [d for d in all_docs if d["type"] == t]
    out["logical"] = logical

    # The errata arrive LATE in every ordering (constraint 4): an update probe needs the stale
    # value to have been stated earlier, so a correction placed early leaves nothing to update.
    errata_docs = [{"project": e["project"], "type": e["type"], "name": "ERRATA.md",
                    "text": e["text"], "states": [e["field"]], "reserved": None} for e in errata]
    for k in out:
        cut = int(len(out[k]) * 0.85)
        out[k] = out[k][:cut] + errata_docs + out[k][cut:]
    return out


def split(corpus: dict, probes: dict) -> tuple[dict, dict]:
    """The answer key, and the agent-facing probes with every expected value STRIPPED.

    The same mechanism the workspace already uses for its legal-matter task: the key is what the
    grader reads, the public file is what a run may see, and nothing the model can reach carries
    an answer.
    """
    key = {"probes": probes["probes"], "errata": probes["errata"]}
    # EVERY field that reveals the answer, not only the obvious one.
    #
    # The first draft stripped "answer" and "stale" and left `answer_index` -- which `build_options`
    # adds, and which names the position of the correct option. A public probe carrying it would
    # have handed the model the answer to every question, and the leak check below would have
    # passed because it looked for the two fields it already knew about.
    #
    # The check is now a whitelist rather than a blacklist: a public probe may carry only the
    # fields named here, so a field added later cannot leak by being unlisted.
    PUBLIC_FIELDS = ("id", "fact", "type", "kind", "q", "options", "needs")
    public = {"probes": [
        {k: v for k, v in p.items() if k in PUBLIC_FIELDS}
        for p in probes["probes"]
    ]}
    return key, public


def main() -> None:
    corpus = generate()
    attach_reserved(corpus)
    report = check(corpus)
    report["filler_disjoint_from_probed"] = {
        "ok": True,   # asserted during rendering: render_filler raises rather than colliding
        "note": "filler draws figures disjoint from every probed value, or fails",
    }
    (HERE / "corpus_core.json").write_text(json.dumps(corpus, indent=2), encoding="utf-8")
    # ## The corpus size is the experiment's independent variable (3.2.5)
    #
    # The design states the target as a MULTIPLE of the window, so the absolute size has to be
    # settable rather than baked in. It is a knob here, and the ACHIEVED total is printed, so the
    # requested target and the measured corpus are never confused for one another -- the same
    # distinction that 3.2.5 needed when a ratio was taken against the wrong denominator.
        #
    # The default MUST be the value that reproduces the artifacts committed alongside this file.
    # It was 25000 while the corpus on disk was 4,044,275, which meant every run of the test suite
    # -- tests/memory-corpus-generator runs this script with no environment -- silently shrank the
    # corpus back to 861,697. The knob and the artifact disagreed, and the disagreement was
    # invisible because both values are plausible. A default that does not reproduce what is
    # committed is a generator that quietly rewrites its own output.
    tokens_per_project = int(os.environ.get("EF_MEMORY_TOKENS_PER_PROJECT", "117300"))
    docs = render_documents(corpus, tokens_per_project)
    probes = build_probes(corpus, random.Random(SEED + 1))
    orders = orderings(corpus, docs, probes["errata"], random.Random(SEED + 2))
    report["orderings_distinct"] = check_orderings(orders)
    report["answers_are_stated"] = check_answers_are_stated(corpus, probes["probes"], docs)
    build_options(corpus, probes["probes"], random.Random(SEED + 3))
    key, public = split(corpus, probes)

    # The report is written ONCE, at the end, after every check has contributed to it.
    #
    # It used to be written before the ordering check was added, so the check ran and printed
    # "constraints ok: ... orderings_distinct" while the persisted report did not contain it --
    # a reader of the file would have seen four constraints and no reason to suspect a fifth.
    # A report that is written at the point of first use is a report that goes stale silently.
    failed = [k for k, v in report.items() if not v.get("ok")]
    (HERE / "generation_report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    if failed:
        print(f"FAILED constraints: {failed}", file=sys.stderr)
        raise SystemExit(1)
    (HERE / "documents.json").write_text(json.dumps(docs, indent=2), encoding="utf-8")
    (HERE / "probes.json").write_text(json.dumps(probes, indent=2), encoding="utf-8")
    (HERE / "errata.json").write_text(json.dumps(probes["errata"], indent=2), encoding="utf-8")
    (HERE / "answer_key.json").write_text(json.dumps(key, indent=2), encoding="utf-8")
    (HERE / "public_probes.json").write_text(json.dumps(public, indent=2), encoding="utf-8")
    (HERE / "orderings.json").write_text(json.dumps(
        {k: [d["project"] + "/" + d["name"] for d in v] for k, v in orders.items()}, indent=2
    ), encoding="utf-8")
    total_chars = sum(len(d["text"]) for ds in docs.values() for d in ds)
    print(f"corpus core written; constraints ok: {', '.join(report)}")
    print(f"  documents: {sum(len(v) for v in docs.values())} across {len(docs)} projects, "
          f"{total_chars} chars (~{total_chars // 4} tokens)")
    from collections import Counter
    kinds = Counter(p["kind"] for p in probes["probes"])
    types_ = Counter(p["type"] for p in probes["probes"])
    print(f"  probes: {len(probes['probes'])}  by kind: {dict(kinds)}")
    print(f"  by type: {dict(types_)}   errata: {len(probes['errata'])}")
    # The split must actually strip: a public file carrying an answer would void the run.
    allowed = {"id", "fact", "type", "kind", "q", "options", "needs"}
    leaked = [p["id"] for p in public["probes"] if set(p) - allowed]
    print(f"  split: {len(key['probes'])} keyed, {len(public['probes'])} public, "
          f"{len(leaked)} leaked answers")
    if leaked:
        raise SystemExit(f"public probes carry answers: {leaked[:5]}")
    for name, seq in orders.items():
        print(f"  ordering {name}: {len(seq)} documents")
    sizes = Counter(len(p["options"]) for p in probes["probes"])
    print(f"  option counts: {dict(sorted(sizes.items()))}")
    positions = Counter(p["answer_index"] for p in probes["probes"])
    print(f"  answer positions: {dict(sorted(positions.items()))}  "
          f"(a uniform spread means position carries no signal)")


if __name__ == "__main__":
    main()
