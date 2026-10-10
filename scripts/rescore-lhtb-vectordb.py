#!/usr/bin/env python3
"""Re-score archived LHTB vector-db cells with the FIXED distance counter.

## Why this is possible at all

The distance-computation counter had three defects, all of them on the MEASURING
side: too few numpy entry points were intercepted, two signals fired for one
distance, and patching np.matmul broke the ufunc identity check inside
__array_ufunc__. None of them is a property of the agent, so correcting them is a
RE-SCORE rather than a re-run: no model calls, no provider quota, no agent hours.

The prerequisite is that the code which was graded is in the archive. It is, for
vector-db -- artifacts/ carries the workspace. (It is NOT for unknown-config, whose
archive kept only the HMAC actions log and not the engines it graded. That is fixed
for future runs by task.toml; it cannot be fixed for past ones.)

## What it does, per cell

  1. start a container from the task image
  2. copy the archived workspace to /app/workspace and the task tests to /tests
  3. start the server with the counter installed, exactly as tests/test.sh does
  4. run the real verifier against the hidden dataset (seed 7777, deterministic)
  5. read /logs/verifier/reward.txt and /app/output/test_results.json

Recall is deterministic given the index, so a re-score reproduces the original
CORRECTNESS. The distance ratio is what is new: it was MISSING before, because the
implementations reach a distance through scipy.spatial.distance.cdist or through
numpy creators the old counter did not patch.

## Resumable

Results append to a JSON file and a cell already present is skipped, so an
interrupted run continues rather than starting over. Each cell is slow -- the
verifier inserts 100K vectors -- so this is written to survive being killed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

IMAGE = "zli12321/lhtb-vector-db-iterative-build:20260615"
CONTAINER = "ef-rescore"
COUNT_PATH = "/tmp/ef-distance-count.json"
# The verifier generates 100K vectors and inserts them; a slow implementation can
# take most of this. The task's own verifier timeout is 1800s, and this is the
# ceiling for the whole cell rather than a claim about how long it should take.
CELL_TIMEOUT_SEC = 3600


def docker(*args: str, timeout: int = 600, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True,
                          timeout=timeout, check=check)


def cell_dirs(jobs: Path) -> list[Path]:
    found: list[Path] = []
    for job in sorted(jobs.iterdir()):
        if not job.is_dir() or not job.name.startswith("lhtb-ef-"):
            continue
        for cell in sorted(job.iterdir()):
            if not cell.is_dir() or not cell.name.startswith("vector-db"):
                continue
            artifacts = cell / "artifacts"
            if not artifacts.is_dir():
                continue
            # An artifact directory can be EMPTY -- oracle runs produce one -- and
            # an empty directory is not a re-scorable cell. Requiring the server is
            # the cheapest honest test of "there is code here".
            if not any(p.suffix == ".py" for p in artifacts.iterdir()):
                continue
            found.append(cell)
    return found


def rescore(cell: Path, task_tests: Path) -> dict:
    name = f"{cell.parent.name}/{cell.name}"
    docker("rm", "-f", CONTAINER)
    started = time.time()
    try:
        run = docker("run", "-d", "--name", CONTAINER, "--entrypoint", "sleep",
                     IMAGE, str(CELL_TIMEOUT_SEC + 600), timeout=300)
        if run.returncode != 0:
            return {"cell": name, "error": f"container start: {run.stderr.strip()[:200]}"}
        time.sleep(3)
        docker("exec", CONTAINER, "mkdir", "-p", "/app/workspace", "/tests", "/logs/verifier")
        # The archived workspace IS the graded code; the task tests ARE the grader.
        for source, target in ((cell / "artifacts", "/app/workspace"), (task_tests, "/tests")):
            cp = docker("cp", f"{source}{os.sep}.", f"{CONTAINER}:{target}", timeout=600)
            if cp.returncode != 0:
                return {"cell": name, "error": f"copy {source}: {cp.stderr.strip()[:200]}"}
        # Exactly what tests/test.sh does before starting the server.
        launch = (f"export EF_DISTANCE_COUNT_PATH={COUNT_PATH}; "
                  "export PYTHONPATH=/tests/efcount; "
                  f"rm -f {COUNT_PATH}; "
                  "cd /app/workspace && python server.py > /tmp/srv.log 2>&1")
        docker("exec", "-d", CONTAINER, "bash", "-c", launch)
        time.sleep(10)
        verify = docker("exec", "-e", f"EF_DISTANCE_COUNT_PATH={COUNT_PATH}", CONTAINER,
                        "bash", "-c",
                        "cd /app && python3 /tests/test_outputs.py > /tmp/verifier.log 2>&1; "
                        "echo EXIT=$? >> /tmp/verifier.log",
                        timeout=CELL_TIMEOUT_SEC)
        reward = docker("exec", CONTAINER, "cat", "/logs/verifier/reward.txt")
        results = docker("exec", CONTAINER, "cat", "/app/output/test_results.json")
        log = docker("exec", CONTAINER, "tail", "-40", "/tmp/verifier.log")
        record: dict = {"cell": name, "seconds": round(time.time() - started, 1)}
        try:
            record["reward"] = float(reward.stdout.strip())
        except ValueError:
            record["reward"] = None
            record["error"] = "no reward file"
        try:
            payload = json.loads(results.stdout)
            record["reward_kind"] = payload.get("reward_kind")
            record["official_reward"] = payload.get("official_reward")
            record["metrics"] = payload.get("metrics")
        except Exception:
            pass
        record["verifier_tail"] = log.stdout.strip()[-1200:]
        record["verify_exit"] = verify.returncode
        return record
    except subprocess.TimeoutExpired:
        return {"cell": name, "error": "timeout", "seconds": round(time.time() - started, 1)}
    except Exception as error:  # noqa: BLE001 - a bad cell must not stop the sweep
        return {"cell": name, "error": f"{type(error).__name__}: {error}"}
    finally:
        docker("rm", "-f", CONTAINER)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    # ## LHTB_ROOT is REQUIRED, and the first version defaulted it to a path
    #
    # This file shipped with the author's checkout baked in as the fallback, which
    # is a path that resolves on exactly one machine -- and tests/release-hygiene
    # caught it, correctly. A default nobody else can use is not a default; the
    # environment variable is the whole interface, as the sibling runner scripts
    # already do it.
    root = os.environ.get("LHTB_ROOT")
    if not root:
        parser.error("set LHTB_ROOT to the LHTB checkout (the directory holding jobs/ and tasks/)")
    parser.add_argument("--jobs", type=Path,
                        default=Path(root) / "jobs")
    parser.add_argument("--task", type=Path,
                        default=Path(root) / "tasks" / "vector-db-iterative-build")
    parser.add_argument("--out", type=Path, default=Path("ef-rescore-vectordb.json"))
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    task_tests = args.task / "tests"
    if not task_tests.is_dir():
        print(f"no task tests at {task_tests}", file=sys.stderr)
        return 2

    done: dict[str, dict] = {}
    if args.out.exists():
        try:
            done = {row["cell"]: row for row in json.loads(args.out.read_text(encoding="utf-8"))}
        except Exception:
            done = {}

    cells = cell_dirs(args.jobs)
    todo = [c for c in cells if f"{c.parent.name}/{c.name}" not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(cells)} archived cells, {len(done)} already scored, {len(todo)} to do")

    rows = list(done.values())
    for index, cell in enumerate(todo, 1):
        print(f"[{index}/{len(todo)}] {cell.parent.name}/{cell.name}", flush=True)
        record = rescore(cell, task_tests)
        rows.append(record)
        args.out.write_text(json.dumps(rows, indent=2), encoding="utf-8")
        metrics = record.get("metrics") or {}
        print(f"    reward={record.get('reward')} ratio={metrics.get('distance_ratio')}"
              f" recall={metrics.get('recall')} {record.get('error', '')}", flush=True)

    scored = [r for r in rows if isinstance(r.get("metrics"), dict)
              and r["metrics"].get("distance_ratio") is not None]
    print(f"\n{len(rows)} rows, {len(scored)} with a real distance ratio")
    return 0


if __name__ == "__main__":
    sys.exit(main())
