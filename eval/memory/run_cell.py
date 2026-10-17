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
        if not retryable(str(reply.get("error"))):
            # A DETERMINISTIC error is not going to become true. Retrying it spends the whole
            # backoff budget and, worse, hides the cause: the first plumbing run reported one
            # provider failure, which read as provider turbulence and was in fact a malformed
            # header that would have failed identically on every attempt.
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
    return json.loads((HERE / name).read_text(encoding="utf-8"))


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
             inject: bool, limit_docs: int | None) -> dict:
    orders = load("orderings.json")
    docs = load("documents.json")
    public = load("public_probes.json")
    key = load("answer_key.json")
    by_key = corpus_with_errata(docs, key["errata"])

    bridge = EpistemicFoldBridge(arm=arm, bundle_root=str(HERE / "_bundles"),
                                 domain="memory", task_id=f"{mode}-{arm}-{order_name}")
    bridge.init(SYSTEM_WARNED if warned else SYSTEM_PUSH, [])

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
    ingests_corpus = mode in ("A", "B")
    seq = orders[order_name] if ingests_corpus else []
    if limit_docs:
        seq = seq[:limit_docs]
    appended = 0
    # ## The fact -> seq map, without which exposure is unreachable
    #
    # Section 7.2 computes exposure by joining a fact to the fold lineage, and the lineage records
    # the seqs each fold SHADOWED. So the driver has to know which seqs carry which fact. The
    # bridge returns them from `append`; recording them here is what makes the join possible at
    # all. A document states a known set of fields (`states`), so each of those fields inherits
    # the document's seqs.
    fact_seqs: dict[str, list[int]] = {}
    for k in seq:
        d = by_key.get(k)
        if d is not None:
            reply = bridge.append({"role": "user", "content": d["text"]})
            for f in d.get("states", []):
                fact_seqs.setdefault(f"{d['project']}.{f}", []).extend(reply.get("seqs") or [])
            appended += 1
    # Read AFTER the last append. The first draft read it from the telemetry carried by `init`,
    # which describes an empty session, so a full corpus reported an ingested size of zero.
    ingested = bridge.last_telemetry.get("promptTokensLast", 0)
    ingested_docs = appended

    # ## Depth is the ACHIEVED TOTAL, not the number of requests
    #
    # The corpus is more than four times the window (3.2.5), so ingestion alone forces folds: the
    # surface cannot fit otherwise. Requesting "depth 5" on top of the folds ingestion already
    # committed would give a total that depends on the corpus rather than on the request, and the
    # requested depth would barely move it -- which is the independent variable gone.
    #
    # So the target is a TOTAL, and the loop asks only for the difference. Natural folds are read
    # from telemetry rather than inferred, and a corpus that folds more than the target is
    # reported rather than silently corrected, because "the target was already exceeded before I
    # asked" is a fact about the cell.
    # Without a corpus there is nothing to fold, so the target applies only to the arms that
    # ingested one. Asking C or N for depth would be asking them to compress a document set that
    # is already minimal.
    natural = int(bridge.last_telemetry.get("folds") or 0) if ingests_corpus else 0
    requested = 0
    committed = 0
    for _ in range(max(0, depth - natural) if ingests_corpus else 0):
        requested += 1
        if bridge.compact():
            committed += 1
    folds = natural + committed

    # Injection AFTER compaction, so the injected tokens cannot be folded (5.4).
    if inject:
        needed = sorted({p for pr in key["probes"] for p in pr.get("needs", [])})
        for pid in needed:
            for d in docs.get(pid, []):
                bridge.append({"role": "user", "content": d["text"]})

    # Measure a state, do not change one (5.4).
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
        "folds_natural": natural,
        "folds_requested": requested,
        "folds_committed": committed,
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
        # `pressureRegime` and `leafAdmission` are the specific ones: `compactIfNeeded` computes
        # both (src/engine.ts:1113,1134) and returns null at four different points, so the fold
        # that declined between batches left no trace of which point it was. `compactBudget` is the
        # threshold actually used, `lastProviderError`/`lastFinishReason` are the provider's own
        # words, and `efToolsOffered` is what the model was told it could call.
        "telemetry": {k: telemetry.get(k) for k in
                      ("folds", "roots", "emergencies", "compactionFailures",
                       "compactionFailureKinds", "promptTokensLast", "surfaceNodesLast",
                       "costTotal", "providerFailures", "pressureRegime", "leafAdmission",
                       "compactBudget", "thresholdTokens", "lastProviderError",
                       "lastFinishReason", "efToolsOffered", "summarizationAttempts",
                       "summarizationRetryExhausted", "billedCalls", "lastLeafDecision",
                       "lastCompactionError", "postLeafRegime", "foldReachability",
                       "rationaleAttempts", "rationaleFailures", "rationaleFailureReason", "rationaleChars")},
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", default="quality", choices=sorted(ARM_SPECS))
    ap.add_argument("--order", default="logical", choices=["random", "temporal", "logical"])
    ap.add_argument("--depth", type=int, default=5)
    ap.add_argument("--mode", default="A", choices=["A", "B", "C", "N"])
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
