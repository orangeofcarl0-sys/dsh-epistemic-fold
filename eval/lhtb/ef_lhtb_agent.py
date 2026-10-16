"""
RC10: the LHTB side of the EF bridge.

## Why this file exists

LHTB (Long-Horizon Terminal-Bench) is the lane that tests EF's actual claim:
sustained work over hundreds of steps, where earlier discoveries must survive to
the end. tau2 tests interaction reliability; this tests long work.

## The architectural fact that makes it possible

Harbor agents run on the HOST and drive the container through
`environment.exec(command=...)`. The agent does NOT run inside the container —
which matters because every LHTB task sets `allow_internet = false`, so a
container-resident agent could not reach any model at all. Because the loop is
host-side, the model call can happen in the EF bridge exactly as it does for
tau2, against the folded surface.

## How it plugs in without touching the benchmark

Harbor's `AgentConfig` accepts an `import_path` ("module:Class"), and
`AgentFactory.create_agent_from_import_path` builds it directly. So the LHTB
checkout stays pristine: the arm is selected by pointing the config at this
module.

## The loop

LHTB has no user simulator — it is instruction -> tool call -> execute -> repeat
until the agent stops or the budget expires. That is the same shape the EF engine
already manages, so the loop here is small.

@module ef_lhtb_agent
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# The bridge client is shared with the tau2 lane; both speak the same protocol.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
from ef_bridge_client import ARM_SPECS, BridgeError, EpistemicFoldBridge  # noqa: E402

# The tool the model calls to run a shell command inside the task container.
SHELL_TOOL = "run_shell"

# How many model turns before the agent is stopped. The task's own agent timeout
# is the real budget; this is a safety net so a looping model cannot run forever.
MAX_TURNS = int(os.environ.get("EF_LHTB_MAX_TURNS", "400"))

# ## The episode's own wall clock
#
# Every other bound in this loop is a COUNT: MAX_TURNS, MAX_WASTED_ATTEMPTS, and the provider-outage
# window -- which resets on any success. So an episode that is merely SLOW has no deadline at all, and
# the only host-side ceiling was harbor's episode budget, measured at 86400 x 3.0 = 72 hours, nine
# times what `lhtb-ef-sweep-ucs.yaml`'s own comment claims (docs/117 section b).
#
# This is the in-episode half of the fix; `eval/lhtb/watchdog.ts` is the out-of-episode half, now
# started by `scripts/run-lhtb.sh` rather than only by ad-hoc launchers.
EPISODE_WALL_SEC = int(os.environ.get("EF_LHTB_EPISODE_WALL_SEC", "14400"))

# How many consecutive empty responses end the loop. A single blank completion is
# an anomaly to nudge past, not a reason to abandon a multi-hour task.
MAX_EMPTY_STREAK = int(os.environ.get("EF_LHTB_MAX_EMPTY", "5"))

# ## The REPLY budget is a reasoning budget too
#
# `max_tokens` caps the model's REASONING and its CONTENT together, so this is not
# "how much the agent may write" — it is how much it may THINK and write. Measured
# on `step-5-preview-free`, reasoning is 47-82% of the completion, and at a small cap
# the whole budget can go to reasoning: the reply then arrives EMPTY and finishes
# `max-tokens`. The provider-probed proof is that an empty `max-tokens` reply means
# every output token was spent on something other than content, and reasoning is the
# only other consumer.
#
# That is a TRUNCATION, and until this existed it was classified as an EMPTY
# RESPONSE. The model was nudged ("your last reply was empty"), retried, was cut off
# in exactly the same place, and the episode died at `MAX_EMPTY_STREAK`. Measured in
# the step-5 round: one `basic` cell returned five consecutive `max-tokens` empties
# at turns 52-56 and was terminated after 56 model calls, having spent 1.04M tokens
# of a four-hour budget, and an `economy` cell reached 4 of the same 5.
#
# The recovery is a BIGGER BUDGET, not a nudge, so a truncation escalates what it
# asks the bridge for. The base must match the bridge's own default
# (`EF_BRIDGE_MAX_TOKENS`); the ceiling bounds how far escalation can go; and the
# streak bounds how many consecutive cut-offs are tolerated.
# One place for the container command bound, instead of the literal 900 that used to sit in
# `_exec` and a second copy in watchdog-policy.ts.
TOOL_TIMEOUT_SEC = int(os.environ.get("EF_LHTB_TOOL_TIMEOUT_SEC", "900"))
# How long past its own bound the CALL may take before we stop waiting for it. Covers the
# handler's own overrun, which is measured at +418s (toolMs=1318479 for a 900s bound).
TOOL_ABANDON_GRACE_SEC = int(os.environ.get("EF_LHTB_TOOL_ABANDON_GRACE_SEC", "600"))

REPLY_MAX_TOKENS = int(
    os.environ.get(
        "EF_LHTB_REPLY_MAX_TOKENS", os.environ.get("EF_BRIDGE_MAX_TOKENS", "32768")
    )
)

# Largest reply budget an escalation may ask for.
REPLY_MAX_TOKENS_CEILING = int(os.environ.get("EF_LHTB_REPLY_MAX_TOKENS_CEILING", "131072"))

# Consecutive cut-off replies tolerated. Each one doubles the budget first, so this
# bounds the escalation ladder rather than the model's mistake: it is deliberately
# not the same ceiling as `MAX_EMPTY_STREAK`, because a cut-off reply and a silent
# model are different events with different recoveries.
MAX_TRUNCATION_STREAK = int(os.environ.get("EF_LHTB_MAX_TRUNCATED", "3"))

# How many PROVIDER failures are tolerated before the episode is abandoned.
#
# Separate from MAX_EMPTY_STREAK, and deliberately larger, because the two are
# different events: an empty response is the model declining to act (the agent's
# problem), while a provider failure is infrastructure (nobody's problem, and
# usually transient). Conflating them is what let provider load be mistaken for
# mode quality. The adapter already retried a rate limit before reporting one, so
# reaching this ceiling means the route is genuinely down.
#
# ## The ceiling has to scale with the EPISODE, and 12 did not
#
# It was 12, which was fine for a 4-hour episode and silently wrong once the
# unknown-config budget was recalibrated to 8 hours: doubling the wall clock
# doubles the number of transport failures a cell meets, while the counter never
# resets. Measured live, one hour into that run:
#
#   195 model calls, 11 provider failures = 5.6%, spread across turns 12-25
#   (NOT a startup burst -- a steady transport rate)
#   projected over the ~218 calls a full episode now takes: ~12 failures
#
# So the expected episode lands EXACTLY on the old ceiling, and any cell on the
# unlucky side of that average dies around hour four with
# `provider-failures-exceeded` -- an infrastructure death recorded against a
# model that did nothing wrong. Four of the eight live cells were already at 1-4
# by turn 30.
#
# 60 keeps the bound meaningful (a genuine outage still stops the episode after 60
# wasted attempts) while tolerating a ~25% transport failure rate across a full
# 218-call episode. A CEILING IS A PROPERTY OF THE EPISODE LENGTH, so it moves
# whenever the budget does.
MAX_PROVIDER_FAILURES = int(os.environ.get("EF_LHTB_MAX_PROVIDER_FAILURES", "60"))

# ## How long an outage is worth waiting for, in SECONDS
#
# A count of failures is the wrong instrument for an outage, and the measurement says so.
# riscv-core-debug's calibration ran 113 turns in 97 minutes and was then killed by
# "provider-failures-exceeded (61 consecutive, 78 total)" -- a real, sustained outage that
# simply outlasted the patience a 60-count ceiling plus a 60-second cap implies (~50
# minutes). The task was working: it had earned 0.28 and was mid-suite when it died.
#
# 60 attempts and 60 seconds are different quantities, and no choice of the first fixes a
# bound expressed in the second. So the terminator is now ELAPSED TIME, and the count is
# kept only to describe what happened.
#
# Two hours against a six-hour budget: long enough to ride out the outages actually
# observed, short enough that a provider that is down for the whole window does not burn
# the entire episode producing a foregone zero.
PROVIDER_OUTAGE_MAX_SEC = float(os.environ.get("EF_LHTB_PROVIDER_OUTAGE_MAX_SEC", "7200"))

# ## Consecutive failures, and a BACKOFF between them
#
# The ceiling counts CONSECUTIVE failures now, not cumulative ones. Cumulative was
# wrong for an episode this long in the same way the old value of 12 was: a cell that
# fails 60 times spread over eight hours, with successes in between, has not suffered
# an outage and must not be terminated as if it had.
#
# The backoff is what makes "consecutive" mean "outage". Retrying immediately burns the
# whole allowance in about a minute of wall clock; waiting up to a minute between
# attempts lets a cell SIT OUT a short outage instead of dying in it. The measured
# failure was not short -- 55 to 61 consecutive turns -- so backoff alone would not
# have saved those cells, but it is what makes the ceiling measure the right thing on
# the next one.
PROVIDER_BACKOFF_MAX_SEC = int(os.environ.get("EF_LHTB_PROVIDER_BACKOFF_SEC", "60"))

# ## How many wasted attempts are tolerated before the episode gives up
#
# A provider failure no longer consumes a turn, so the budget stays fair -- but a
# provider that fails often without ever failing CONSECUTIVELY for
# PROVIDER_OUTAGE_MAX_SEC would otherwise let the loop run until harbor kills the
# container, which yields no termination reason and no reward.
#
# Generous on purpose: at MAX_TURNS * 3 a cell still receives its full MAX_TURNS
# real turns even if three of every four calls fail. Past that the route is too
# broken for the number to mean anything, and saying so is better than being
# killed silently.
MAX_WASTED_ATTEMPTS = int(os.environ.get("EF_LHTB_MAX_WASTED_ATTEMPTS", str(MAX_TURNS * 3)))

# The placeholder the bridge substitutes when the model produced nothing. Kept in
# sync with `EMPTY_TURN_PLACEHOLDER` in bridge-host.ts.
EMPTY_PLACEHOLDER = "(no response)"


def provenance(arm: str) -> dict[str, Any]:
    """
    Identify what produced a run, using only facts a reader elsewhere can use.

    ## Why this exists

    The LHTB numbers were the headline of a findings document and had NO
    machine-readable record: the trials existed only as a table typed into
    Markdown. The tau2 lane records provenance with every sweep, and this is the
    same discipline applied here — a number that cannot be traced to a revision
    is an anecdote.

    ## Why it carries no filesystem path

    An earlier provenance block in the tau2 lane wrote each checkout's ABSOLUTE
    ROOT into a tracked archive, which fails `tests/release-hygiene.spec.ts` (it
    scans every tracked file for a Windows user-profile path) and publishes one
    machine's directory layout. A checkout is therefore identified by what a
    reader elsewhere can act on: the LOCATOR names where to find it without
    naming a disk, and the REVISION is the actual anchor, because two checkouts
    of the same commit run the same experiment.

    A dirty tree is recorded rather than hidden: a run from modified sources is
    not reproducible from the revision alone, and a reader is entitled to know
    that before comparing it against another.

    @param arm - the context runtime the run used.
    @returns the provenance block for the transcript.
    """
    def git(*args: str) -> str:
        try:
            out = subprocess.run(
                ["git", *args],
                cwd=str(Path(__file__).resolve().parents[2]),
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            return out.stdout.strip() if out.returncode == 0 else ""
        except Exception:  # noqa: BLE001 - provenance must never fail a run
            return ""

    return {
        # A relative locator: the EF checkout this module lives in.
        "ef": {
            "locator": ".",
            "rev": git("rev-parse", "--short", "HEAD") or "unknown",
            "dirty": bool(git("status", "--porcelain")),
        },
        # The benchmark is a SEPARATE project and is supplied by the caller, so
        # it is named by the variable that locates it rather than by a path.
        "lhtb": {"locator": "$LHTB_ROOT"},
        "arm": arm,
    }

SYSTEM_TEMPLATE = """\
You are working in a stateful Linux container on a long-horizon task. You act by
calling the `{tool}` tool; the command runs inside the container and its output is
returned to you.

