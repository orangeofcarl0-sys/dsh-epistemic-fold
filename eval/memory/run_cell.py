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
import corpus_paths  # noqa: E402
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


# The reply budget for one probe call, and the base the retry escalates from. Read from the
# same variable run-memory.sh sets, so the driver and the runner cannot disagree about it.
PROBE_MAX_TOKENS = int(os.environ.get("EF_BRIDGE_MAX_TOKENS", "8192"))


def empty_reply(reply: dict) -> bool:
    """A call that SUCCEEDED and carried no content.

    Distinct from an error, and the old retry could not see it: the HTTP call returned 200 and
    the model answered with nothing, because it spent the whole output budget on reasoning and
    finished on max-tokens. Measured 2026-10-18 at the host default of 900 tokens: economy came
    back 204/204 unparsed. Across a two-window n=5 sweep, 9 of 40 cells were in this state, and
    every one of them was scored as a total retention failure.
    """
    if reply.get("error"):
        return False
    # ## A reply carrying TOOL CALLS is not empty, it is a request to act
    #
    # The regenerable arm's replies have `content: null` BY DESIGN when the model asks to read
    # something: the shape is assistant-with-tool_calls, and the text only arrives after the
    # results are appended. Without this test that reply looks exactly like a truncation, so the
    # retry re-asks with a bigger budget, the tool calls are never answered, and the session
    # accumulates unanswered calls until the provider rejects the history. Measured 2026-10-19:
    # 20 rounds of "N unanswered tool_call(s) filled", and the cell scored 0 with 202 unparsed.
    if reply.get("tool_calls"):
        return False
    return not str(reply.get("content") or "").strip()


def retryable(error: str) -> bool:
    """Whether an error could plausibly succeed on a later attempt.

    Retryable: a rate limit, a server fault, or a transport failure -- all transient.
    Deterministic: a 4xx that is not 429, which describes the REQUEST and will describe it again.
    """
    for marker in ("HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504",
                   "transport", "fetch failed", "timeout", "ECONNRESET", "socket hang up"):
        if marker.lower() in error.lower():
            return True
    return False


def step_with_tools(bridge, budget: int = PROBE_MAX_TOKENS,
                    max_rounds: int = 64) -> tuple[dict, int]:
    """One probe turn, with tool rounds, for the REGENERABLE arm.

    That arm's whole premise is UNLIMITED access: the model reads whichever documents it wants,
    as often as it wants, for as many rounds as it wants, and only then answers. So a reply that
    carries tool calls is not an answer -- it is the next round, and the results must be appended
    before the model is asked again.

    The round count is bounded only to keep a runaway loop from holding a cell forever; 64 is
    far above what a 204-probe turn needs, so hitting it is a finding rather than a limit the
    reference was measured under. Every other arm calls `step_with_retry` and never comes here,
    because they are given no tools at all.
    """
    failures = 0
    rounds = 0
    reply: dict = {}
    while rounds < max_rounds:
        reply, f = step_with_retry(bridge, budget=budget)
        failures += f
        calls = reply.get("tool_calls") or []
        if not calls:
            return reply, failures
        for call in calls:
            name = str(call.get("name"))
            raw_args = call.get("arguments")
            try:
                parsed = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
            except Exception:
                parsed = {}
            try:
                result = bridge._send({"op": "tool", "name": name, "arguments": parsed,
                                       "callId": str(call.get("id") or "")})
                content = result.get("content") or ""
            except Exception as error:  # a tool failure is data for the next turn
                content = json.dumps({"error": str(error), "tool": name})
            # The result belongs to the call the model already made, so it is appended as a
            # tool message carrying that call id rather than as a new user turn.
            bridge.append({"role": "tool", "id": str(call.get("id") or ""),
                           "content": content})
        rounds += 1
    return reply, failures


def step_with_retry(bridge, max_attempts: int = 6, base_sleep: float = 5.0,
                    budget: int = PROBE_MAX_TOKENS) -> tuple[dict, int]:
    """One model call, retried through a provider failure OR a truncated reply.

    The probe turn is the whole measurement, so a 429 that lands on it would report a cell as
    total retention failure when nothing was measured at all. The retry is bounded and backs off,
    and the number of attempts is recorded, because "the provider was busy" and "the model could
    not recall" are different findings.

    An EMPTY reply is a third case, and it needs a different recovery. ef_bridge_client.step
    documents it: the budget caps reasoning and content together, so the reply arrives empty and
    finishes max-tokens, and "a nudge cannot recover from it -- the recovery is a bigger budget".
    So the budget is passed explicitly and RAISED on each empty reply. Retrying at the same
    budget would reproduce the constraint that truncated it.
    """
    failures = 0
    reply: dict = {}
    scale = 1
    for attempt in range(max_attempts):
        reply = bridge.step(max_tokens=budget * scale)
        if reply.get("error"):
            failures += 1
            if not retryable(str(reply.get("error"))):
                # A DETERMINISTIC error is not going to become true. Retrying it spends the whole
                # backoff budget and, worse, hides the cause: the first plumbing run reported one
                # provider failure, which read as provider turbulence and was in fact a malformed
                # header that would have failed identically on every attempt.
                return reply, failures
        elif empty_reply(reply):
            failures += 1
            scale += 1  # truncation: more room, not another nudge
        else:
            return reply, failures
        time.sleep(min(base_sleep * (2 ** min(failures, 4)), 120))
    return reply, failures



