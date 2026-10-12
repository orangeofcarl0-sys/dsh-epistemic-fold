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
import queue
import subprocess
import threading
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

    # A bridge call that has not answered in this long is hung, not slow. Set well
    # above the host's own step timeout (EF_TAU2_STEP_TIMEOUT_MS, default 900s) so a
    # host that IS enforcing its deadline still gets to report the failure itself.
    _READ_TIMEOUT_SEC = float(os.environ.get("EF_BRIDGE_READ_TIMEOUT_SEC", "1200"))

    def __init__(self, arm: str, bundle_root: str, domain: str, task_id: str) -> None:
        self._read_timeout_sec = self._READ_TIMEOUT_SEC
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
        self._start_reader()

    def _start_reader(self) -> None:
        """Read the host's stdout on a thread, so a read can be BOUNDED.

        `readline()` on the pipe has no timeout, and that is not a detail: when the
        provider accepts the connection and then never answers, the host blocks
        inside the model call, this end blocks inside `readline()`, and nothing in
        the system can notice. Measured on a live wave: eight cells frozen for more
        than thirty minutes with their host processes alive and idle, no failure
        counted, and no termination reason -- the wall-clock simply drained.

        A thread turning the pipe into a queue is what makes the wait observable, so
        the hang becomes a recorded, retryable provider failure like any other.
        """
        self._lines: "queue.Queue[Optional[str]]" = queue.Queue()

        def pump() -> None:
            assert self._proc.stdout is not None
            try:
                for line in self._proc.stdout:
                    self._lines.put(line)
            except (OSError, ValueError):
                pass
            # EOF, so a reader that is waiting learns the host is gone rather than
            # waiting for a line that can never arrive.
            self._lines.put(None)

        self._reader = threading.Thread(target=pump, name="ef-bridge-stdout", daemon=True)
        self._reader.start()

    def _readline(self, timeout: float) -> Optional[str]:
        """One response line, or None on EOF. Raises `queue.Empty` on timeout."""
        return self._lines.get(timeout=timeout)

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
        try:
            line = self._readline(self._read_timeout_sec)
        except queue.Empty:
            # A host that does not answer is infrastructure, exactly like a 429: the
            # model never replied. It is returned in the SAME shape as a provider
            # failure so the agent's existing recovery -- backoff, the outage ceiling,
            # and the wasted-attempt bound -- stays in charge, instead of this end
            # blocking until the container is killed with nothing recorded.
            return {
                "ok": True,
                "error": (
                    f"bridge host did not answer within {self._read_timeout_sec}s "
                    f"({request.get('op', 'unknown')}); the provider call is hung"
                ),
            }
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

    def step(self, max_tokens: Optional[int] = None) -> dict[str, Any]:
        """
        Run one model call on the current surface and return the reply.

        ## Why the caller may raise the budget

        The reply budget caps the model's REASONING and its CONTENT together, so a
        budget sized for a non-reasoning model can be spent before the answer
        starts: the reply then arrives EMPTY and finishes `max-tokens`. That is a
        truncation, not the model declining to act, and a nudge cannot recover from
        it — the recovery is a bigger budget, which is what this argument lets the
        agent ask for without restarting the episode.

        @param max_tokens - budget for THIS call; omitted means the host default.
        @returns the assistant reply as a plain dict.
        """
        request: dict[str, Any] = {"op": "step"}
        if max_tokens is not None:
            request["maxTokens"] = int(max_tokens)
        response = self._send(request)
        return response["assistant"]

    def set_compaction(self, enabled: bool) -> bool:
        """
        Turn the automatic fold on or off, and return the state the host reports.

        ## Why the probe turn needs this

        The probe measures a STATE, so it must not change one. A fold landing before the probes
        would measure the state after a compression the caller did not ask for (docs/62 section
        5.4). It is also what makes the injection arms sound: injecting a document adds tokens,
        and tokens can trigger a fold, which would compress the very document just injected.

        The host skips the fold rather than faking it, so `folds` and `foldLineage` keep
        describing what the engine actually did.

        @param enabled - False to suppress the automatic fold.
        @returns the state the host reports, which is not assumed to be the one requested.
        """
        response = self._send({"op": "compaction", "enabled": bool(enabled)})
        return bool(response.get("compactionEnabled"))

    def compact(self) -> bool:
        """
        Ask the engine to fold once, and report whether it committed.

        ## Why the return value is a bool and not None

        `compactIfNeeded` legitimately DECLINES: there may be no pressure, or no
        safe range to compact. A driver that counted its own calls as depth would
        then record a depth the engine never reached, and every downstream figure —
        exposure, the retention curve, the matched-size comparison — would be
        computed against a number that describes the caller rather than the engine.

        So the caller counts commits, not calls: loop until `committed` is true
        the requested number of times, with an attempt ceiling so a corpus that
        cannot fold does not spin.

        @returns True when a fold committed, False when the engine declined.
        """
        response = self._send({"op": "compact"})
        return bool(response.get("committed"))

    def call_tool(self, name: str, arguments: dict[str, Any], call_id: str) -> str:
        """
        Execute one EF tool call against the host's ToolRuntime and return its text.

        ## Why the bridge owns this

        `context_search` and `context_recall` read the EF bundle store, which
        lives in the Node process — the Python side cannot answer them. So the
        call is relayed and the host dispatches it against the same ToolRuntime a
        real DSH agent loop would use, which keeps the benchmark's tool path
        identical to production instead of reimplementing the search here.

        The result is returned as TEXT because that is what a tool message
        carries on the wire, and the model must see the same rendering it would
        in production.

        @param name - the tool name the model called.
        @param arguments - parsed arguments.
        @param call_id - the originating call id, echoed back for correlation.
        @returns the tool's rendered output, or a JSON error object.
        """
        response = self._send(
            {"op": "tool", "name": name, "arguments": arguments, "callId": call_id}
        )
        return str(response.get("content", ""))

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
