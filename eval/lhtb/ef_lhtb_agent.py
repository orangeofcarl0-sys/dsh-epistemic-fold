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

# How many consecutive empty responses end the loop. A single blank completion is
# an anomaly to nudge past, not a reason to abandon a multi-hour task.
MAX_EMPTY_STREAK = int(os.environ.get("EF_LHTB_MAX_EMPTY", "5"))

# How many PROVIDER failures are tolerated before the episode is abandoned.
#
# Separate from MAX_EMPTY_STREAK, and deliberately larger, because the two are
# different events: an empty response is the model declining to act (the agent's
# problem), while a provider failure is infrastructure (nobody's problem, and
# usually transient). Conflating them is what let provider load be mistaken for
# mode quality. The adapter already retried a rate limit before reporting one, so
# reaching this ceiling means the route is genuinely down.
MAX_PROVIDER_FAILURES = int(os.environ.get("EF_LHTB_MAX_PROVIDER_FAILURES", "12"))

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
        self._transcript: list[dict[str, Any]] = []

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
        """Run one command in the container and render its result as text."""
        try:
            result = await environment.exec(command=command, timeout_sec=900)
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
        self._bridge.append({"role": "user", "content": instruction})

        total_calls = 0
        empty_streak = 0
        # Provider failures are counted across the WHOLE episode, not per streak:
        # a rate limit that clears and returns must not reset the ledger, or an
        # intermittently-throttled run would look healthy.
        provider_failures = 0
        # Why the loop ended. Recorded because a cell's reward says nothing about
        # it, and the container is deleted afterwards — so "died after 7 calls"
        # was previously unattributable from the archive alone.
        termination = "turn-budget-exhausted"
        # The first step carries no incoming message: the instruction is already
        # in the session.
        reply = self._bridge.step()

        for turn in range(1, MAX_TURNS + 1):
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
            if error:
                provider_failures += 1
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
                if provider_failures > MAX_PROVIDER_FAILURES:
                    termination = f"provider-failures-exceeded ({provider_failures})"
                    break
                reply = self._bridge.step()
                continue

            if not calls:
                content = (reply.get("content") or "").strip()
                finish = str(self._bridge.last_telemetry.get("lastFinishReason", ""))
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
                    reply = self._bridge.step()
                    continue
                # ## Prose with content is NOT necessarily a completion
                #
                # This branch used to end the task on any non-empty text, ignoring
                # the finish reason. A reply truncated at the token cap arrives as
                # `max-tokens` WITH partial text, so a cut-off answer was read as
                # the model declaring itself finished — the quieter and more
                # dangerous of the two misreadings, because it ends a task with no
                # anomaly recorded anywhere.
                #
                # `max-tokens` with no tool calls is an incomplete turn: the model
                # was still writing. Continuing it is what a human reader would do,
                # and it keeps the distinction the measurement needed.
                if finish.endswith("max-tokens"):
                    empty_streak += 1
                    self._transcript.append(
                        {
                            "turn": turn,
                            "anomaly": "truncated response",
                            "streak": empty_streak,
                            "finishReason": finish,
                            "chars": len(content),
                        }
                    )
                    if empty_streak >= MAX_EMPTY_STREAK:
                        termination = f"truncated-streak ({empty_streak})"
                        break
                    self._bridge.append(
                        {
                            "role": "user",
                            "content": (
                                "Your last reply was cut off at the output limit. Continue "
                                "from where it stopped, or run a command with run_shell."
                            ),
                        }
                    )
                    reply = self._bridge.step()
                    continue
                # Prose with content and a normal finish: the model is reporting
                # it is finished.
                termination = "model-reported-completion"
                self._transcript.append({"turn": turn, "assistant": content})
                break

            empty_streak = 0

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
                    output = await self._exec(environment, command)
                    self._transcript.append(
                        {"turn": turn, "tool": name, "command": command[:500], "output": output[:1000]}
                    )
                else:
                    # An EF tool: the bridge dispatches it against the ToolRuntime
                    # and returns the JSON it produced.
                    output = self._bridge.call_tool(name, arguments, call.get("id") or "")
                    self._transcript.append(
                        {"turn": turn, "tool": name, "arguments": arguments, "output": str(output)[:1000]}
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
                "telemetry": telemetry,
                "transcript": self._transcript,
            }
            (self.logs_dir / "ef-transcript.json").write_text(
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
