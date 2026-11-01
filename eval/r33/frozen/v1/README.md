# R33 dataset v1 (preserved)

These are the R33 artifacts exactly as published. The case bytes for v1 are
preserved in Git at commit `ad3020df0e22587f78490c19550fe6986f55af3f`; this
directory keeps the manifest and reports reachable without a checkout.

The current `eval/r33/cases/` tree is dataset **v2**. The v1 -> v2 changes are:

- `checker.expectedChecks` added, so the harness can reject missing, duplicate,
  or invented checks;
- `requiresTests` added, so skipping the requested visible test run is a
  separate process violation;
- three gold facts now cite their authoritative message in `sourceRefs` and
  their corroborating message in `corroboratingRefs` (the quote must occur in
  every authoritative citation);
- the scorer moved from v1 (coordinate fallback) to v2 (exact claim + source
  support). Old and new numbers are compared in `R34_EVALUATOR_AUDIT.md`.

No transcript, task, gold statement, action, or hidden assertion was changed.
