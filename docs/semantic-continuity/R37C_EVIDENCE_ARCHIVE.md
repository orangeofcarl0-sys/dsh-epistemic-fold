# R37-C — Evidence Archive

## 1. Location

The R37-B raw archive is stored outside every git worktree:

```text
F:/Codex_Work_Space/DSH plugin/ef-r37c-evidence-archive/r37b-raw-evidence-20261106.tar.gz
```

It is not removed by `git clean`, `git worktree remove`, or a later checkout.

## 2. Integrity

```text
format    tar.gz
bytes     3,763,962
sha256    de6102989457fba6e5f4c43406478ce91b360f247f2dd462759f252f69de1c92
```

The same hash is recorded in `eval/r37c/out/evidence-archive.json` and, when
`R37C_ARCHIVE` is supplied, in `eval/r37c/out/evidence-inventory.json`.

## 3. Contents

```text
runs-b/                 Stage 1 raw reports, traces, workspaces, journals
runs-b2/                Stage 2 raw reports, traces, workspaces, journals
manifests-b/            Stage 1 frozen manifests
manifests-b2/           Stage 2 frozen manifests
authoritative/          the five authoritative summary JSON files
ARCHIVE_META.json       source list and provenance note
```

Authoritative summaries included:

```text
r37b-results.json
r37b-stage2-results.json
r37b-stage2-statistics.json
gate-status-r37b.json
gate-status-r37b-stage2.json
```

## 4. Secret scan

Before archiving, every text artifact in the four evidence roots was scanned
for:

```text
sk-... keys
Bearer tokens
Authorization: headers
literal apiKey/api_key assignments
```

Result:

```text
findings    0
action      archive allowed
```

No API key, Authorization header, environment-variable value, or credential was
copied into the archive. Manifests contain only the environment-variable NAMES
`R37B_BASE_URL` and `R37B_API_KEY`, never their values.

## 5. Truncated evidence

The archive preserves the R37-B trace exactly as written, including the
1,000-character turn-text cap. 113 Stage 2 rows contain capped turns. The
archive therefore preserves `truncated-evidence`; it does not reconstruct a
full response that was never stored.

`writerRaw` is stored separately and is not subject to the 1,000-character
turn cap. Writer outputs are available in full unless `writerRawTruncated` is
true.

## 6. Restore

```bash
mkdir -p /tmp/r37b-restore
tar -xzf "F:/Codex_Work_Space/DSH plugin/ef-r37c-evidence-archive/r37b-raw-evidence-20261106.tar.gz" -C /tmp/r37b-restore
sha256sum "F:/Codex_Work_Space/DSH plugin/ef-r37c-evidence-archive/r37b-raw-evidence-20261106.tar.gz"
```

The extracted tree is read-only evidence. Do not run the R37-C audit scripts
against a modified copy and call the result a reproduction.

## 7. What is not archived

- The R37-B worktree itself (only its evidence directories).
- Any provider credential.
- The local gateway's configuration.
- A reconstructed session log: R37-B did not persist one. The journal packets
  and receipts are archived, but the full `validateSemanticCommit` fold proof
  cannot be re-run without the session log. The R37-C audit therefore labels
  its journal check `journal-proof`, not `ValidatedSemanticCommit`.