# ---------------------------------------------------------------- batching


# ---------------------------------------------------------------- exposure

def compute_exposure(fact_seqs: dict, fold_lineage: list) -> dict:
    """Per-fact exposure, as a VECTOR over mechanisms (docs/62 section 7.3).

    `exposure(f)` is how many folds had f's seq inside their shadowed range. Section 7.3 is
    explicit that it is not an integer: a leaf fold is local, a root fold is global, and an
    emergency rebase happens under overflow pressure inside a live turn and is likeliest to be
    hasty. "Folded three times by leaves" and "folded once by a root" are not the same event, so
    the three are counted separately and the total is derived rather than stored.

    The other three covariates of 7.2 come from the same structure: `lineage_depth` is how many
    distinct folds touched the fact, `containing_summary_size` is the token count of the smallest
    fold that swallowed it, and `token_distance` is left to the analysis because it depends on
    where the probe is asked rather than on what the engine did.
    """
    out: dict[str, dict] = {}
    for fact, seqs in fact_seqs.items():
        sset = set(seqs)
        counts = {"leaf": 0, "root": 0, "emergency": 0}
        sizes = []
        for fold in fold_lineage:
            shadowed = set(fold.get("shadowedSeqs") or [])
            if sset & shadowed:
                mech = fold.get("mechanism")
                if mech in counts:
                    counts[mech] += 1
                sizes.append(fold.get("shadowedTokenCount"))
        out[fact] = {
            "leaf": counts["leaf"],
            "root": counts["root"],
            "emergency": counts["emergency"],
            "total": sum(counts.values()),
            "lineage_depth": sum(counts.values()),
            "containing_summary_size": min((x for x in sizes if x is not None), default=None),
        }
    return out

def probe_batches(key: dict, docs: dict, errata: list[dict] | None = None) -> list[dict]:
    """Group probes by the documents they need, one batch per project.

    Section 5.3, as corrected: the requirement is NO FOLD BETWEEN PROBES, not one turn. With all
    204 probes in a single turn the union of their needed documents is the ENTIRE corpus -- 100
    documents, 861,703 tokens -- so arm B could not inject it and would have measured truncation
    rather than the model. Batching makes 6.4.1's "minimal injection" achievable.

    A composition probe needs TWO projects, so it rides in its source project's batch and that
    batch injects both. Ten documents is about 86k tokens, which fits a 131k window.
    """
    groups: dict[str, dict] = {}
    for p in key["probes"]:
        # The batch a probe belongs to is its own project; composition carries both.
        owner = p["fact"].split("->")[0].split(".")[0]
        g = groups.setdefault(owner, {"owner": owner, "probes": [], "needs": set()})
        g["probes"].append(p)
        if p.get("answer_is_project"):
            g["needs"].add(p["fact"].split("->")[1])
        elif p.get("needs"):
            g["needs"].update(p["needs"])
        else:
            g["needs"].add(owner)
    out = []
    for owner in sorted(groups):
        g = groups[owner]
        g["needs"] = sorted(g["needs"])
        # The ERRATA document belongs to an update probe's injection (6.4.1: "the project's
        # documents PLUS THE ERRATA"). Leaving it out was caught by validate_injection on four
        # batches: an update probe's answer is the CORRECTED value, which appears nowhere in the
        # project's own documents, so arm B would have scored near zero on every update probe and
        # it would have read as the model failing to find a value that was never supplied.
        g["errata"] = [e for e in (errata or []) if e["project"] in g["needs"]]
        g["docs"] = [f"{pid}/{d['name']}" for pid in g["needs"] for d in docs[pid]]
        out.append(g)
    return out


def validate_injection(batch: dict, docs: dict) -> list[str]:
    """Every injected set must actually contain the answer (6.4, threat 8).

    An injection that does not contain the answer measures the INJECTION rather than the model,
    and the failure is invisible in the score: it looks like the model could not find something
    that was never there.
    """
    problems = []
    texts = {}
    for pid in batch["needs"]:
        texts[pid] = "\n".join(d["text"] for d in docs[pid])
    errata_text = "\n".join(e["text"] for e in batch.get("errata", []))
    for p in batch["probes"]:
        if p["kind"] == "abstention":
            continue                      # nothing is injected, by design (3.2.13)
        if p.get("answer_is_project"):
            target = p["fact"].split("->")[1]
            if target not in texts:
                problems.append(f"probe {p['id']}: {target} not injected")
            continue
        hay = " ".join(texts.values()) + " " + errata_text
        if str(p["answer"]) not in hay:
            problems.append(f"probe {p['id']}: answer {p['answer']!r} absent from the injection")
    return problems


