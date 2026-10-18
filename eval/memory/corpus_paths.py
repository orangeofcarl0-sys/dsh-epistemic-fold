"""Where a tier's corpus lives, so every tier is committed and runs without generating.

## The problem this removes

The corpus was a SINGLE artifact set at eval/memory/. documents.json is derived from
EF_MEMORY_WINDOW, so two tiers could not coexist: running 475K meant regenerating over 131K,
and that regeneration dirties tracked files. A user who only wanted to RUN the bench had to run
the generator first -- the slow, failure-prone part -- and a half-finished generation left the
tree inconsistent with HEAD.

## What is actually per-tier, measured

131K against 252K, sha256 per artifact:

    documents.json          DIFFERENT   2,289,887 -> 4,482,830 bytes
    generation_report.json  DIFFERENT   records the window
    probes.json             IDENTICAL
    answer_key.json         IDENTICAL
    public_probes.json      IDENTICAL
    orderings.json          IDENTICAL
    corpus_core.json        IDENTICAL
    errata.json             IDENTICAL

So exactly two files are per-tier and only one of them is large. The six shared artifacts stay
at eval/memory/ and are NOT duplicated per tier; duplicating them would be 3.5x the bytes for
content that is byte-identical.

## Layout

    eval/memory/corpora/<tier>/documents.json
    eval/memory/corpora/<tier>/generation_report.json

<tier> labels the window: 131k, 252k, 475k, 1m. Generation is retained -- it is the deeper
test, and the only way to build a tier that is not committed -- but it is no longer on the path
to running a committed one.
"""
from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The tiers that are committed. A window not listed here is still buildable; it is just not
# one this repository ships, and it resolves to a w<window> directory.
TIERS = {131072: "131k", 258048: "252k", 475136: "475k", 1048576: "1m"}

# The only two artifacts that differ between tiers. Everything else is shared.
PER_TIER = ("documents.json", "generation_report.json")


def window() -> int:
    """The window under test, from the same variable run-memory.sh sets."""
    return int(os.environ.get("EF_MEMORY_WINDOW", "131072"))


def tier_label(win: int | None = None) -> str:
    return TIERS.get(window() if win is None else win, "w" + str(window() if win is None else win))


def tier_dir(win: int | None = None) -> Path:
    return HERE / "corpora" / tier_label(win)


def corpus_file(name: str, win: int | None = None) -> Path:
    """The path of one corpus artifact: per-tier if it differs, shared otherwise."""
    if name in PER_TIER:
        return tier_dir(win) / name
    return HERE / name


def require_tier_corpus(win: int | None = None) -> Path:
    """The tier directory, or a refusal that says exactly what to do about it.

    A missing corpus must not fall back to another tier: the whole point of the window is that
    the corpus was sized for it, and silently reading a 131K corpus at 1M would report a
    measurement of nothing.
    """
    d = tier_dir(win)
    if (d / "documents.json").is_file():
        return d
    known = ", ".join(sorted(TIERS.values()))
    raise SystemExit(
        "no committed corpus for window " + format(window() if win is None else win, ",")
        + " at " + str(d) + ". Committed tiers: " + known + ". To build one: "
        + "EF_MEMORY_WINDOW=<window> python eval/memory/build_corpus.py"
    )
