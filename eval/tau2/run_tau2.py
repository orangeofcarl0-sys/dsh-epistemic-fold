"""
RC9: the tau2-Bench-Verified runner.

## What this file is, and is not

It is a SCHEDULER. It decides which (task, arm, replicate) cells run, in what
order, and it aggregates the benchmark's own outcome. It does not define tasks,
does not grade anything, and does not compute a headline of its own.

The headline is the benchmark's: `DB x COMMUNICATE` reward, and pass^k over
repeats. The EF classifier exists only to say WHY a failure happened, never to
change whether it happened.

## Why the schedule is blocked and randomized

The failure this avoids is specific. Running `basic x 24, then economy x 24`
lets any drift in the provider or the model over the run masquerade as a mode
effect: whichever arm ran during a slow or degraded window looks worse. Blocking
by (task, replicate) and shuffling the arms WITHIN each block spreads that drift
across arms instead of concentrating it in one.

## Why the arms never share a context runtime

`basic` mounts the real DSH Basic engine; the tiers mount EF with that preset's
policy. The only difference between cells is the arm, so a difference in the
outcome is attributable to it.

@module run_tau2
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from loguru import logger

# The benchmark's own pieces. Nothing here is reimplemented.
from tau2.data_model.simulation import TerminationReason
from tau2.evaluator.evaluator import EvaluationType, evaluate_simulation
from tau2.orchestrator.orchestrator import Orchestrator
from tau2.registry import registry
from tau2.run import load_tasks
from tau2.user.user_simulator import UserSimulator

# The adapter under test.
from ef_tau2_adapter import ARM_SPECS, EFTau2Agent

# ---------------------------------------------------------------------------
# The frozen selection. Mirrors bench/ef-selectbench-v1.json; kept here as ids
# so a run cannot silently drift from the manifest.
# ---------------------------------------------------------------------------

INTERACTION_CELLS: list[tuple[str, str]] = [
    ("retail", "5"),
    ("retail", "18"),
    ("retail", "21"),
    ("retail", "22"),
    ("airline", "11"),
    ("airline", "42"),
]

# The two tasks the adapter gate uses: a partial rollback and a cross-object
# temporal consistency case, which are the two shapes most likely to break a
# context runtime that loses revisions.
GATE_CELLS: list[tuple[str, str]] = [("retail", "22"), ("airline", "42")]

GATE_ARMS: list[str] = ["basic", "economy"]
SWEEP_ARMS: list[str] = ["basic", "economy", "balanced", "quality"]

SEED = int(os.environ.get("EF_TAU2_SEED", "20261001"))
MAX_STEPS = int(os.environ.get("EF_TAU2_MAX_STEPS", "100"))
MAX_ERRORS = int(os.environ.get("EF_TAU2_MAX_ERRORS", "10"))

# The user simulator runs through tau2's own litellm path, NOT through the EF
# bridge. That is deliberate and it is what makes the comparison meaningful: the
# simulated customer must behave identically in every arm, so it cannot be the
# thing the fold influences. Only the AGENT's context runtime varies.
USER_LLM = os.environ.get("EF_TAU2_USER_LLM", "openai/space-bunny-free")
USER_LLM_ARGS: dict[str, Any] = {
    "api_base": os.environ.get("EF_LIVE_BASE_URL", "https://opencode.ai/zen/v1"),
    "api_key": os.environ.get("EF_LIVE_API_KEY", ""),
    "temperature": 0.0,
}


@dataclass
class Cell:
    """One (task, arm, replicate) episode and everything it produced."""

    domain: str
    task_id: str
    arm: str
    replicate: int
    reward: Optional[float] = None
    db_pass: Optional[bool] = None
    communicate_pass: Optional[bool] = None
    termination: str = ""
    steps: int = 0
    messages: int = 0
    telemetry: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    seconds: float = 0.0

    @property
    def passed(self) -> bool:
        """The benchmark's own verdict: full reward means solved."""
        return self.reward is not None and self.reward >= 1.0

    @property
    def label(self) -> str:
        return f"{self.domain}/{self.task_id}"