def corpus_with_errata(docs: dict, errata: list) -> dict:
    """The corpus as the driver ingests it: the documents PLUS the errata.

    `orderings.json` places ERRATA.md at 85% of the sequence (3.2.16 constraint 4: errata go
    late, so the stale value was stated earlier). A lookup built from `documents.json` alone
    contains no errata, so those entries resolved to None and were SILENTLY SKIPPED -- the
    correction never entered the corpus, and an update probe would have measured whether the model
    could read the injected errata rather than whether it replaced a value it had already been
    told.

    Written as one function because the two call sites had the identical line, and an edit aimed
    at one of them landed in the other.
    """
    out = {f"{pid}/{d['name']}": d for pid, ds in docs.items() for d in ds}
    for e in errata:
        out[f"{e['project']}/ERRATA.md"] = {
            "project": e["project"], "type": e["type"], "name": "ERRATA.md",
            "text": e["text"], "states": [e["field"]], "reserved": None,
        }
    return out


def load(name: str) -> dict:
    """One corpus artifact, from the tier directory when it is tier-dependent.

    documents.json and generation_report.json differ per window; the other six are byte-identical
    across tiers and live once at eval/memory/. corpus_paths owns that split, so the driver does
    not have to know which is which.
    """
    return json.loads(corpus_paths.corpus_file(name).read_text(encoding="utf-8"))


def run_calibration(arm: str, order_name: str, max_depth: int, target_frac: float) -> dict:
    """Ingest once, then fold repeatedly, recording the surface size after each fold.

    The target is a FRACTION OF THE WINDOW, not of the ingested size (10.6). A fraction of the
    ingested size is only meaningful while the result fits the window, and at four times the window
    it cannot: the first version's 20%-of-ingested target was 31% ABOVE the window, so no mechanism
    could ever reach it and every sweep would have reported "this mechanism cannot reach the target"
    -- a finding about the arithmetic, not about the mechanism.

    The target is also set by the BUDGET rather than chosen: at a probe turn the window must also
    hold the injected batch, the rendered probes and a completion reserve, all scaled by a
    tokenizer that does not agree with a chars/4 estimate. See build_corpus.py.
    """
    orders = load("orderings.json")
    docs = load("documents.json")
    # ## The errata belong to the CORPUS, and this call did not have them
    #
    # corpus_with_errata was called with a name that was never bound, so the calibration path died
    # with NameError the first time it was ever run. Nothing caught it earlier because nothing had
    # ever run it: the endpoint was answering 429 for the whole session in which this was written.
    # A path that has never executed is not a path that works.
    errata = load("errata.json")
    # ## The errata belong to the CORPUS, not only to the injection
    #
    # `orderings.json` places ERRATA.md at 85% of the sequence (3.2.16 constraint 4: errata go
    # late, so the stale value was stated earlier). This lookup was built from `documents.json`
    # alone, which contains no errata -- so the entries in the ordering resolved to None and were
    # SILENTLY SKIPPED. The correction never entered the corpus, and an update probe would have
    # measured whether the model could read the injected errata rather than whether it replaced a
    # value it had already been told.
    by_key = corpus_with_errata(docs, errata)

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
    # The target is a fraction of the WINDOW. Taking it from `ingested` produced a target above
    # the window, which no mechanism can hold.
    window = int(os.environ.get("EF_MEMORY_WINDOW", "131072"))
    target = int(window * target_frac)
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
        "target_frac": target_frac, "target_tokens": target, "window": window,
        "sweep": sweep,
        "depth_to_target": reached[0]["attempt"] if reached else None,
        # A mechanism that cannot reach the target is a FINDING, not something to hide by
        # choosing a target it happens to hit (10.6).
        "reached": bool(reached),
    }


