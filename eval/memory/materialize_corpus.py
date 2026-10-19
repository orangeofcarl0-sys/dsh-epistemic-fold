#!/usr/bin/env python3
"""Materialise a tier's corpus as ordinary files, for the REGENERABLE arm.

The README states the control is REGENERABLE memory: the information must be freely and
repeatedly reachable. That requires the corpus to exist as DOCUMENTS the model can open, not as
a JSON data file it cannot address.

Measured 2026-10-19: pointing the arm at the corpus DIRECTORY gave the model a path it could not
use. Two of five cells scored zero, and their own replies name the cause:

    "the path I was given resolves to a directory (.../corpora/131k) rather than a file"
    "my file reads returned 'not found' for every plausible filename"

So each document is written to its own path and an INDEX.md lists them. The index is a table of
contents, not a summary: it gives names and paths and no fact from any document, so the model
still has to open what it needs. That reading cost is part of what this arm measures -- it is why
regenerable memory is not automatically a ceiling.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import corpus_paths

HERE = Path(__file__).resolve().parent
ENV_ROOT = HERE / "regen-env"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", required=True, help="window tokens, e.g. 258048")
    ap.add_argument("--out", default=None, help="override the output directory")
    args = ap.parse_args()

    win = int(args.tier)
    tier = corpus_paths.tier_label(win)
    out = Path(args.out) if args.out else (ENV_ROOT / tier)
    docs = json.loads(corpus_paths.corpus_file("documents.json", win).read_text(encoding="utf-8"))
    key = json.loads((HERE / "answer_key.json").read_text(encoding="utf-8"))

    written = 0
    index_rows: list[tuple[str, str, str, str]] = []
    for project in sorted(docs):
        for d in docs[project]:
            rel = Path(project) / (d["name"] if d["name"].endswith(".md") else d["name"] + ".md")
            target = out / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(d["text"], encoding="utf-8", newline="\n")
            index_rows.append((project, d.get("type", ""), d["name"], rel.as_posix()))
            written += 1

    errata_rows = []
    for e in key.get("errata", []):
        rel = Path(e["project"]) / "ERRATA.md"
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(e["text"], encoding="utf-8", newline="\n")
        errata_rows.append((e["project"], rel.as_posix()))
        written += 1

    lines = [
        f"# Corpus index -- {tier} tier",
        "",
        f"{len(index_rows)} documents across {len(docs)} projects, plus {len(errata_rows)} errata",
        "files. All paths are relative to this directory.",
        "",
        "Read whatever you need. A document is opened by its path below.",
        "",
        "| project | type | document | path |",
        "| --- | --- | --- | --- |",
    ]
    for project, typ, name, rel in index_rows:
        lines.append(f"| {project} | {typ} | {name} | {rel} |")
    if errata_rows:
        lines += ["", "## Errata", "", "Each errata file corrects a value stated earlier in its project.", "",
                  "| project | path |", "| --- | --- |"]
        for project, rel in errata_rows:
            lines.append(f"| {project} | {rel} |")
    (out / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

    print(f"{tier}: wrote {written} files to {out}")
    print(f"  index: {out / 'INDEX.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())