def _termination_kind(reason: Any) -> str:
    """
    The canonical lower-case name of a tau2 termination reason.

    ## The defect this exists to prevent

    `TerminationReason` is a `str` enum without a `__str__` override, so
    `str(TerminationReason.USER_STOP)` is `"TerminationReason.USER_STOP"` — not
    `"user_stop"`. The taxonomy compared that string against
    `("agent_stop", "user_stop")`, which is therefore never true, so
    `premature-stop` silently equalled the number of failed cells: every failure
    was reported as a premature stop even when every termination was `USER_STOP`.
    A column that is a constant multiple of another column carries no
    information while looking like it does.

    Measured: `str(TerminationReason.USER_STOP)` is
    `'TerminationReason.USER_STOP'`, which is not in `('agent_stop','user_stop')`
    — so the old test was true for every cell. `.value` is the lower-case form.

    Normalising at BOTH the store site and the compare site means an archive
    written before this fix still classifies correctly.
    """
    value = getattr(reason, "value", reason)
    text = str(value)
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text.lower()


def _git_rev(path: Path) -> Optional[str]:
    """The `HEAD` of the checkout at `path`, or None when it is not a git tree."""
    try:
        out = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def _git_dirty(path: Path) -> Optional[bool]:
    """Whether the checkout at `path` has uncommitted changes; None if unknown."""
    try:
        out = subprocess.run(
            # Untracked files are excluded on purpose: a run leaves `__pycache__`
            # behind, so counting them would make `dirty` permanently true and
            # therefore carry no information. Tracked modifications are the signal
            # that matters — they mean the source under test was edited.
            ["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return bool(out.stdout.strip())


def _checkout(path: Optional[Path], locator: str) -> Optional[dict[str, Any]]:
    """Identify a checkout by what a reader elsewhere can use, not by where it sits.

    The absolute root is deliberately NOT recorded. These archives are tracked
    files, and `tests/release-hygiene.spec.ts` scans every tracked text file for a
    Windows user-profile path: writing an absolute path into a run record would
    fail the release gate and publish one machine's directory layout. The revision
    is the actual anchor — two checkouts of the same commit run the same
    experiment — and `locator` names where to find it without naming a disk.
    """
    if path is None:
        return None
    return {"locator": locator, "rev": _git_rev(path), "dirty": _git_dirty(path)}


def provenance(
    preset: str, arms: list[str], replicates: int, concurrency: int, purpose: str
) -> dict[str, Any]:
    """Everything a later reader needs to re-run this exact experiment.

    `dirty` matters as much as `rev`: a sweep run against a patched adapter is not
    the same experiment as one run against the tag, and the difference is
    invisible from the numbers alone.
    """
    ef_root = Path(__file__).resolve().parents[2]
    tau2_root = os.environ.get("TAU2_ROOT")
    return {
        "schema": "ef-tau2-run/1",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "preset": preset,
        "purpose": purpose,
        "concurrency": concurrency,
        "seed": SEED,
        "maxSteps": MAX_STEPS,
        "arms": arms,
        "replicates": replicates,
        "route": {
            "agentModel": os.environ.get("EF_LIVE_MODEL", "space-bunny-free"),
            "baseUrl": os.environ.get("EF_LIVE_BASE_URL", "https://opencode.ai/zen/v1"),
            "userSimulatorLlm": USER_LLM,
        },
        "ef": _checkout(ef_root, "."),
        "tau2": _checkout(Path(tau2_root).resolve(), "$TAU2_ROOT") if tau2_root else None,
    }


def _load_task(domain: str, task_id: str):
    """Fetch one task by id through the benchmark's own loader."""
    tasks = load_tasks(domain, "base")
    for task in tasks:
        if str(task.id) == str(task_id):
            return task
    raise KeyError(f"task {domain}/{task_id} not found in the base split")


def run_cell(domain: str, task_id: str, arm: str, replicate: int) -> Cell:
    """
    Run one episode through the STOCK tau2 pipeline.

    The orchestrator, the user simulator and the evaluator are all the
    benchmark's. The only substitution is the agent, and the grader is called
    with its default `EvaluationType.ALL`.
    """
    cell = Cell(domain=domain, task_id=task_id, arm=arm, replicate=replicate)
    started = time.perf_counter()

    try:
        task = _load_task(domain, task_id)
        environment = registry.get_env_constructor(domain)()

        agent = EFTau2Agent(
            tools=environment.get_tools(),
            domain_policy=environment.get_policy(),
            domain=domain,
            task_id=str(task_id),
            arm=arm,
        )

        try:
            user_tools = environment.get_user_tools()
        except Exception:  # noqa: BLE001 - domains without user tools raise by design
            user_tools = None

        user = UserSimulator(
            tools=user_tools,
            instructions=str(task.user_scenario),
            llm=USER_LLM,
            llm_args=USER_LLM_ARGS,
        )

        orchestrator = Orchestrator(
            domain=domain,
            agent=agent,
            user=user,
            environment=environment,
            task=task,
            max_steps=MAX_STEPS,
            max_errors=MAX_ERRORS,
            seed=SEED + replicate,
        )
        simulation = orchestrator.run()

        # The official grader, unmodified and with its default evaluation type.
        reward_info = evaluate_simulation(
            simulation=simulation,
            task=task,
            evaluation_type=EvaluationType.ALL,
            solo_mode=False,
            domain=domain,
        )

        cell.reward = reward_info.reward
        cell.termination = _termination_kind(simulation.termination_reason)
        cell.messages = len(simulation.messages)

        # The breakdown is reported so a failure can be attributed, never to
        # override the reward.
        breakdown = reward_info.reward_breakdown or {}
        if "DB" in breakdown:
            cell.db_pass = bool(breakdown["DB"] >= 1.0)
        if "COMMUNICATE" in breakdown:
            cell.communicate_pass = bool(breakdown["COMMUNICATE"] >= 1.0)

        # EF telemetry, attached for diagnosis only.
        bridge = getattr(agent, "_bridge", None)
        if bridge is not None:
            cell.telemetry = bridge.last_telemetry
    except Exception as error:  # noqa: BLE001 - one bad cell must not stop the sweep
        cell.error = f"{type(error).__name__}: {error}"[:400]
    finally:
        cell.seconds = time.perf_counter() - started
    return cell


def schedule(cells: list[tuple[str, str]], arms: list[str], replicates: int) -> list[tuple[str, str, str, int]]:
    """
    Build a blocked, within-block-randomized schedule.

    Blocks are (task, replicate); arms are shuffled inside each block. The
    returned order is what the runner executes, so provider drift over the run
    is spread across arms rather than assigned to one.
    """
    rng = random.Random(SEED)
    plan: list[tuple[str, str, str, int]] = []
    for replicate in range(replicates):
        for domain, task_id in cells:
            block = [(domain, task_id, arm, replicate) for arm in arms]
            rng.shuffle(block)
            plan.extend(block)
    return plan


def pass_k(cells: list[Cell], arm: str, k: int) -> Optional[float]:
    """
    pass^k for one arm: the fraction of k-length groups that ALL succeeded.

    tau2's own reliability measure. A mode that succeeds 4 times in 5 but never
    twice in a row scores high on pass^1 and low on pass^2, which is exactly the
    distinction a single-run comparison cannot see.
    """
    per_task: dict[str, list[Cell]] = {}
    for cell in cells:
        if cell.arm != arm:
            continue
        per_task.setdefault(cell.label, []).append(cell)

    groups = 0
    all_pass = 0
    for _label, runs in per_task.items():
        runs = sorted(runs, key=lambda c: c.replicate)
        for start in range(0, max(0, len(runs) - k + 1)):
            window = runs[start : start + k]
            if len(window) < k:
                continue
            groups += 1
            if all(run.passed for run in window):
                all_pass += 1
    return None if groups == 0 else all_pass / groups


def summarize(cells: list[Cell], arms: list[str]) -> str:
    """Render the report. The headline columns are the benchmark's own."""
    lines: list[str] = []
    lines.append("")
    lines.append("tau2-Bench-Verified — EF context runtimes")
    lines.append("=" * 78)
    lines.append(f"cells={len(cells)}  seed={SEED}  max_steps={MAX_STEPS}")

    failed = [c for c in cells if c.error]
    if failed:
        lines.append("")
        lines.append(f"ERRORED CELLS ({len(failed)}) — reported, not hidden:")
        for cell in failed[:10]:
            lines.append(f"  {cell.label}/{cell.arm}/r{cell.replicate}: {cell.error[:150]}")

    lines.append("")
    lines.append("HEADLINE — the benchmark's own metrics")
    header = f"{'arm':10s}{'n':>4s}{'pass^1':>9s}{'pass^2':>9s}{'pass^4':>9s}{'DB':>8s}{'COMM':>8s}{'meanR':>8s}"
    lines.append(header)
    lines.append("-" * len(header))
    for arm in arms:
        rows = [c for c in cells if c.arm == arm and c.error == ""]
        if not rows:
            lines.append(f"{arm:10s}{0:>4d}{'n/a':>9s}{'n/a':>9s}{'n/a':>9s}{'n/a':>8s}{'n/a':>8s}{'n/a':>8s}")
            continue
        p1 = pass_k(cells, arm, 1)
        p2 = pass_k(cells, arm, 2)
        p4 = pass_k(cells, arm, 4)
        db = [c for c in rows if c.db_pass is not None]
        comm = [c for c in rows if c.communicate_pass is not None]
        mean_r = statistics.mean(c.reward for c in rows if c.reward is not None)

        def fmt(value: Optional[float]) -> str:
            return "n/a" if value is None else f"{value:.2f}"

        lines.append(
            f"{arm:10s}{len(rows):>4d}{fmt(p1):>9s}{fmt(p2):>9s}{fmt(p4):>9s}"
            f"{(sum(1 for c in db if c.db_pass) / len(db) if db else float('nan')):>8.2f}"
            f"{(sum(1 for c in comm if c.communicate_pass) / len(comm) if comm else float('nan')):>8.2f}"
            f"{mean_r:>8.2f}"
        )

    lines.append("")
    lines.append("DIAGNOSTIC — EF telemetry and failure attribution (never the score)")
    lines.append(
        f"{'arm':10s}{'folds':>7s}{'roots':>7s}{'emerg':>7s}{'writes':>8s}"
        f"{'intents':>9s}{'calls':>7s}{'ctxTok':>9s}{'surfNodes':>11s}{'cost':>10s}"
    )
    lines.append("-" * 85)
    for arm in arms:
        rows = [c for c in cells if c.arm == arm and c.error == ""]
        if not rows:
            continue
        tel = [c.telemetry for c in rows if c.telemetry]
        mean = lambda key: statistics.mean([t.get(key, 0) or 0 for t in tel]) if tel else 0.0  # noqa: E731
        # `pendingIntents` is a MEAN at episode end, not a total: a non-zero mean
        # means intents were still outstanding when the episode finished, which
        # is a leak (a producer with no consumer), not work done.
        lines.append(
            f"{arm:10s}{mean('folds'):>7.1f}{mean('roots'):>7.1f}{mean('emergencies'):>7.1f}"
            f"{mean('bundleWrites'):>8.1f}{mean('pendingIntents'):>9.1f}{mean('modelCalls'):>7.1f}"
            f"{mean('promptTokensLast'):>9.0f}{mean('surfaceNodesLast'):>11.1f}{mean('costTotal'):>10.4f}"
        )

    # Failure taxonomy: WHY a run failed, which the benchmark does not answer.
    lines.append("")
    lines.append("FAILURE ATTRIBUTION (EF's contribution; the official score is unchanged)")
    for arm in arms:
        rows = [c for c in cells if c.arm == arm and c.error == ""]
        if not rows:
            continue
        bad = [c for c in rows if not c.passed]
        if not bad:
            lines.append(f"  {arm:10s} no failures in this sample")
            continue
        # Normalised HERE as well as at the store site: an archive written before
        # `_termination_kind` existed carries the `"TerminationReason.X"` form,
        # and re-reading it through the same function keeps it classifying
        # correctly instead of silently counting as premature.
        premature = sum(
            1 for c in bad if _termination_kind(c.termination) not in ("agent_stop", "user_stop")
        )
        db_only = sum(1 for c in bad if c.db_pass is False and c.communicate_pass is not False)
        comm_only = sum(1 for c in bad if c.communicate_pass is False and c.db_pass is not False)
        lines.append(
            f"  {arm:10s} {len(bad)} failed: premature-stop={premature} "
            f"db-only={db_only} communicate-only={comm_only}"
        )

    # The honesty line: say what this sample can and cannot support.
    n = max((sum(1 for c in cells if c.arm == arm and c.error == "") for arm in arms), default=0)
    lines.append("")
    lines.append(f"Sample: at most n={n} episodes per arm. Counts are observations, not rate estimates.")
    if n < 20:
        lines.append("  pass^k at this n is indicative only; it cannot separate a mode effect from variance.")
    lines.append("  The benchmark's reward is reported as-is; no EF aggregate score is computed.")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="tau2-Bench-Verified x EF context runtimes")
    parser.add_argument("--preset", choices=["gate", "sweep"], default="gate")
    parser.add_argument("--replicates", type=int, default=None)
    parser.add_argument("--arms", default=None, help="comma-separated arm list")
    parser.add_argument("--out", default=None, help="write the cell records as JSON here")
    parser.add_argument("--concurrency", type=int, default=None)
    parser.add_argument(
        "--purpose",
        choices=["quality", "cost"],
        default="quality",
        help="what the run claims to measure; 'cost' forbids concurrency",
    )
    args = parser.parse_args()

    if args.preset == "gate":
        cells = GATE_CELLS
        arms = args.arms.split(",") if args.arms else GATE_ARMS
        replicates = args.replicates if args.replicates is not None else 1
    else:
        cells = INTERACTION_CELLS
        arms = args.arms.split(",") if args.arms else SWEEP_ARMS
        replicates = args.replicates if args.replicates is not None else 4

    for arm in arms:
        if arm not in ARM_SPECS:
            print(f"unknown arm {arm!r}; expected {sorted(ARM_SPECS)}", file=sys.stderr)
            return 2

    concurrency = args.concurrency if args.concurrency is not None else (1 if args.preset == "gate" else 6)

    # The cost-isolation rule, enforced rather than documented. Concurrent cells
    # share the provider's prefix cache, so one arm can warm another's prefix and
    # no per-arm cost is isolated. A quality run may still print the cost column,
    # but it must not be read as a conclusion.
    if args.purpose == "cost" and concurrency > 1:
        print(
            "refusing: purpose='cost' with concurrency>1. Concurrent cells share the provider "
            "prefix cache, so no per-arm cost is isolated. Use concurrency 1, or run with "
            "purpose='quality' and treat the cost column as non-conclusive.",
            file=sys.stderr,
        )
        return 3

    # The agent must be registered before the runner touches the registry.
    registry.register_agent(EFTau2Agent, "ef_tau2")

    plan = schedule(cells, arms, replicates)
    print(f"tau2 run: preset={args.preset} cells={len(plan)} arms={arms} replicates={replicates}")
    print(f"concurrency={concurrency} purpose={args.purpose}")
    if args.purpose == "quality" and concurrency > 1:
        print("  purpose=quality — the cost column below is NOT a conclusion")
    print("schedule is blocked by (task, replicate) with arms shuffled within each block")
    print("")

    results: list[Cell] = [Cell(domain="", task_id="", arm="", replicate=0) for _ in plan]
    done = 0
    lock = threading.Lock()

    def work(index: int, spec: tuple[str, str, str, int]) -> None:
        nonlocal done
        domain, task_id, arm, replicate = spec
        cell = run_cell(domain, task_id, arm, replicate)
        results[index] = cell
        with lock:
            done += 1
            status = f"ERROR ({cell.error[:70]})" if cell.error else f"reward={cell.reward:.3f} term={cell.termination} {cell.seconds:.0f}s"
            print(f"[{done}/{len(plan)}] {domain}/{task_id} arm={arm} r{replicate} -> {status}", flush=True)

    if concurrency <= 1:
        for index, spec in enumerate(plan):
            work(index, spec)
    else:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(work, index, spec) for index, spec in enumerate(plan)]
            for future in futures:
                future.result()

    report = summarize(results, arms)
    print(report)

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    # Provenance FIRST, so a reader sees what produced the numbers
                    # before the numbers. It names revisions rather than paths.
                    **provenance(args.preset, arms, replicates, concurrency, args.purpose),
                    "cells": [c.__dict__ for c in results],
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