def run_cell(arm: str, order_name: str, depth: int, mode: str, warned: bool,
             inject: bool, limit_docs: int | None, fold_increment_frac: float | None,
             folds: int = 5, fs_root: str | None = None) -> dict:
    orders = load("orderings.json")
    docs = load("documents.json")
    public = load("public_probes.json")
    key = load("answer_key.json")
    by_key = corpus_with_errata(docs, key["errata"])

    bridge = EpistemicFoldBridge(arm=arm, bundle_root=str(HERE / "_bundles"),
                                 domain="memory", task_id=f"{mode}-{arm}-{order_name}")
    # ## The REGENERABLE arm mounts DSH's filesystem seam and nothing else
    #
    # It is the bench's control, and the README states what that means: "regenerable memory,
    # not no compression". The documents are files the model may read as often as it likes,
    # for as many turns as it likes, so nothing is lost to compression OR to having to search
    # the whole corpus at once in a single window. Passing fs_root mounts `ctx.fs` and registers
    # the model-facing read tool; passing no tools list keeps every COMPRESSION arm measured
    # with no tools at all, which is what they have always been.
    bridge.init(SYSTEM_WARNED if warned else SYSTEM_PUSH, [], fs_root=fs_root)

    # ## Which arms get a corpus at all
    #
    # A and B ingest it; C and N do NOT. Section 6.2 is explicit -- C is "a minimal context, plus
    # the same document(s)", and N is "the probe, no corpus" -- and the first version of this
    # driver ingested for every arm, which would have made C identical to B (so the interference
    # term B - C would be identically zero) and the floor meaningless. A silent zero is worse
    # than a loud failure: it reads as "the retained summary does not interfere", which is a
    # finding, when nothing was measured.
    #
    # C still receives the INJECTED documents below, which is what makes it the
    # reading-comprehension ceiling: can the model answer at all when the source is in front of
    # it and nothing else is.
    # Mode R is the regenerable arm: it receives NO corpus, because its whole point is that the
    # corpus stays in the environment rather than in the context.
    ingests_corpus = mode in ("A", "B")
    seq = orders[order_name] if ingests_corpus else []
    if limit_docs:
        seq = seq[:limit_docs]
    # ## The fact -> seq map, without which exposure is unreachable
    #
    # Section 7.2 computes exposure by joining a fact to the fold lineage, and the lineage records
    # the seqs each fold SHADOWED. So the driver has to know which seqs carry which fact. The
    # bridge returns them from `append`; recording them here is what makes the join possible at
    # all. A document states a known set of fields (`states`), so each of those fields inherits
    # the document's seqs.
    #
    # ## Arrival drives the fold, not a request count
    #
    # The previous design appended the WHOLE corpus and then requested folds until the count
    # reached `depth`. Measured, that never worked, and the telemetry said so in every cell:
    #
    #   - natural folds were 0 in 40 of 40 cells, because `append` does not call foldIfNeeded --
    #     only a model call does, and ingestion makes none. The design's own stated premise ("the
    #     corpus is more than four times the window, so ingestion alone forces folds") was false;
    #     the session sat at 4.2x its window for the whole ingest with zero folds, and only got
    #     away with it because nothing called the model during that phase.
    #   - the loop therefore always requested exactly 5, the engine committed 1 and CORRECTLY
    #     declined the other 4 ("below-threshold 22476<65536"). Four of five requests were
    #     provably no-ops.
    #   - so every cell ran at an ACHIEVED depth of 1 while being reported as depth 5. The label
    #     was the requested value, and it was wrong in every result file and every table.
    #
    # Worse, one compression event applied to a static, fully populated surface is not
    # incremental compression at all: no fold's output is ever folded again, and no content
    # arrives after a fold that the fold had to anticipate. That is the pressure this bench
    # exists to measure and it was never applied.
    #
    # So a wave is a fixed quantity of NEW CONTENT -- one window, the tier's own scale -- and a
    # fold is attempted when that much has arrived. Repeating it makes the folds genuinely
    # sequential: each fold compresses the previous fold's output. Whether the fold COMMITS is
    # data, not an assumption, and the achieved depth is recorded beside the target so a cell
    # cannot be labelled with a depth it did not reach.
    window_tokens = int(os.environ.get("EF_MEMORY_WINDOW", "131072"))
    corpus_tokens_est = sum(len(d["text"]) for d in by_key.values()) // 4 if ingests_corpus else 0
    # ## The compression loop: a FIXED number of folds over a fixed corpus
    #
    # The design, stated once:
    #
    #   1. the tier's corpus is fixed and NON-REGENERABLE -- once folded it cannot be re-read
    #   2. it arrives in a fixed number of equal parts
    #   3. one fold is driven after each part, so the compression count is FIXED, not emergent
    #   4. the ENGINE is not permitted to compress on its own at any point
    #   5. after the last part the probe turn runs, with folding still off
    #
    # Five parts is what keeps every fold's span near one part -- about 0.84 of a window at the
    # committed 4.2x ratio -- instead of near the whole corpus. That matters twice: a fold then
    # summarises ~0.84W rather than 4.2W, which fits any model context with room to spare, and
    # the session never has to grow past the window it is simulating. The cadence is therefore
    # derived from the corpus rather than from a depth target: depth was never a free axis,
    # because 4.2 windows of corpus can only be folded so many ways.
    folds_target = folds if ingests_corpus else 0
    increment = corpus_tokens_est // folds_target if folds_target > 0 else 0
    cadence = "corpus/" + str(folds_target)
    max_depth = folds_target
    fact_seqs: dict[str, list[int]] = {}
    fold_events: list[dict] = []
    appended = 0
    high_water = 0
    natural = int(bridge.last_telemetry.get("folds") or 0) if ingests_corpus else 0
    requested = 0
    committed = 0
    declined = 0
    exhausted = False
    # ## Folding is OFF, and stays off except for the exact calls below
    #
    # The engine must not choose when to compress: that would make the fold count depend on the
    # corpus, the threshold and the provider, so no curve could be drawn. Compaction is enabled
    # only around each driven fold and revoked immediately, which is also what stops a fold from
    # consuming the NEXT part before the probes that need it have run.
    compaction_on = bridge.set_compaction(False)
    # Split by DOCUMENT rather than by token: a document is the unit that arrives, and the split
    # is chosen so the parts are as equal as the corpus allows.
    part_size = (len(seq) + folds_target - 1) // folds_target if folds_target > 0 else len(seq)
    # folds_target 0 means "ingest the corpus, fold none of it" -- the unfolded state, which is a
    # legitimate thing to measure. It must still RECEIVE every document; an empty session would
    # score zero and read as a total retention failure when nothing had been measured.
    parts = [seq[i * part_size:(i + 1) * part_size] for i in range(max(1, folds_target))] if folds_target > 0 else [seq]
    for part_index, part in enumerate(parts):
        for k in part:
            d = by_key.get(k)
            if d is None:
                continue
            reply = bridge.append({"role": "user", "content": d["text"]})
            for f in d.get("states", []):
                fact_seqs.setdefault(f"{d['project']}.{f}", []).extend(reply.get("seqs") or [])
            appended += 1
            surface = bridge.last_telemetry.get("promptTokensLast", 0)
            high_water = max(high_water, surface)
        if not ingests_corpus or folds_target <= 0:
            continue
        # One fold per part. The span is whatever arrived since the previous fold, which is one
        # part by construction -- measured and recorded rather than assumed.
        requested += 1
        before = bridge.last_telemetry.get("promptTokensLast", 0)
        _enabled = bridge.set_compaction(True)
        ok = bridge.compact()
        bridge.set_compaction(False)
        after = bridge.last_telemetry.get("promptTokensLast", 0)
        fold_events.append({
            "fold": requested, "part": part_index + 1, "docs_appended": appended,
            "tokens_before": before, "tokens_after": after,
            "span_tokens": before - after, "committed": bool(ok),
            "set_compaction_returned": _enabled,
        })
        if ok:
            committed += 1
            high_water = max(high_water, after)
        else:
            # A part that produced no fold is a FINDING, not something to paper over: the engine
            # declined while the surface was above its threshold, which means the corpus and the
            # policy disagree about whether folding is warranted.
            declined += 1
    if ingests_corpus and folds_target > 0 and committed < folds_target:
        exhausted = True
    ingested = high_water
    ingested_docs = appended
    folds = natural + committed

    # Injection AFTER compaction, so the injected tokens cannot be folded (5.4).
    if inject:
        needed = sorted({p for pr in key["probes"] for p in pr.get("needs", [])})
        for pid in needed:
            for d in docs.get(pid, []):
                bridge.append({"role": "user", "content": d["text"]})

    # Measure a state, do not change one (5.4). Folding was already disabled before the first
    # append and each driven fold re-enabled it for exactly one call, so this is a re-assertion
    # rather than the first switch-off: the probe turn must not fold the compressed state it is
    # about to measure.
    compaction_on = bridge.set_compaction(False)

    # ## Batched probing (5.3 as corrected)
    #
    # The requirement is NO FOLD BETWEEN PROBES, so the probes are grouped by the documents they
    # need rather than forced into one turn. One turn was the first design and it made the injection
    # arms impossible: the union of every probe's needed documents is the entire corpus.
    #
    # ## Compaction is off WITHIN a batch and ON BETWEEN batches (fixed 2026-10-17)
    #
    # It was off for the WHOLE phase, and that is what made arms B and C unmeasurable. Measured:
    # the sum of the per-batch MINIMAL injections is 1,226,520 tokens = 4.75x a 258,048 window, and
    # the injections accumulate because the session only grows. Arms B and C therefore sent
    # 3,330,304 and 3,265,112 tokens and every one of their 20 batches was rejected on window
    # overflow. **The ratio is 4.75x at every tier**, because the corpus is sized as a multiple of
    # the window -- so this was never a tier problem and no window could have fixed it.
    #
    # Folding between batches is the design's own intent: `orderings.json` exists to vary the input
    # order precisely so the result can be decoupled from where the folds fell. Off WITHIN a batch
    # is what keeps the injected set in front of the probes that need it; ON between batches is what
    # keeps the session bounded.
    batches = probe_batches(key, docs, key["errata"])
    started = time.monotonic()
    all_answers: dict[int, str] = {}
    unparsed_all: list[int] = []
    probe_failures = 0
    strict = loose = 0
    turn_chars = 0
    reply_heads = []
    between_batch_folds: list[dict] = []
    for batch in batches:
        if inject:
            # The minimal set for THIS batch, which is what 6.4.1 asks for and what the
            # single-turn design made unreachable.
            for key_name in batch["docs"]:
                pid, name = key_name.split("/", 1)
                doc = next(d for d in docs[pid] if d["name"] == name)
                _last_append = bridge.append({"role": "user", "content": doc["text"]})
            for e in batch["errata"]:
                _last_append = bridge.append({"role": "user", "content": e["text"]})
            # ## The measurement the HOST reports after the injection
            #
            # Recorded because the engine's own view and the provider's payload disagreed by 51x:
            # `compactIfNeeded` saw 65,192 while the request that reached the provider was
            # 3,330,304. Both are `tokenMeter.measure(session).totalTokens`, so they can only differ
            # by WHEN they were taken -- and this is the measurement taken immediately after the
            # documents go in, which is the earliest point the difference can show.
            injected_tokens = (_last_append or {}).get("telemetry", {}).get("promptTokensLast")
        else:
            injected_tokens = None
        batch_public = {"probes": [p for p in public["probes"]
                                   if p["id"] in {q["id"] for q in batch["probes"]}]}
        turn = score_probes.render_probe_turn(batch_public)
        turn_chars += len(turn)
        # ## The turn must be SENT, not merely rendered (fixed 2026-10-17)
        #
        # This line was missing. `turn` was built, measured by len(), and then never appended, so
        # the model was asked to answer questions it had never been shown. Every run at every tier
        # therefore scored 0/204 with `accuracy: null` -- and the failure was provider-independent,
        # which is what proves it: arm N made 20 SUCCESSFUL calls (probe_provider_failures: 0) and
        # its recorded reply_head is an acknowledgement of SYSTEM_PUSH, the only thing in its
        # session. A healthy route, a correct parser, and still 204 unparsed.
        #
        # It read as a parse failure for three rounds because the symptom (unparsed 204) is
        # indistinguishable from one, and because `reply_head` -- which says `(no response)` -- was
        # not read. **A result artifact that records the evidence and is never read is worth exactly
        # as much as one that does not.**
        bridge.append({"role": "user", "content": turn})
        # The regenerable arm gets the tool loop; every other arm has no tools to call and
        # takes the same single call it always did.
        if fs_root is not None:
            reply, failures = step_with_tools(bridge)
        else:
            reply, failures = step_with_retry(bridge)
        probe_failures += failures
        text = reply.get("content") or ""
        if len(reply_heads) < 2:
            reply_heads.append(text[:300])
        got = score_probes.parse_answers(text, [p["id"] for p in batch["probes"]])
        all_answers.update(got["answers"])
        unparsed_all.extend(got["unparsed"])
        strict += got["parsed_strict"]
        loose += got["parsed_loose"]
        if inject:
            # ## Fold this batch away before the next one arrives
            #
            # `compact()` routes through `foldIfNeeded`, which returns immediately while
            # `compactionEnabled` is false -- so the fold is enabled for exactly this call and
            # disabled again, rather than left on to fold the NEXT batch's injection before its
            # probes can see it.
            _enabled = bridge.set_compaction(True)
            after_compact = bridge._send({"op": "compact"})
            batch_committed = bool(after_compact.get("committed"))
            bridge.set_compaction(False)
            between_batch_folds.append({
                "batch": batch["owner"],
                "committed": batch_committed,
                "host_tokens_after_append": injected_tokens,
                "host_tokens_after_compact": (after_compact or {}).get("telemetry", {}).get("promptTokensLast"),
                "leaf_decision": (after_compact or {}).get("telemetry", {}).get("lastLeafDecision"),
                "measure": (after_compact or {}).get("measure"),
                "set_compaction_returned": _enabled,
            })
    # ## Every batch failing is not a score, and must not be written as one

    # Measured 2026-10-18: the DeepSeek account ran out of credit mid-sweep and answered HTTP 402
    # Insufficient Balance to all 20 batches of every subsequent cell. The driver scored each one
    # 0.0000 with 204 unparsed, wrote it as a result file, and the sweep launched 53 more cells
    # that could not possibly succeed -- fifteen minutes of a terminal error being reported as a
    # measurement. A terminal provider error (401/402/403) cannot be fixed by retrying, and a cell
    # whose every batch failed measured nothing at all.
    #
    # So it exits non-zero instead of writing a result. The runner reads that as a stop signal;
    # nothing downstream can mistake an empty cell for a low score.
    # ## All batches failing is not a score -- but only SOME such failures are terminal

    # Measured 2026-10-18: a DeepSeek balance ran out mid-sweep and every later cell answered
    # HTTP 402 to all 20 batches. The driver scored each one 0.0000 with 204 unparsed, wrote it as
    # a result file, and the sweep launched 53 more cells that could not succeed -- fifteen
    # minutes of a terminal error reported as a measurement.

    # Measured again at 252K: the `basic` arm holds the whole corpus unfolded, which at a 4.2x
    # ratio is 1,084,183 tokens against a model context of 1,048,576, so all 20 batches failed on
    # context length. That is a STRUCTURAL limit of the cell, not a dead route, and stopping the
    # sweep for it would be wrong -- the other arms run fine in exactly that window.

    # So the two are distinguished. 401/402/403 cannot be retried away and stop the run; anything
    # else fails this cell only, and no result is written either way, because a cell whose every
    # batch failed measured nothing.
    if batches and probe_failures >= len(batches):
        why = str(bridge.last_telemetry.get("lastProviderError"))
        print(f"CELL FAILED: all {len(batches)} probe batches failed: {why[:300]}", file=sys.stderr)
        bridge.close()
        raise SystemExit(3 if any(c in why for c in ("HTTP 401", "HTTP 402", "HTTP 403")) else 4)

    elapsed = time.monotonic() - started
    parsed = {"answers": all_answers, "unparsed": unparsed_all,
              "parsed_strict": strict, "parsed_loose": loose}
    result = score_probes.score(key, parsed)
    telemetry = bridge.last_telemetry
    # The join section 7.2 describes, now that both sides exist: the fold lineage from the bridge
    # and the fact -> seq map from the appends.
    exposure = compute_exposure(fact_seqs, telemetry.get("foldLineage") or [])
    bridge.close()

    return {
        "cell": {"arm": arm, "order": order_name, "depth": depth, "mode": mode,
                 "warned": warned, "inject": inject, "compaction_disabled": not compaction_on},
        "ingested_tokens": ingested, "ingested_docs": ingested_docs,
        "ingests_corpus": ingests_corpus,
        # Three separate numbers, because conflating them is how the independent variable
        # disappears: the target, what ingestion forced, and what the request added.
        "depth_target": depth,
        # ## The depth actually REACHED, which is the treatment; the target is only a request
        #
        # These differed in every cell of the previous design -- target 5, achieved 1 -- and the
        # TARGET was written into the cell block and into every table, so a cell that had been
        # compressed once was reported as compressed five times. Recording both is what stops the
        # label from being a claim rather than a measurement.
        "depth_achieved": folds,
        "fold_increment_frac": fold_increment_frac,
        "fold_cadence": cadence,
        "fold_increment_tokens": increment,
        "corpus_tokens_estimated": corpus_tokens_est,
        "max_achievable_depth": max_depth,
        "folds_natural": natural,
        "folds_requested": requested,
        "folds_committed": committed,
        "folds_declined": declined,
        "corpus_exhausted": exhausted,
        "fold_events": fold_events,
        "folds_total": folds,
        "probe_turn_chars": turn_chars, "probe_batches": len(batches),
        "probe_seconds": round(elapsed, 1),
        "probe_provider_failures": probe_failures,
        # The first 400 characters of the reply, so a parse failure is diagnosable from the
        # result file rather than only from a rerun.
        "reply_head": (reply_heads[0] if reply_heads else ""),
        "parsed": {"strict": parsed["parsed_strict"], "loose": parsed["parsed_loose"],
                   "unparsed": len(parsed["unparsed"])},
        "score": {k: v for k, v in result.items() if k != "rows"},
        "rows": result["rows"],
        # ## Widened 2026-10-17, because this whitelist cost three wrong diagnoses
        #
        # It kept 9 keys and dropped every field that says WHY something happened. The three
        # defects found today -- the probe turn never being sent, tools being offered to a caller
        # that asked for none, and the reply budget being 900 tokens for a 204-line answer -- were
        # each diagnosed only by reading code, because the artifact could not distinguish them.
        #
        # `pressureRegime` is the specific one: `compactIfNeeded` computes it and returns null at
        # four different points, so the fold that declined between batches left no trace of which
        # point it was. `compactBudget` carries the threshold actually used (including
        # `thresholdTokens`, which is nested there and NOT a top-level key), `lastProviderError` /
        # `lastFinishReason` are the provider's own words, and `efToolsOffered` is what the model
        # was told it could call.
        #
        # REMOVED 2026-10-18: `leafAdmission`, `postLeafRegime` and `foldReachability` were
        # whitelisted here and read `null` in 15 of 15 artifacts, because the bridge never emits
        # them -- `grep` found zero occurrences in eval/tau2/bridge-host.ts. They were added when
        # this list was widened from 9 keys to 22, on the belief that they carried the WHY of a
        # declined fold. A whitelist entry for a key that cannot exist reads as coverage.
        # ADDED 2026-10-18: the TOKEN bill.
        #
        # `costTotal` is `realizedCost(recorder.bill, profile)` -- a price computed
        # under an economics profile, i.e. a modelling choice. This bench runs on a
        # FREE route, so that dollar figure is not spend and is not comparable
        # across routes. bridge-host.ts:1922-1925 says so itself:
        #
        #   "The price depends on a profile that is a modelling choice; the token
        #    count is what the provider actually charged for, and it is comparable
        #    across routes in a way a dollar figure on a free route is not."
        #
        # The bridge already emits all five token fields (bridge-host.ts:1996-2000)
        # and this whitelist was dropping every one of them, so the artifact kept
        # the non-comparable figure and discarded the comparable one. That is the
        # same shape of mistake as the entries removed below: a cost report that
        # cannot answer "what did it spend" in the unit the provider bills in.
        "telemetry": {k: telemetry.get(k) for k in
                      ("folds", "roots", "emergencies", "compactionFailures",
                       "compactionFailureKinds", "promptTokensLast", "surfaceNodesLast",
                       "costTotal", "providerFailures", "pressureRegime",
                       "compactBudget", "lastProviderError",
                       "lastFinishReason", "efToolsOffered", "summarizationAttempts",
                       "summarizationRetryExhausted", "billedCalls", "lastLeafDecision",
                       "lastCompactionError",
                       "rationaleAttempts", "rationaleFailures", "rationaleFailureReason", "rationaleChars",
                       "tokensPrompt", "tokensUncachedInput", "tokensCacheRead",
                       "tokensOutput", "tokensTotal")},
        # The folds the driver ASKED for and whether each committed. `compact()` returns the
        # delta, and discarding it is why "the fold declined" had to be inferred from `folds`
        # staying at 1 while `compactionFailures` stayed at 0.
        "between_batch_folds": between_batch_folds,
        "foldLineage": telemetry.get("foldLineage", []),
        "factSeqs": {k: v for k, v in sorted(fact_seqs.items())},
        "exposure": exposure,
        "exposure_summary": {
            "facts_with_any_fold": sum(1 for v in exposure.values() if v["total"] > 0),
            "facts_total": len(exposure),
            "by_mechanism": {
                m: sum(v[m] for v in exposure.values()) for m in ("leaf", "root", "emergency")
            },
        },
    }


