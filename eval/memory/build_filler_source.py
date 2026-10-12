"""Extract the real-text background pool for the memory corpus (design 3.2.5).

## Why the generated filler was replaced

It was 48 sentence templates over 12 topics. Measured: 2,344,000 word tokens drawn from 58
distinct words, 99.60% of a 4M-token corpus, and deleting every filler line collapsed the corpus
to 16,240 tokens -- 12.4% of the window, far below the 50%-of-window calibration target. Fold 1
therefore already overshot the target and depth 2+ had nothing to do, so the depth axis was dead
while appearing alive. Boilerplate creates LENGTH, not PRESSURE.

## What replaces it, and why this register

Real technical documentation prose. The register matters: the probed facts are technical
statements ("The retry helper uses max_attempts = 8"), so background in the SAME register cannot
be separated from them by genre alone. Background in a different register -- literary prose, or
source code -- lets a summariser treat the facts as the only real content and preserve them,
which inflates retention and is the failure this benchmark exists to detect.

## Sources, and why only these

  1. CPython standard library                      PSF-2.0
  2. site-packages whose licence is POSITIVELY identified as MIT / Apache-2.0 / BSD / ISC

Packages whose licence cannot be determined are EXCLUDED. They are the larger part of the
docstring text on this host (10.7M chars against 4.4M), and taking them would roughly double the
pool -- but an unverifiable licence is not a licence, and a benchmark corpus is not a place to be
relaxed about redistribution.

A small fraction of real source lines is included, deliberately bounded: enough for structural
variety, not enough to change the register.

## The filter is the EXISTING constraint, unchanged

filler_disjoint_from_probed forbids any probed value in filler, because a filler figure equal to a
probed one gives a disambiguation probe a second candidate. Real text is full of small integers,
so the rule was re-measured rather than assumed: 46 of the 86 probed values are below 100, yet
96.9% of stdlib characters survive, because the probed small integers do not include 0, 1 or 3 and
so x[0] and range(1) do not collide.

A second and stronger rule is applied and then ASSERTED: no vocabulary field name may appear. A
bare integer in unrelated text is noise, but a field name binds a value to a fact, and a field
name in the wrong document is a second correct answer.

## Output is vendored

The pool is written into the repository, so regeneration does not depend on this machine's Python
install. A generator that reads the ambient environment produces a different corpus on a different
host, and the artifact and its generator would then disagree.
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
POOL = HERE / "filler_source.txt"
PROVENANCE = HERE / "filler_source_provenance.json"
NOTICE = HERE / "filler_source_NOTICE.md"

KINDS = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
PERMISSIVE = {
    "MIT", "MIT License", "MIT-0", "Apache-2.0", "Apache 2.0", "Apache Software License",
    "BSD-2-Clause", "BSD-3-Clause", "BSD License", "ISC", "0BSD", "Unlicense",
    "Python-2.0", "PSF-2.0", "CC0-1.0",
}
# Structural variety only. Code is adopted in small quantity, by explicit guidance.
CODE_SHARE = 0.10


def load_vocab():
    """Return (field names, numeric probed values, categorical probed values).

    The split is load-bearing. Twenty of the 86 probed values are ordinary English words --
    "method", "title", "options", "configuration" -- because four fields are categorical
    (heading_style, preferred_term, citation_required, section_order). Requiring their absence
    from real prose is unsatisfiable, and it is also unnecessary: a bare "title" in unrelated text
    is not bound to any field, so it is not a competing answer to anything.

    What creates a competing answer is a FIELD NAME, because that is what binds a value to a fact.
    So the field-name rule stays strict and is asserted, and the value rule is narrowed to the
    NUMERIC values -- which are cheap to exclude, at 94.9% of stdlib characters surviving.

    This is a deliberate narrowing of filler_disjoint_from_probed, recorded rather than assumed.
    """
    core = json.loads((HERE / "corpus_core.json").read_text(encoding="utf-8"))
    fields, numeric, words = set(), set(), set()
    for rows in core["projects"].values():
        for r in rows:
            for k, v in r["values"].items():
                fields.add(k)
                s = str(v)
                try:
                    float(s)
                    numeric.add(s)
                except ValueError:
                    words.add(s)
    return fields, numeric, words


class Filter:
    def __init__(self):
        self.fields, self.values, self.word_values = load_vocab()
        self.field_re = [re.compile(r"\b" + re.escape(f) + r"\b", re.I) for f in sorted(self.fields)]
        # ## ONE regex, and the SAME one the assertion uses
        #
        # The first version tokenised digit runs with \b\d[\d._]*\b, which reads "1.2.3" as a
        # single token and so does not see the "2" inside it. The assertion searched \b2\b and
        # DID see it, because "." is a word boundary. The filter and the check therefore disagreed
        # about the same pool, and the check was right: the assertion fired on '2', '10', '12'.
        #
        # Longest-first alternation so "0.003" is not matched as "0" followed by junk.
        self.value_re = re.compile(
            r"\b(?:" + "|".join(re.escape(v) for v in sorted(self.values, key=len, reverse=True)) + r")\b"
        )
        self.dropped_field = 0
        self.dropped_value = 0

    def keep(self, line):
        if any(rx.search(line) for rx in self.field_re):
            self.dropped_field += 1
            return False
        if self.value_re.search(line):
            self.dropped_value += 1
            return False
        return True


def docstrings_of(src):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    out = []
    for node in ast.walk(tree):
        if isinstance(node, KINDS):
            d = ast.get_docstring(node)
            if d and len(d.strip()) > 40:
                out.append(d.strip())
    return out


def package_licences(site_packages):
    import importlib.metadata as md
    lic = {}
    for dist in md.distributions(path=[str(site_packages)]):
        try:
            name = (dist.metadata["Name"] or "").strip().lower().replace("-", "_")
            text = (dist.metadata["License"] or "").strip()
            if not text:
                cs = dist.metadata.get_all("Classifier") or []
                text = next((c.split("::")[-1].strip() for c in cs if c.startswith("License ::")), "")
            lic[name] = text
        except Exception:
            pass
    return lic


def main():
    stdlib = Path(os.environ.get("EF_MEMORY_STDLIB", sys.argv[1] if len(sys.argv) > 1 else ""))
    site_packages = Path(os.environ.get("EF_MEMORY_SITE_PACKAGES", sys.argv[2] if len(sys.argv) > 2 else ""))
    if not stdlib.is_dir() or not site_packages.is_dir():
        raise SystemExit("pass <stdlib> <site-packages>, or set EF_MEMORY_STDLIB / EF_MEMORY_SITE_PACKAGES")

    flt = Filter()
    prose = []
    code = []
    used_pkgs = {}

    # ---- 1. CPython standard library: prose, and the bounded code share
    std_files = sorted(p for p in stdlib.rglob("*.py")
                       if "__pycache__" not in p.parts and "site-packages" not in p.parts)
    for p in std_files:
        try:
            src = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel = "stdlib/" + p.relative_to(stdlib).as_posix()
        for d in docstrings_of(src):
            body = "\n".join(l for l in d.split("\n") if flt.keep(l)).strip()
            if len(body) > 40:
                prose.append((rel, body))
        keep = [l for l in src.split("\n") if l.strip() and flt.keep(l)]
        if len(keep) > 20:
            code.append((rel, "\n".join(keep)))
    used_pkgs["CPython standard library"] = "PSF-2.0"

    # ---- 2. site-packages, permissive licences only
    licences = package_licences(site_packages)
    sp_files = sorted(p for p in site_packages.rglob("*.py") if "__pycache__" not in p.parts)
    for p in sp_files:
        top = p.relative_to(site_packages).parts[0].lower().replace("-", "_")
        declared = licences.get(top, "")
        if declared not in PERMISSIVE:
            continue
        try:
            src = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        rel = "site-packages/" + p.relative_to(site_packages).as_posix()
        for d in docstrings_of(src):
            body = "\n".join(l for l in d.split("\n") if flt.keep(l)).strip()
            if len(body) > 40:
                prose.append((rel, body))
        used_pkgs[top] = declared

    # ---- 3. Assemble: prose first, code sampled to the bounded share
    prose_chars = sum(len(b) for _, b in prose)
    code_budget = int(prose_chars * CODE_SHARE / (1 - CODE_SHARE))
    taken, spent = [], 0
    for rel, body in code:
        if spent >= code_budget:
            break
        take = body[: max(0, code_budget - spent)]
        taken.append((rel, take))
        spent += len(take)

    parts, manifest = [], []
    for rel, body in prose + taken:
        parts.append("\n===== " + rel + " =====\n" + body)
        manifest.append({"source": rel, "chars": len(body)})
    pool = "".join(parts)

    # ---- 4. ASSERT the rules, rather than trusting the filter
    fields, numeric, word_values = load_vocab()
    hit_f = sorted({f for f in fields if re.search(r"\b" + re.escape(f) + r"\b", pool, re.I)})
    hit_n = sorted({v for v in numeric if re.search(r"\b" + re.escape(v) + r"\b", pool)})
    if hit_f:
        raise SystemExit("pool contains vocabulary field names: " + str(hit_f[:8]))
    if hit_n:
        raise SystemExit("pool contains numeric probed values: " + str(hit_n[:8]))
    # The categorical values ARE expected to occur; count them so the magnitude is on the record
    # rather than being an unexamined allowance.
    word_hits = {w: len(re.findall(r"\b" + re.escape(w) + r"\b", pool, re.I)) for w in sorted(word_values)}
    word_hits = {w: n for w, n in word_hits.items() if n}

    POOL.write_text(pool, encoding="utf-8")
    words = re.findall(r"[A-Za-z][A-Za-z'\-]*", pool)
    distinct = {w.lower() for w in words}
    PROVENANCE.write_text(json.dumps({
        "register": "technical documentation prose (docstrings), plus a bounded share of source",
        "code_share_target": CODE_SHARE,
        "code_share_actual": round(spent / max(1, len(pool)), 4),
        "pool_chars": len(pool),
        "pool_sha256": hashlib.sha256(pool.encode("utf-8")).hexdigest(),
        "approx_tokens_chars_over_4": len(pool) // 4,
        "word_tokens": len(words),
        "distinct_words": len(distinct),
        "type_token_ratio": round(len(distinct) / max(1, len(words)), 5),
        "prose_blocks": len(prose),
        "code_blocks": len(taken),
        "filter": {"lines_dropped_field_name": flt.dropped_field,
                   "lines_dropped_probed_value": flt.dropped_value},
        "asserted_absent": {"vocabulary_field_names": True, "numeric_probed_values": True},
        "narrowed_rule": {
            "why": "20 of 86 probed values are ordinary English words (categorical fields); their "
                   "absence from real prose is unsatisfiable and unnecessary, because an unbound "
                   "word is not a competing answer. A field NAME is what binds a value to a fact, "
                   "so that rule stays strict.",
            "categorical_values_present_in_pool": word_hits,
        },
        "packages": used_pkgs,
    }, indent=2), encoding="utf-8")

    NOTICE.write_text(
        "# filler_source.txt -- provenance and licences\n\n"
        "Derived text used as inert background in the memory-pressure corpus. It states no probed\n"
        "fact; that property is asserted by build_filler_source.py, not assumed.\n\n"
        "## Sources\n\n"
        + "".join("- " + k + " -- " + v + "\n" for k, v in sorted(used_pkgs.items()))
        + "\nPackages whose licence could not be positively identified were excluded, even though\n"
          "they are the larger part of the available text.\n",
        encoding="utf-8",
    )

    print("pool: " + format(len(pool), ",") + " chars (~" + format(len(pool)//4, ",") + " tokens)")
    print("  prose blocks " + format(len(prose), ",") + "   code blocks " + format(len(taken), ",")
          + " (share " + format(spent/max(1,len(pool)), ".3f") + ")")
    print("  word tokens " + format(len(words), ",") + "  distinct " + format(len(distinct), ",")
          + "  type/token " + format(len(distinct)/max(1,len(words)), ".4f"))
    print("  filter dropped " + format(flt.dropped_field, ",") + " field-name lines, "
          + format(flt.dropped_value, ",") + " probed-value lines")
    print("  packages " + str(len(used_pkgs)))
    print("  asserted absent: vocabulary field names, numeric probed values")
    print("  categorical word values present (unbound, by design): " + str(len(word_hits)))


if __name__ == "__main__":
    main()
