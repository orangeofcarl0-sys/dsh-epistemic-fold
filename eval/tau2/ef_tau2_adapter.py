"""
RC9: the tau2 side of the bridge.

## What this is

A tau2 `Agent` whose context management is a real DSH Epistemic Fold runtime
instead of a flat message list. The benchmark is untouched: it still supplies the
tools, the domain policy, the user simulator and — critically — the official
`DB x COMMUNICATE` grader, which this file never calls and cannot influence.

## The one thing that must not be done here

The model call does NOT happen in Python. It happens in the Node bridge, against
the surface the fold decided to expose. If this adapter called the provider
itself and merely mirrored the transcript to Node for telemetry, the fold would
run *after* the model had already seen the full context, and the experiment
would measure nothing. See `bridge-host.ts`.

## Where this plugs in

`tau2.run.run_task` constructs the agent from `registry.get_agent_constructor`.
Registering this class under a name lets the standard runner drive it, so the
orchestrator, the user simulator and the evaluator all stay stock.

@module ef_tau2_adapter
"""

from __future__ import annotations

import atexit
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

from loguru import logger

from tau2.agent.base import LocalAgent, ValidAgentInputMessage
from tau2.data_model.message import (
    AssistantMessage,
    Message,
    MultiToolMessage,
    ToolCall,
)
from tau2.environment.tool import Tool

# The EF checkout root, derived from this file's own location
# (`<root>/eval/tau2/ef_tau2_adapter.py`), so the bridge is found without a
# hard-coded absolute path.
EF_ROOT = Path(
    os.environ.get("EF_ROOT", str(Path(__file__).resolve().parents[2]))
).resolve()

# The arm under test. `basic` mounts the real DSH Basic engine; the tiers mount
# EF with that preset's policy.
ARM_ENV = "EF_TAU2_ARM"
DEFAULT_ARM = "basic"

ARM_SPECS: dict[str, dict[str, str]] = {
    "basic": {"label": "basic", "engine": "basic", "mode": "legacy"},
    "economy": {"label": "economy", "engine": "ef", "mode": "economy"},
    "balanced": {"label": "balanced", "engine": "ef", "mode": "balanced"},
    "quality": {"label": "quality", "engine": "ef", "mode": "quality"},
}


class BridgeError(RuntimeError):
    """The Node host refused a request or died."""


class EpistemicFoldBridge:
    """
    A long-lived Node process holding one EF session.

    One instance per episode, so the session, the fold state and the bundle
    store persist across turns. Restarting per turn would reset the very state
    under test.
    """

    def __init__(self, arm: str, bundle_root: str, domain: str, task_id: str) -> None:
        spec = ARM_SPECS.get(arm)
        if spec is None:
            raise BridgeError(
                f"unknown arm {arm!r}; expected one of {sorted(ARM_SPECS)}"
            )
        self.arm = arm
        self.spec = spec
        self.domain = domain
        self.task_id = task_id
        self.telemetry: list[dict[str, Any]] = []
        self.last_telemetry: dict[str, Any] = {}

        env = dict(os.environ)
        env["EF_TAU2_BUNDLE_ROOT"] = bundle_root
        # The credential is inherited through the environment and never passed
        # as an argument, so it cannot appear in a process listing.
        self._proc = subprocess.Popen(
            [
                "node",
                "--experimental-transform-types",
                str(EF_ROOT / "eval" / "tau2" / "bridge-host.ts"),
            ],
            cwd=str(EF_ROOT),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        atexit.register(self.close)

    # -- protocol ---------------------------------------------------------

    def _send(self, request: dict[str, Any]) -> dict[str, Any]:
        """Write one request and read one response line."""
        if self._proc.poll() is not None:
            stderr = ""
            if self._proc.stderr is not None:
                stderr = self._proc.stderr.read() or ""
            raise BridgeError(
                f"bridge host exited with code {self._proc.returncode}: {stderr[-600:]}"
            )
        assert self._proc.stdin is not None and self._proc.stdout is not None
        self._proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            stderr = ""
            if self._proc.stderr is not None:
                stderr = self._proc.stderr.read() or ""
            raise BridgeError(f"bridge host closed the stream: {stderr[-600:]}")
        response = json.loads(line)
        if not response.get("ok"):
            raise BridgeError(str(response.get("error", "unknown bridge error")))
        telemetry = response.get("telemetry")
        if isinstance(telemetry, dict):
            self.last_telemetry = telemetry
            self.telemetry.append(telemetry)
        return response

    def init(self, policy: str, tools: list[Tool]) -> None:
        """Mount the session and the engine for this episode."""
        self._send(
            {
                "op": "init",
                "arm": self.spec,
                "policy": policy,
                "tools": [
                    {
                        "name": tool.name,
                        "description": tool.openai_schema.get("function", {}).get(
                            "description", ""
                        ),
                        "parameters": tool.openai_schema.get("function", {}).get(
                            "parameters", {}
                        ),
                    }
                    for tool in tools
                ],
                "taskId": self.task_id,
                "domain": self.domain,
            }
        )

    def turn(self, message: Message) -> AssistantMessage:
        """Relay one tau2 message and return the assistant's reply."""
        response = self._send({"op": "turn", "message": _to_wire(message)})
        return _from_wire(response["assistant"])

    def close(self) -> None:
        """Tell the host the episode is over, then stop it."""
        if getattr(self, "_closed", False):
            return
        self._closed = True
        try:
            if self._proc.poll() is None:
                self._send({"op": "close"})
        except Exception:  # noqa: BLE001 - shutdown must never mask a result
            pass
        try:
            self._proc.terminate()
            self._proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            try:
                self._proc.kill()
            except Exception:  # noqa: BLE001
                pass


def _to_wire(message: Message) -> dict[str, Any]:
    """Reduce a tau2 message to the fields the bridge consumes."""
    if isinstance(message, MultiToolMessage):
        # Parallel tool calls arrive bundled. The bridge expands them into one
        # DSH event each, because the fold frontier reasons per event.
        return {
            "role": "tool",
            "tool_messages": [_to_wire(inner) for inner in message.tool_messages],
        }
    payload: dict[str, Any] = {"role": message.role}
    if getattr(message, "content", None) is not None:
        payload["content"] = message.content
    if getattr(message, "id", None) is not None:
        payload["id"] = message.id
    if getattr(message, "error", None) is not None:
        payload["error"] = message.error
    return payload


def _from_wire(assistant: dict[str, Any]) -> AssistantMessage:
    """Build the tau2 AssistantMessage the orchestrator expects."""
    raw_calls = assistant.get("tool_calls") or []
    if raw_calls:
        tool_calls = []
        for call in raw_calls:
            arguments = call.get("arguments")
            # tau2 wants a dict; the model emits a JSON string.
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments) if arguments.strip() else {}
                except json.JSONDecodeError:
                    arguments = {}
            tool_calls.append(
                ToolCall(
                    id=call.get("id") or "",
                    name=call["name"],
                    arguments=arguments or {},
                    requestor="assistant",
                )
            )
        return AssistantMessage(role="assistant", content=None, tool_calls=tool_calls)
    return AssistantMessage(role="assistant", content=assistant.get("content") or "")