def main() -> None:
    # Refuse BEFORE opening a bridge if this window has no committed corpus. Falling back to
    # another tier would report a measurement of nothing: the corpus was sized for its window, and
    # a 131K corpus read at 1M is not a 1M corpus.
    corpus_paths.require_tier_corpus()
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", default="quality", choices=sorted(ARM_SPECS))
    ap.add_argument("--order", default="logical", choices=["random", "temporal", "logical"])
    # ## The compression count is FIXED, and this is it
    #
    # The corpus is divided into this many equal parts and folded once after each, so the
    # compression count is the design's, not the engine's. It is not a depth target: depth was
    # never a free axis, because 4.2 windows of corpus can only be folded so many ways, and
    # treating it as one is what produced a depth-1 cell that had to hold 4.2 windows unfolded.
    ap.add_argument("--depth", type=int, default=5)
    # How much NEW content drives one fold, as a fraction of the window. Omitted (the default)
    # means corpus/depth: every depth ingests the same corpus and only the number of compressions
    # differs, which is what makes a depth curve a curve. Pass a value for the window cadence.
    ap.add_argument("--fold-increment-frac", type=float, default=None)
    ap.add_argument("--mode", default="A", choices=["A", "B", "C", "N", "R"])
    ap.add_argument("--warned", action="store_true")
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--max-depth", type=int, default=40)
    # A fraction of the WINDOW, not of the ingested size. The first version used 0.20 of the
    # ingested surface, which was 172,339 tokens against a 131,072-token window -- 31% above it,
    # and therefore unreachable by any mechanism.
    # ## The surface target is set by the BUDGET, not chosen (10.6)
    #
    # It was 0.50 of the window. That is not affordable: at a probe turn the window must also hold
    # the injected batch, the rendered probes, the completion reserve, and a tokenizer that does not
    # agree with a chars/4 estimate. Measured, real tokens run 1.02x that estimate; 1.05 is budgeted.
    #
    # With a batch of two whole projects the arithmetic caps the surface at about 0.37W for a
    # four-times corpus, so a 0.50 target makes the design INFEASIBLE -- and infeasibly is silent
    # here: the request still succeeds, the provider truncates, and the score describes the budget
    # rather than the model. 0.30 leaves the probe turn at 0.90W with the corpus at 4.2x.
    #
    # build_corpus.py checks the same arithmetic and refuses to emit a corpus that violates it.
    ap.add_argument("--target-frac", type=float, default=0.30)
    ap.add_argument("--limit-docs", type=int, default=None)
    # The REGENERABLE arm's document root. Passing it mounts DSH's filesystem seam and the
    # model-facing read tool, so the model can read the corpus instead of receiving it. It is
    # required for --mode R and refused for every other mode, because a compression arm measured
    # with a read tool would be measuring a different arm.
    ap.add_argument("--fs-root", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.calibrate:
        out = run_calibration(args.arm, args.order, args.max_depth, args.target_frac)
    else:
        inject = args.mode in ("B", "C")
        if args.mode == "R" and not args.fs_root:
            raise SystemExit("--mode R is the regenerable arm and needs --fs-root: its whole"
                             " point is that the corpus stays readable in the environment")
        if args.mode != "R" and args.fs_root:
            raise SystemExit("--fs-root belongs to --mode R only; a compression arm measured"
                             " with a read tool would be measuring a different arm")
        out = run_cell(args.arm, args.order, args.depth, args.mode, args.warned,
                       inject, args.limit_docs, args.fold_increment_frac,
                       folds=args.depth, fs_root=args.fs_root)

    path = Path(args.out) if args.out else (HERE / f"result_{args.mode}_{args.arm}_{args.order}.json")
    path.write_text(json.dumps(out, indent=2), encoding="utf-8", newline="\n")
    if args.calibrate:
        print(f"calibration {args.arm}/{args.order}: ingested {out['ingested_tokens']} tokens, "
              f"target {out['target_tokens']} ({out['target_frac']:.0%}), "
              f"depth_to_target={out['depth_to_target']} reached={out['reached']}")
        for s in out["sweep"][:12]:
            print(f"  attempt {s['attempt']:2d} committed={str(s['committed']):5s} "
                  f"tokens={s['tokens']} nodes={s['nodes']}")
    else:
        o = out["score"]["overall"]
        # The ACHIEVED fold count leads, because that is the treatment. A cell that could not
        # reach its target says so here rather than being reported at a count it never had.
        #
        # The regenerable arm is exempt: it folds NOTHING on purpose, so a shortfall is what it
        # is supposed to report, and labelling it would read as a failed compression cell.
        regenerable = args.mode == "R"
        short = "" if regenerable or out["depth_achieved"] >= out["depth_target"] else "  SHORT-OF-TARGET"
        if regenerable:
            print(f"cell {args.mode}/{args.arm}/{args.order}: REGENERABLE (no corpus in context, "
                  f"no folds, read tool over {args.fs_root}), "
                  f"accuracy {o['accuracy']} (floor {o['chance_floor']}, "
                  f"unparsed {o['unparsed']})")
        else:
            print(f"cell {args.mode}/{args.arm}/{args.order}: "
                  f"folds {out['depth_achieved']}/{out['depth_target']} "
                  f"(asked {out['folds_requested']}, declined {out['folds_declined']}, "
                  f"{out['fold_cadence']} cadence, increment {out['fold_increment_tokens']} tokens), "
                  f"accuracy {o['accuracy']} (floor {o['chance_floor']}, "
                  f"unparsed {o['unparsed']}){short}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