Rules:
- Work step by step. Run commands, read their output, and adapt.
- The task may take hundreds of steps. Keep going until it is genuinely finished.
- Do not report success you have not verified by running a command.
- When the task is complete, reply with plain text (no tool call) saying so.
"""


class EFLhtbAgent(BaseAgent):
    """
    A Harbor agent whose context runtime is the Epistemic Fold.

    The arm is read from `EF_LHTB_ARM` (or the `arm` kwarg) so one class serves
    every arm; the config's `import_path` plus a kwarg selects the mode.
    """

    def __init__(
        self,
        logs_dir: Path,
        model_name: Optional[str] = None,
        arm: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self.arm = arm or os.environ.get("EF_LHTB_ARM", "basic")
        self._bridge: Optional[EpistemicFoldBridge] = None
        # What the host's task-root declaration produced; see the flagged append in `run`.
        self.task_root_telemetry: Optional[dict[str, Any]] = None
        self._transcript: list[dict[str, Any]] = []
        # Tool-command wall clock: the other half of the bridge's `timing` block.
        #
        # The bridge times the model call and the gap between calls. This splits that gap
        # into "running a command in the container" and everything else -- the graded-sample
        # pacing floor, harness round trips, transcript writes. Without both halves the
        # residual was ~74% of a cell's wall clock and no outside measurement could attribute
        # it: the provider answers in 2.5s at 24K tokens and `docker exec` costs ~110ms.
        self._tool_ms = 0.0
        self._tool_ms_max = 0.0
        self._tool_ms_series: list[dict[str, int]] = []

    def _record_tool_ms(self, tool_ms: float) -> None:
        """Accumulate one tool command's wall clock, bounded so a long cell cannot bloat it."""
        self._tool_ms += tool_ms
        self._tool_ms_max = max(self._tool_ms_max, tool_ms)
        if len(self._tool_ms_series) >= 80:
            self._tool_ms_series.pop(0)
        self._tool_ms_series.append({"ms": round(tool_ms)})

    @staticmethod
    def name() -> str:
        return "ef-lhtb"

    def version(self) -> str:
        return "1.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Nothing to install: the agent runs on the host, not in the container."""
        return

    @property
    def tools(self) -> list[dict[str, Any]]:
        """The single tool the model uses to act."""
        return [
            {
                "name": SHELL_TOOL,
                "description": (
                    "Run a shell command inside the task container and return its "
                    "combined output. Use this for every action."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute.",
                        },
                    },
                    "required": ["command"],
                },
            },
        ]

    async def _exec(self, environment: BaseEnvironment, command: str) -> str:
        """Run one command in the container and render its result as text.

        ## Why this carries its OWN deadline on top of harbor's

        `environment.exec` already takes `timeout_sec`, and it enforces it with
        `asyncio.wait_for(process.communicate(), timeout_sec)` (harbor docker.py:335-338). That bound
        is not enough, because **harbor's timeout HANDLER itself ends in an unbounded await**:
        `docker.py:349` is a bare `await process.communicate()` inside `except asyncio.TimeoutError`.

        Measured on a live stalled cell (2026-10-16, 3h10m): harbor spawns
        `docker compose exec` via `asyncio.create_subprocess_exec`, and on Windows `docker.exe` starts
        the `docker-compose.exe` PLUGIN as a separate process and EXITS. The plugin inherits the
        stdout pipe's write end, so `communicate()` never sees EOF. `terminate()`/`kill()` signal only
        the direct child's PID -- already reaped -- so they are no-ops and the real pipe holder is
        never signalled. Live tree at the time: `docker.exe 27144` GONE, `docker-compose.exe 39196`
        (parent 27144) still alive; the container was still running `grep -R cfgd_secret /`.

        So the await is bounded here as well, with `asyncio.wait` and NOT `wait_for`: `wait_for`
        cancels the inner await and then WAITS FOR THE CANCELLATION TO COMPLETE, which is the same
        hang one level up. `asyncio.wait` simply stops waiting, and the abandoned task is cancelled
        without being awaited.
        """
        try:
            task = asyncio.ensure_future(
                environment.exec(command=command, timeout_sec=TOOL_TIMEOUT_SEC),
            )
            done, _pending = await asyncio.wait(
                {task}, timeout=TOOL_TIMEOUT_SEC + TOOL_ABANDON_GRACE_SEC,
            )
            if not done:
                # Best effort. We do NOT await this: a cancellation that cannot complete is the
                # very hang this bound exists to escape.
                task.cancel()
                return (
                    f"<exec timeout: the command did not return within "
                    f"{TOOL_TIMEOUT_SEC + TOOL_ABANDON_GRACE_SEC}s and was abandoned>"
                )
            result = task.result()
        except Exception as error:  # noqa: BLE001 - a failed command is data, not a crash
            return f"<exec error: {type(error).__name__}: {error}>"
        parts: list[str] = []
        if result.stdout:
            parts.append(result.stdout)
        if result.stderr:
            parts.append(f"[stderr]\n{result.stderr}")
        parts.append(f"[exit code: {result.return_code}]")
        return "\n".join(parts)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """
        Drive the episode, and GUARANTEE the bridge is closed however it ends.
        """
        # The bridge is a child PROCESS, so leaving it behind is not a leak of memory but of a live
        # node process holding a session. The episode body used to call `close()` on its normal
        # path only, which meant any exception raised inside the loop -- a `BridgeError` from a
        # dead host, a cancelled coroutine, a provider that never answers -- left the bridge to
        # exit on its own, if it did. `close()` is idempotent, so wrapping it here costs nothing
        # on the normal path and is the difference between "usually closed" and "closed".
        #
        # This covers everything Python can observe: normal return, a raised exception, and a
        # `CancelledError` delivered to this coroutine. It does NOT cover the process being killed
        # outright -- see `_run_episode` and docs/78 for that boundary.
        try:
            await self._run_episode(instruction, environment, context)
        finally:
            if self._bridge is not None:
                self._bridge.close()

    async def _run_episode(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Drive the task loop, folding the transcript as it grows."""
        bundle_root = os.environ.get(
            "EF_LHTB_BUNDLE_ROOT",
            str(Path(os.environ.get("TEMP", "/tmp")) / "ef-tmp" / "lhtb-bundles"),
        )
        Path(bundle_root).mkdir(parents=True, exist_ok=True)

        self._bridge = EpistemicFoldBridge(
            arm=self.arm,
            bundle_root=bundle_root,
            domain="lhtb",
            task_id=str(self.logs_dir.name),
        )
        self._bridge.init(SYSTEM_TEMPLATE.format(tool=SHELL_TOOL), self.tools)

        # The instruction is delivered as a USER message, not folded into the
        # system prompt. This matches how the benchmark's own agents present it,
        # and it matters mechanically: the fold frontier and the token meter both
        # read the message surface, so an instruction that lived only in the
        # system prompt would leave the first request with no messages at all.
        #
        # ## Why this append is FLAGGED, and what the flag does
        #
        # The host is the only party that knows which message is the episode's task
        # instruction, so it declares that here. The bridge never infers it: "the first user
        # message" is a heuristic, and protection resting on it would protect whatever a
        # fixture happened to send first.
        #
        # Whether the declaration has any effect is the ARM's `taskRootMode`, decided in the
        # host: `off` (the default, and always the value for `basic`) registers nothing and the
        # reply reports `unregistered`. Registration happens inside the append, BEFORE any model
        # call, so the first request already runs under whatever protection the arm asked for.
        appended = self._bridge.append({"role": "user", "content": instruction}, task_root=True)
        # Recorded rather than assumed: this is the only place the run's own trace shows what
        # the engine did with the declaration, and `resident` is the engine's answer after it
        # re-derived the event and re-checked the digest -- not the host's hope.
        self.task_root_telemetry = (appended.get("telemetry") or {}).get("taskRoot")

        total_calls = 0
        empty_streak = 0
        # Separate from "empty_streak⟫ -- see "MAX_TRUNCATION_STREAK⟫.
        truncation_streak = 0
        # "None⟫ means "whatever the bridge defaults to"; a truncation raises it and
        # it is never lowered again, because the model needed the room once.
        reply_budget: Optional[int] = None

        def escalate_reply_budget() -> int:
            """
            Raise the reply budget for the next call, capped.

            Doubling is the lever because the failure is a deficit: measured, the
            truncated reply had spent its whole budget on reasoning, so repeating
            the same request reproduces the same cut-off. A ceiling keeps a
            pathological model from asking for an unbounded completion.

            @returns the budget the next "step⟫ should request.
            """
            nonlocal reply_budget
            current = reply_budget if reply_budget is not None else REPLY_MAX_TOKENS
            reply_budget = min(
                current * 2, max(REPLY_MAX_TOKENS_CEILING, REPLY_MAX_TOKENS)
            )
            return reply_budget
        # Provider failures are counted across the WHOLE episode, not per streak:
        # a rate limit that clears and returns must not reset the ledger, or an
        # intermittently-throttled run would look healthy.
        provider_failures = 0
        consecutive_provider_failures = 0
        # When the CURRENT outage began (monotonic), or None while the route is healthy.
        outage_started_at = None
        # Why the loop ended. Recorded because a cell's reward says nothing about
        # it, and the container is deleted afterwards — so "died after 7 calls"
        # was previously unattributable from the archive alone.
        termination = "turn-budget-exhausted"
        # The first step carries no incoming message: the instruction is already
        # in the session.
        reply = self._bridge.step()

        # ## The budget counts MODEL TURNS, not provider luck
        #
        # This was `for turn in range(1, MAX_TURNS + 1)`, and a provider failure
        # consumed an iteration from it -- even though the comment below already said
        # "a provider failure is not a model turn". The two disagreed, and the budget
        # was therefore allocated by provider luck. Measured on a live wave: one cell
        # met a 36% failure rate and another 63%, a wider spread than the differences
        # the arms are being compared on, so the confound was larger than the effect.
        #
        # The turn number now advances only on a call that actually reached the
        # model, so every arm gets MAX_TURNS real turns whatever the network does.
        # Termination is still guaranteed: an uninterrupted outage ends the episode
        # after PROVIDER_OUTAGE_MAX_SEC, and harbor's own wall-clock ceiling bounds
        # the case where failures are frequent but never consecutive.
        turn = 0
        wasted_attempts = 0
        episode_started_at = time.monotonic()
        while turn < MAX_TURNS:
            turn += 1
            elapsed_sec = time.monotonic() - episode_started_at
            if elapsed_sec > EPISODE_WALL_SEC:
                # A wall-clock stop, named as its own reason so the archive can tell it apart from
                # a turn budget or a provider outage.
                termination = (
                    f"episode-wall-clock-exceeded ({int(elapsed_sec)}s of {EPISODE_WALL_SEC}s)"
                )
                break
            calls = reply.get("tool_calls") or []

            # ## A provider failure is not a model turn
            #
            # The bridge sets `error` when the call failed at the provider (429,
            # 5xx, transport), and appends NOTHING to the session for it. This
            # branch must therefore not nudge the model: the model never saw the
            # request, so there is nothing for it to answer, and a nudge would
            # append a turn to the conversation because the PROVIDER was busy.
            #
            # Before this, a 429 arrived as an ordinary empty reply: it counted
            # toward `empty_streak`, a fabricated "your last reply was empty"
            # message entered the history, and five in a row ended the episode.
            # That is how provider load became indistinguishable from mode quality
            # — the two-pass run measured 2/5/7/14% 429 rates across four passes.
            #
            # Retrying is still correct, because a rate limit is transient; what
            # changes is that the retry is counted separately and the failure is
            # recorded as infrastructure rather than as the model declining to act.
            error = reply.get("error")
            # ## A SPENT BUDGET is not a provider failure, and this branch used to eat it
            #
            # The bridge reports a budget stop with its own finish reason AND an `error` string,
            # so this classification caught it first and counted it as infrastructure. Measured
            # with a one-request budget: `providerCalls` correctly stayed at 1, but the episode
            # ran **126 turns** and recorded **125 provider failures**, retrying against a gate
            # that refused every request -- and never set a termination at all.
            #
            # Checked BEFORE the classification, because retrying is the one response that cannot
            # help: the budget that refused will refuse again, and each retry burns wall clock.
            finish_reason = str(self._bridge.last_telemetry.get("lastFinishReason", ""))
            if finish_reason == "budget-exhausted":
                termination = "budget-exhausted"
                break
            # The Task Root contract, likewise: retrying cannot restore a protection the host
            # never established, and continuing would fold an unverified task under an arm that
            # claims `exact`.
            if finish_reason == "task-root-contract":
                termination = "task-root-contract"
                break
            if error:
                provider_failures += 1
                consecutive_provider_failures += 1
                if outage_started_at is None:
                    outage_started_at = time.monotonic()
                self._transcript.append(
                    {
                        "turn": turn,
                        "anomaly": "provider failure",
                        "error": str(error)[:300],
                        "providerFailures": provider_failures,
                    }
                )
                # Bounded, so an outage cannot spin the episode budget away. The
                # allowance is deliberately generous next to MAX_EMPTY_STREAK: a
                # provider recovering is worth waiting for, and the adapter has
                # already retried the rate limit before reporting this.
                # ELAPSED TIME, not attempts. 60 attempts and 60 seconds are different
                # quantities, and no choice of the first bounds a failure expressed in
                # the second: riscv's calibration outlived exactly that combination.
                outage_sec = time.monotonic() - outage_started_at
                if outage_sec > PROVIDER_OUTAGE_MAX_SEC:
                    termination = (f"provider-outage-exceeded "
                                   f"({outage_sec / 60:.0f} min without a successful "
                                   f"call; {consecutive_provider_failures} consecutive, "
                                   f"{provider_failures} total failures)")
                    break
                # Back off before retrying: immediate retries turn a one-minute blip
                # into a terminated episode.
                time.sleep(min(2 ** min(consecutive_provider_failures, 6),
                               PROVIDER_BACKOFF_MAX_SEC))
                # Give the turn back. The request never reached the model, so the
                # episode has not spent one; charging for it is what let a burst of
                # upstream 429s decide how many turns an arm received.
                turn -= 1
                wasted_attempts += 1
                if wasted_attempts > MAX_WASTED_ATTEMPTS:
                    termination = (f"provider-waste-exceeded ({wasted_attempts} attempts "
                                   f"for {turn} model turns; {provider_failures} total "
                                   f"failures)")
                    break
                reply = self._bridge.step(reply_budget)
                continue
            # A successful call ends the outage, whatever the cumulative total is.
            consecutive_provider_failures = 0
            outage_started_at = None

            if not calls:
                content = (reply.get("content") or "").strip()
                finish = str(self._bridge.last_telemetry.get("lastFinishReason", ""))
                # ## A SPENT BUDGET is terminal, and is neither a truncation nor a decline
                #
                # The provider was never asked, so no nudge, no reply-budget escalation and no
                # retry can help: continuing would spend the very budget that refused the
                # request. It is tested FIRST, before the truncation test, because that test's
                # remedy (more room) is the one thing that must not happen here.
                #
                # The reason is its own string. A budget stop must not read as
                # `model-reported-completion`, and it must not read as a provider failure
                # either -- the bridge keeps it out of `providerFailures` for the same reason.
                if finish == "budget-exhausted":
                    termination = "budget-exhausted"
                    break
                # ## A reply cut off by the cap is a TRUNCATION, whether or not any
                # ## text survived
                #
                # This test MUST come first. It used to come second, after the
                # empty-content test, so a reply the cap cut off before it could emit
                # anything was classified as the model DECLINING TO ACT and answered
                # with a nudge. A nudge cannot fix a budget overrun: the model
                # re-derives the same reasoning and is cut off at the same place,
                # which is how five identical `max-tokens` empties ended a multi-hour
                # cell.
                #
                # The two events need opposite responses — silence wants a nudge, a
                # cut-off wants more room — so they are tested in that order and
                # counted separately.
                if finish.endswith("max-tokens"):
                    truncation_streak += 1
                    escalated = escalate_reply_budget()
                    self._transcript.append(
                        {
                            "turn": turn,
                            "anomaly": "truncated response",
                            "streak": truncation_streak,
                            "finishReason": finish,
                            "chars": len(content),
                            "replyBudget": escalated,
                        }
                    )
                    if truncation_streak > MAX_TRUNCATION_STREAK:
                        termination = (
                            f"truncated-streak ({truncation_streak}, "
                            f"budget {escalated})"
                        )
                        break
                    # The nudge differs by whether anything survived: "continue from
                    # where it stopped" means nothing for a reply with no text at all.
                    self._bridge.append(
                        {
                            "role": "user",
                            "content": (
                                "Your last reply was cut off at the output limit. "
                                + (
                                    "Continue from where it stopped, or run a command "
                                    "with run_shell."
                                    if content
                                    else "Retry the step and keep the reasoning brief: "
                                    "run a command with run_shell, or state plainly "
                                    "that the task is complete."
                                )
                            ),
                        }
                    )
                    reply = self._bridge.step(escalated)
                    continue
                # An EMPTY response is an anomaly, not a completion. Treating it
                # as "done" ended the first diagnostic run after 14 shell calls:
                # one blank completion silently terminated a task budgeted in
                # hours, and the verifier then reported reward 0 with no
                # indication of why. The model is nudged instead, and only a
                # sustained streak of blanks ends the loop.
                if content == "" or content == EMPTY_PLACEHOLDER:
                    empty_streak += 1
                    self._transcript.append(
                        {
                            "turn": turn,
                            "anomaly": "empty response",
                            "streak": empty_streak,
                            "finishReason": finish,
                        }
                    )
                    if empty_streak >= MAX_EMPTY_STREAK:
                        termination = f"empty-streak ({empty_streak}, last finish {finish})"
                        break
                    # A transport failure is retried with a plain nudge; the model
                    # never saw the request, so nothing about the task changed.
                    # The message differs only in what it tells the reader.
                    self._bridge.append(
                        {
                            "role": "user",
                            "content": (
                                "Your last reply was empty. Continue the task: run a "
                                "command with run_shell, or state plainly that the task "
                                "is complete."
                            ),
                        }
                    )
                    reply = self._bridge.step(reply_budget)
                    continue
                # Prose with content and a normal finish: the model is reporting
                # it is finished.
                termination = "model-reported-completion"
                self._transcript.append({"turn": turn, "assistant": content})
                break

            empty_streak = 0
            # A productive turn clears the cut-off streak. The ESCALATED BUDGET is
            # deliberately NOT lowered: the model needed the room once, and taking
            # it back would only truncate it again.
            truncation_streak = 0

            # EVERY result from this message is appended BEFORE the next model
            # call. A model may emit several tool calls at once, and calling the
            # model after only the first would show it a transcript with its own
            # remaining calls still unanswered.
            for call in calls:
                arguments = call.get("arguments") or {}
                # The host serializes arguments as a JSON string, matching the
                # wire format a provider returns.
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments) if arguments.strip() else {}
                    except json.JSONDecodeError:
                        arguments = {}
                name = str(call.get("name") or SHELL_TOOL)
                # ROUTE BY NAME, not "everything is a shell command".
                #
                # EF's recall tools are executed by the DSH ToolRuntime inside the
                # bridge process; only `run_shell` runs in the task container.
                # Treating every call as a shell command meant a `context_search`
                # was sent to the container as a command named after its
                # arguments — the model got an error and no retrieval, which is
                # why the earlier runs never exercised recall at all.
                if name == SHELL_TOOL:
                    command = str(arguments.get("command", ""))
                    total_calls += 1
                    tool_started = time.monotonic()
                    output = await self._exec(environment, command)
                    tool_ms = (time.monotonic() - tool_started) * 1000.0
                    self._record_tool_ms(tool_ms)
                    self._transcript.append(
                        {"turn": turn, "tool": name, "command": command[:500],
                         "output": output[:1000], "toolMs": round(tool_ms)}
                    )
                else:
                    # An EF tool: the bridge dispatches it against the ToolRuntime
                    # and returns the JSON it produced.
                    tool_started = time.monotonic()
                    output = self._bridge.call_tool(name, arguments, call.get("id") or "")
                    tool_ms = (time.monotonic() - tool_started) * 1000.0
                    self._record_tool_ms(tool_ms)
                    self._transcript.append(
                        {"turn": turn, "tool": name, "arguments": arguments,
                         "output": str(output)[:1000], "toolMs": round(tool_ms)}
                    )
                self._bridge.append(
                    {
                        "role": "tool",
                        "id": call.get("id") or "",
                        "content": output,
                        "error": False,
                    }
                )
                # Flushed per command, so a killed run still leaves a record.
                self._write_transcript(self._bridge.last_telemetry, total_calls)
            reply = self._bridge.step()

        telemetry = self._bridge.last_telemetry
        context.metadata = {
            "ef_arm": self.arm,
            "ef_telemetry": telemetry,
            "ef_shell_calls": total_calls,
            "ef_termination": termination,
            "ef_provider_failures": provider_failures,
        }
        self._bridge.close()
        self._write_transcript(
            telemetry, total_calls, termination=termination, provider_failures=provider_failures
        )

    def _write_transcript(
        self,
        telemetry: dict[str, Any],
        total_calls: int,
        *,
        termination: str = "in-progress",
        provider_failures: int = 0,
    ) -> None:
        """
        Persist the run's transcript next to Harbor's other agent logs.

        Written after EVERY step, not once at the end. A run stopped by a timeout,
        a killed container, or a host that ran out of memory never reaches the
        end of `run()`, and the first three LHTB probes each lost their entire
        transcript that way — which is the only record of what the agent tried,
        since the verifier reports a reward and nothing else and the container is
        deleted afterwards.

        Failures here are reported but never raised: a diagnostic must not be
        able to fail the measurement it exists to explain.

        ## NOT inside `logs_dir`, because Harbor MOUNTS that into the container

        `logs_dir` is `<cell>/agent`, and Harbor bind-mounts it at `/logs/agent`
        inside the task container — so for as long as this file lived there, the
        agent could read its own history, and did. Measured on the 4.1F round:
        18-137 commands per cell were spent dumping, pickling and grepping it.

        The cost is not only turns. The payload carries `arm` ("economy"),
        `provenance`, `telemetry` (`folds`, `pressureRegime`, `costTotal`,
        `efToolsOffered`) and `termination` — 38 commands across those cells read
        one of them. A cell whose model can see WHICH ARM IT IS is not a clean
        observation of that arm, and `efToolsOffered` is the field the `basic`
        baseline is audited on.

        So it is written one level up, to `<cell>/ef-transcript.json`, which is on
        the host and not mounted. Durability is unchanged — it is still the same
        every-step write to the same filesystem — and `scripts/ef-collect.py`
        already discovers it by `rglob`. Readers that name the old path
        (`scripts/analyze-lhtb-round.py`, `eval/lhtb/watchdog.ts`) accept BOTH, so
        the archives written before this change stay readable.
        """
        try:
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                # /3 adds `termination` and `provider_failures`. Both were missing
                # from every earlier archive, which is why "the cell died after 7
                # model calls" could not be attributed: the reward says nothing
                # about WHY, and the container is deleted afterwards. A /2 reader
                # that looks for these finds them absent and skips, which is the
                # right degradation.
                "schema": "ef-lhtb-transcript/3",
                "provenance": provenance(self.arm),
                "arm": self.arm,
                "shell_calls": total_calls,
                "termination": termination,
                "provider_failures": provider_failures,
                # A status and identifiers, never the instruction itself.
                "task_root": self.task_root_telemetry,
                "telemetry": telemetry,
                # The agent's own half of the wall-clock decomposition. Read against the
                # bridge's `telemetry.timing`: `gapMsTotal` minus `toolTiming.totalMs` is the
                # part of the gap that no command explains.
                "tool_timing": {
                    "totalMs": round(self._tool_ms),
                    "maxMs": round(self._tool_ms_max),
                    "series": self._tool_ms_series,
                },
                "transcript": self._transcript,
            }
            (self.logs_dir.parent / "ef-transcript.json").write_text(
                json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
            )
        except Exception as error:  # noqa: BLE001 - logging must not fail a run
            print(f"ef-lhtb: could not write transcript: {error}", file=sys.stderr)

    def stop(
        self,
        message: Optional[Any] = None,
        state: Optional[Any] = None,
    ) -> None:
        """Harbor may call this; the bridge is closed in `run`'s own flow."""
        if self._bridge is not None:
            self._bridge.close()