class EFTau2Agent(LocalAgent[dict]):
    """
    A tau2 agent whose context runtime is the Epistemic Fold.

    The arm is read from `EF_TAU2_ARM` so the same registered class can be driven
    per-arm by the runner, which is what makes a blocked/randomized schedule
    possible without re-registering the agent between cells.
    """

    def __init__(
        self,
        tools: list[Tool],
        domain_policy: str,
        llm: Optional[str] = None,
        llm_args: Optional[dict] = None,
        domain: Optional[str] = None,
        task_id: Optional[str] = None,
        bundle_root: Optional[str] = None,
        arm: Optional[str] = None,
    ) -> None:
        super().__init__(tools=tools, domain_policy=domain_policy)
        # `llm` is intentionally unused: the model call happens in the bridge,
        # against the folded surface. Kept in the signature so the stock
        # `run_task` constructor call works unchanged.
        del llm, llm_args
        # The arm is passed EXPLICITLY, not read from the environment. Concurrent
        # cells run in threads of one process, so an environment variable would be
        # shared mutable state: two cells with different arms would race and one
        # could silently run under the other's mode.
        self.arm = arm or os.environ.get(ARM_ENV, DEFAULT_ARM)
        self.domain = domain or "unknown"
        self.task_id = task_id or "unknown"
        self._bundle_root = bundle_root or os.environ.get(
            "EF_TAU2_BUNDLE_ROOT", str(Path(os.environ.get("TEMP", "/tmp")) / "ef-tau2")
        )
        self._bridge: Optional[EpistemicFoldBridge] = None

    @property
    def bridge(self) -> EpistemicFoldBridge:
        """The bridge, started lazily so construction stays cheap."""
        if self._bridge is None:
            Path(self._bundle_root).mkdir(parents=True, exist_ok=True)
            self._bridge = EpistemicFoldBridge(
                arm=self.arm,
                bundle_root=self._bundle_root,
                domain=self.domain,
                task_id=self.task_id,
            )
            self._bridge.init(self.domain_policy, self.tools)
            logger.info(
                f"EF bridge mounted: arm={self.arm} domain={self.domain} task={self.task_id}"
            )
        return self._bridge

    def get_init_state(self, message_history: Optional[list[Message]] = None) -> dict:
        """tau2 may replay a history; the bridge is authoritative for its own."""
        return {"replayed": len(message_history or [])}

    def generate_next_message(
        self, message: ValidAgentInputMessage, state: dict
    ) -> tuple[AssistantMessage, dict]:
        """Forward one turn to the EF bridge and return its reply."""
        return self.bridge.turn(message), state

    def stop(
        self,
        message: Optional[ValidAgentInputMessage] = None,
        state: Optional[dict] = None,
    ) -> None:
        """
        Close the bridge, keeping the telemetry it produced.

        `_bridge` is deliberately NOT cleared. tau2 calls `stop()` at the end of
        every episode, BEFORE the caller can read anything off the agent, so
        dropping the reference here would discard the episode's whole telemetry
        record — which is exactly what made the first gate run report zero folds
        and zero model calls while the benchmark rewards were real.
        """
        if self._bridge is not None:
            self._bridge.close()

    def set_seed(self, seed: int) -> None:
        """tau2 seeds agents for reproducibility; the bridge has no seed knob."""
        del seed


def register(registry) -> None:
    """Register the agent under the name the runner uses."""
    registry.register_agent(EFTau2Agent, "ef_tau2")


def _self_check() -> int:
    """Fail loudly if the bridge cannot start, before a benchmark run begins."""
    try:
        bridge = EpistemicFoldBridge(
            arm=os.environ.get(ARM_ENV, DEFAULT_ARM),
            bundle_root=str(Path(os.environ.get("TEMP", "/tmp")) / "ef-tau2-probe"),
            domain="probe",
            task_id="0",
        )
    except Exception as error:  # noqa: BLE001
        print(f"EF bridge self-check FAILED: {error}", file=sys.stderr)
        return 1
    bridge.close()
    print(f"EF bridge self-check OK (arm={os.environ.get(ARM_ENV, DEFAULT_ARM)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_check())
