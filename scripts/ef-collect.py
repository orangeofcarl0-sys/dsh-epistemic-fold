#!/usr/bin/env python3
"""
Collect the LHTB transcripts and check the invariants they claim to satisfy.

## Why this is a tracked script

It existed only as an untracked file on one machine, and the Phase 7 write-up
cited it as the tool that performs the invariant check — so the check the handoff
tells the next operator to run was not in the repository. An invariant that can
only be verified by a script nobody can read is not verified.

## The defect it is written against

Pre-RC23 archives carry no `emergencies`, `bundleWrites`, `bundlesPresent`,
`pendingIntents`, `pressureRegime` or `foldFailures` at all. Reading a missing
field as `0` would make every invariant pass vacuously — which is the old
`roots=0` mistake exactly: a number that could not mean what it claimed, read as
if it did. So a missing field is reported as `MISSING` and the invariants that
depend on it are SKIPPED and counted as unverified, never as passing.

## What it checks

For every `ef-transcript.json` under the given roots:

  I1  bundleWrites >= folds + roots + emergencies     (no surface loss)
  I2  pendingIntents == 0                             (producer has a consumer)
  I3  basic arm => bundleWrites == 0 and bundlesPresent == 0
  R1  foldFailures is REPORTED (not an invariant — a reading)

Usage:
    python scripts/ef-collect.py <dir> [<dir> ...]
    python scripts/ef-collect.py --json <dir> ...
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Fields whose absence must never be read as zero.
COUNTERS = (
    "folds",
    "roots",
    "emergencies",
    "bundleWrites",
    "pendingIntents",
    "compactionFailures",
)
OPTIONAL = ("bundlesPresent", "pressureRegime", "lastCompactionError", "compactionFailureKinds")


def find_transcripts(roots: list[Path]) -> list[Path]:
    """Every transcript under each root, in a stable order."""
    found: list[Path] = []
    for root in roots:
        if root.is_file():
            found.append(root)
            continue
        found.extend(sorted(root.rglob("ef-transcript.json")))
    return found


def cell(path: Path) -> dict[str, Any]:
    """One transcript as a row: its identity, its telemetry, its verdicts."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return {"path": str(path), "error": f"unreadable: {error}", "checks": {}, "skipped": []}

    schema = payload.get("schema")
    telemetry = payload.get("telemetry") or {}
    provenance = payload.get("provenance") or {}
    arm = payload.get("arm")

    row: dict[str, Any] = {
        "path": str(path),
        "schema": schema,
        "arm": arm,
        "revision": provenance.get("revision"),
        "telemetry": telemetry,
        "checks": {},
        "skipped": [],
    }

    def number(field: str) -> int | None:
        value = telemetry.get(field)
        return value if isinstance(value, int) else None

    def missing(field: str) -> bool:
        return not isinstance(telemetry.get(field), int)

    # --- I1: no surface replacement without an archive -----------------------
    parts = [number(f) for f in ("folds", "roots", "emergencies")]
    if any(p is None for p in parts) or missing("bundleWrites"):
        row["skipped"].append("I1 (bundleWrites/folds/roots/emergencies absent)")
    else:
        expected = sum(p for p in parts if p is not None)
        writes = number("bundleWrites")
        row["checks"]["I1"] = {
            "pass": writes >= expected,
            "detail": f"bundleWrites {writes} >= folds+roots+emergencies {expected}",
        }

    # --- I2: a producer must have a consumer ---------------------------------
    if missing("pendingIntents"):
        row["skipped"].append("I2 (pendingIntents absent)")
    else:
        pending = number("pendingIntents")
        row["checks"]["I2"] = {
            "pass": pending == 0,
            "detail": f"pendingIntents {pending}",
        }

    # --- I3: a basic arm has no bundle store ---------------------------------
    if arm == "basic":
        if missing("bundleWrites") or not isinstance(telemetry.get("bundlesPresent"), int):
            row["skipped"].append("I3 (bundleWrites/bundlesPresent absent)")
        else:
            writes = number("bundleWrites")
            present = telemetry["bundlesPresent"]
            row["checks"]["I3"] = {
                "pass": writes == 0 and present == 0,
                "detail": f"basic arm: bundleWrites {writes}, bundlesPresent {present}",
            }

    # --- R1: a READING, not an invariant -------------------------------------
    #
    # Read with its KIND breakdown, because the count alone cannot be attributed.
    # It used to be called foldFailures and to keep only the LAST message, which
    # merged a summarization budget error on one cell with a provider HTTP 500 on
    # another into a single number that meant two different things. A missing
    # breakdown is reported as MISSING rather than defaulted, for the same reason
    # a missing counter is: an absent field is not a zero.
    failures = number("compactionFailures")
    legacy = False
    if failures is None:
        # The field was called foldFailures before the rename and kept only the
        # last message. Read it rather than dropping a real measurement, but mark
        # it: its KIND breakdown does not exist, so it cannot be attributed, and
        # that is the whole reason the rename happened.
        failures = number("foldFailures")
        legacy = failures is not None
    row["compactionFailures"] = "MISSING" if failures is None else failures
    row["compactionFailuresLegacy"] = legacy
    kinds = telemetry.get("compactionFailureKinds")
    row["compactionFailureKinds"] = kinds if isinstance(kinds, dict) else "MISSING"
    row["lastCompactionError"] = telemetry.get(
        "lastCompactionError", telemetry.get("lastFoldError", "MISSING")
    )

    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("roots", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true", help="emit rows as JSON")
    args = parser.parse_args()

    paths = find_transcripts(args.roots)
    if not paths:
        print(f"no ef-transcript.json under: {', '.join(str(r) for r in args.roots)}", file=sys.stderr)
        return 2

    rows = [cell(p) for p in paths]
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0

    failed = 0
    skipped_total = 0
    for row in rows:
        print(f"\n=== {row['path']}")
        if "error" in row:
            print(f"  ERROR: {row['error']}")
            failed += 1
            continue
        print(f"  arm={row['arm']} revision={row['revision']} schema={row['schema']}")
        for name, check in row["checks"].items():
            mark = "PASS" if check["pass"] else "FAIL"
            if not check["pass"]:
                failed += 1
            print(f"  {mark} {name}: {check['detail']}")
        for name in row["skipped"]:
            skipped_total += 1
            print(f"  SKIP {name} — a missing field is not a passing zero")
        if row.get("compactionFailures") not in (0, "MISSING"):
            legacy = (
                " (read from the pre-rename foldFailures: NO kind breakdown)"
                if row.get("compactionFailuresLegacy") else ""
            )
            print(
                f"  READ compactionFailures={row['compactionFailures']}"
                f" kinds={row.get('compactionFailureKinds')}{legacy}"
                f" lastCompactionError={row.get('lastCompactionError')!r}"
            )

    print(f"\n{len(rows)} cell(s): {failed} failed, {skipped_total} unverified check(s)")
    if skipped_total:
        print("An unverified check is NOT a pass. Re-run with a current harness to verify it.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
