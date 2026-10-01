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
        # The first step carries no incoming message: the instruction is already
        # in the session.
        reply = self._bridge.step()

        for turn in range(1, MAX_TURNS + 1):
            calls = reply.get("tool_calls") or []

            if not calls:
                # The model answered in prose: the task loop is over.
                self._transcript.append({"turn": turn, "assistant": reply.get("content")})
                break

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
                command = str(arguments.get("command", ""))
                total_calls += 1
                output = await self._exec(environment, command)
                self._transcript.append(
                    {"turn": turn, "command": command[:500], "output": output[:1000]}
                )
                self._bridge.append(
                    {
                        "role": "tool",
                        "id": call.get("id") or "",
                        "content": output,
                        "error": False,
                    }
                )
            reply = self._bridge.step()

        telemetry = self._bridge.last_telemetry
        context.metadata = {
            "ef_arm": self.arm,
            "ef_telemetry": telemetry,
            "ef_shell_calls": total_calls,
        }
        self._bridge.close()

    def stop(
        self,
        message: Optional[Any] = None,
        state: Optional[Any] = None,
    ) -> None:
        """Harbor may call this; the bridge is closed in `run`'s own flow."""
        if self._bridge is not None:
            self._bridge.close()
