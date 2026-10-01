"""
The EF bridge client, shared by both benchmark lanes.

## Why this is its own module

The bridge host is framework-agnostic: it holds one EF session, folds it, and
issues the model call against the folded surface. tau2 and Harbor are two
different Python frameworks with disjoint dependency sets, so the client must
import under both. Keeping it here — with no tau2, no harbor, and no loguru
import — is what allows that.

The tau2 lane wraps this with tau2's message classes; the LHTB lane speaks the
raw dict protocol directly.

## Protocol

One Node host process per episode, newline-delimited JSON over stdio:

  {"op":"init",  "arm":{...}, "policy":"...", "tools":[...], ...}
  {"op":"turn",  "message":{...}}
  {"op":"close"}

Each request gets exactly one response line, either
`{"ok":true,...}` or `{"ok":false,"error":"..."}`.

The process is kept alive across turns because the session, the fold state and
the bundle store ARE the thing under test; restarting per turn would reset them.

@module ef_bridge_client
"""

from __future__ import annotations

import atexit
import json
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

# The EF checkout root, derived from this file's own location
# (`<root>/eval/bridge/client.py`), so the host is found without a hard-coded
# absolute path.
EF_ROOT = Path(os.environ.get("EF_ROOT", str(Path(__file__).resolve().parents[2]))).resolve()

ARM_ENV = "EF_LHTB_ARM"

# The arms under test. `basic` mounts the real DSH Basic engine; the tiers mount
# EF with that preset's policy.
ARM_SPECS: dict[str, dict[str, str]] = {
    "basic": {"label": "basic", "engine": "basic", "mode": "legacy"},
    "economy": {"label": "economy", "engine": "ef", "mode": "economy"},
    "balanced": {"label": "balanced", "engine": "ef", "mode": "balanced"},
    "quality": {"label": "quality", "engine": "ef", "mode": "quality"},
}


class BridgeError(RuntimeError):
    """The Node host refused a request or died."""


class EpistemicFoldBridge:
    """A long-lived Node process holding one EF session for one episode."""

    def __init__(self, arm: str, bundle_root: str, domain: str, task_id: str) -> None:
        spec = ARM_SPECS.get(arm)
        if spec is None:
            raise BridgeError(f"unknown arm {arm!r}; expected one of {sorted(ARM_SPECS)}")
        self.arm = arm
        self.spec = spec
        self.domain = domain
        self.task_id = task_id
        self.telemetry: list[dict[str, Any]] = []
        self.last_telemetry: dict[str, Any] = {}
        self._closed = False

        env = dict(os.environ)
        env["EF_TAU2_BUNDLE_ROOT"] = bundle_root
        # The credential is inherited through the environment and never passed as
        # an argument, so it cannot appear in a process listing.
        #
        # The host's stderr is captured to a file rather than a pipe that is only
        # drained on crash. A live transport failure ("fetch failed") left no
        # trace otherwise, which is what made an LHTB probe undiagnosable: the
        # bridge reported the error through telemetry, but the cause was in a
        # stream nobody read.
        self._stderr_path = Path(
            os.environ.get("EF_BRIDGE_STDERR", "")
        ) if os.environ.get("EF_BRIDGE_STDERR") else None
        stderr_target: Any = subprocess.PIPE
        self._stderr_file = None
        if self._stderr_path is not None:
            self._stderr_path.parent.mkdir(parents=True, exist_ok=True)
            self._stderr_file = open(self._stderr_path, "a", encoding="utf-8")
            stderr_target = self._stderr_file
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
            stderr=stderr_target,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        atexit.register(self.close)

    def _stderr_tail(self, limit: int = 600) -> str:
        """The host's stderr, from the file when one was configured."""
        if self._stderr_path is not None:
            try:
                return self._stderr_path.read_text(encoding="utf-8", errors="replace")[-limit:]
            except OSError:
                return ""
        if self._proc.stderr is None:
            return ""
        try:
            return (self._proc.stderr.read() or "")[-limit:]
        except (OSError, ValueError):
            return ""

    def _send(self, request: dict[str, Any]) -> dict[str, Any]:
        """Write one request and read one response line."""
        if self._proc.poll() is not None:
            raise BridgeError(
                f"bridge host exited with code {self._proc.returncode}: {self._stderr_tail()}"
            )
        assert self._proc.stdin is not None and self._proc.stdout is not None
        self._proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise BridgeError(f"bridge host closed the stream: {self._stderr_tail()}")
        response = json.loads(line)
        if not response.get("ok"):
            raise BridgeError(str(response.get("error", "unknown bridge error")))
        telemetry = response.get("telemetry")
        if isinstance(telemetry, dict):
            self.last_telemetry = telemetry
            self.telemetry.append(telemetry)
        return response

    def init(self, policy: str, tools: list[dict[str, Any]]) -> None:
        """Mount the session and the engine for this episode."""
        self._send(
            {
                "op": "init",
                "arm": self.spec,
                "policy": policy,
                "tools": tools,
                "taskId": self.task_id,
                "domain": self.domain,
            }
        )

    def turn_raw(self, message: dict[str, Any]) -> dict[str, Any]:
        """
        Relay one message as a plain dict, returning the reply as a plain dict.

        The neutral form both lanes can use: tau2 wraps it with its message
        classes, Harbor speaks it directly. Use this when the protocol delivers
        exactly one message per exchange.
        """
        response = self._send({"op": "turn", "message": message})
        return response["assistant"]

    def append(self, message: dict[str, Any]) -> None:
        """
        Add a message to the history WITHOUT calling the model.

        Needed when a model emits several tool calls in one message: every result
        must be in the history before the next model call, or the model is shown
        a transcript with its own calls still unanswered.
        """
        self._send({"op": "append", "message": message})

    def step(self) -> dict[str, Any]:
        """Run one model call on the current surface and return the reply."""
        response = self._send({"op": "step"})
        return response["assistant"]

    def close(self) -> None:
        """Tell the host the episode is over, then stop it."""
        if self._closed:
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
        if self._stderr_file is not None:
            try:
                self._stderr_file.close()
            except OSError:
                pass
