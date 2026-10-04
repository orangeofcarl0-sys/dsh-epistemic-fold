# Epistemic Fold User Guide

This guide describes the current product surface. For research history, use [README.md](README.md).

## 1. Installation

### Release tarball

Recommended for a pinned deployment:

```bash
dsh plugin --profile <name> add file:/path/to/dsh-epistemic-fold-<version>.tgz
```

The release tarball contains `lib/` and does not need a build step.

### Pinned git tag

```bash
dsh plugin --profile <name> add github:orangeofcarl0-sys/dsh-epistemic-fold#v0.1.0
```

Git dependencies may require pnpm `allowBuilds`. DSH prints the exact entry when pnpm blocks `prepare`.

### Local checkout

```bash
npm install
npm run preflight
```

Then add the checkout to the profile as a `file:` dependency.

### Bundle order

EF patches DSH's own presets in place. The profile must load the web app first:

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-epistemic-fold"
      ]
    }
  }
}
```

The generated substitution replaces the compaction backend inside `standard`, `ptc`, and `cordis`. `minimal` stays unchanged.

For the exact loader/preset/browser matrix, see [42_DEPLOYMENT_CHAIN.md](42_DEPLOYMENT_CHAIN.md).

## 2. Modes

### Economy

```text
retainRatio  = 0.16
semanticMode = none
```

Use when context/API cost matters and on-demand recall is acceptable.

Economy keeps declared/current state hot and relies more heavily on search/recall for older undeclared narrative.

### Balanced

```text
retainRatio  = 0.24
semanticMode = none
```

Use when carrying more recent verbatim history is worth a modest context premium.

The mechanism is intentional, but the project has not yet established a reliable long-horizon steadiness advantage over Economy.

### Quality

```text
retainRatio  = 0.24
semanticMode = rationale
```

Use when you deliberately prefer more semantic redundancy and accept the extra compaction-model cost.

The additional benefit is still a hypothesis; the extra cost is real.

### Legacy

EF's frozen compatibility baseline. It is useful for comparison and rollback.

### Basic

EF stands aside:

- compaction delegates to the vendored Basic backend;
- no EF projection;
- no EF Sidebar panel;
- no `/context`;
- no `context_search` / `context_recall`.

Use this when you want the native baseline without uninstalling EF.

## 3. Switching tiers

At startup:

```yaml
- name: dsh-epistemic-fold
  config:
    mode: economy
    bundleRoot: <profile persistence root>/epistemic-fold
```

During a session:

```text
/context mode economy
/context mode balanced
/context mode quality
```

The runtime command intentionally exposes only the three tiers. Select `legacy` or `basic` in configuration.

## 4. Inspecting context

### Full report

```text
/context status
```

The report includes, when available:

- current context pressure and model window;
- fold threshold and occupancy;
- estimated archived-token volume and measured archived-message count;
- currently frozen checkpoint count;
- lifetime leaf/root fold counts;
- search/recall counts;
- routed provider/model lifecycle;
- provider-reported cumulative token usage;
- estimated cost when a matching economics profile exists.

A value is always labelled by what the system knows:

- **measured** — obtained from DSH/provider state;
- **estimated** — derived from a model or heuristic;
- **unknown** — cannot be established.

Unknown is not converted to zero.

### One-line form

```text
/context line
```

Useful for logs and status bars.

### Sidebar

The browser panel reads the same status projection. It is observation-only: rendering the panel does not add content to the model prompt.

## 5. Search and recall

When DSH provides a ToolRuntime, EF registers:

### `context_search`

Use it to find relevant folded history. Search examines checkpoint content and archived messages.

A hit can include:

- checkpoint id;
- logical source range;
- match kind;
- matched message index;
- bounded verbatim excerpt;
- match count / earlier-match location.

Hits prefer newer conversation chronology while older evidence remains reachable.

### `context_recall`

Use a checkpoint reference (`cp:<id>`) to recover:

- a compact checkpoint view; or
- exact archived messages with pagination.

Exact history is recovered from the bundle store rather than reconstructed from a summary.

## 6. Leaf folds and root folds

### Leaf Fold

The normal maintenance operation. It folds a legal span after the Fold Frontier and appends a new frozen checkpoint.

This preserves a stable earlier prefix and avoids recursively rewriting old checkpoints.

### Root Fold

A larger rebase of the frozen surface. It is deliberately uncommon because rewriting an early prefix can invalidate provider cache.

The economic root policy considers recurring carry cost versus the one-time mutation cost rather than rebasing on every fold.

## 7. What the Sidebar / status numbers mean

`checkpoints now` and `folds (lifetime)` are deliberately different:

```text
40 historical folds
→ root rebase
→ 1 checkpoint currently visible
```

can correctly report:

```text
checkpoints now: 1
leaf folds:      39
root rebases:     1
```

Archived token count is an estimate; archived message count is a measured count.

Cost is omitted when no provider usage or no route price card exists.

## 8. Troubleshooting

### EF does not appear in a session

Check that:

1. the plugin is installed in the profile;
2. `dsh-epistemic-fold` loads after `@deepseek-ai/dsh-web-app`;
3. you selected `standard`, `ptc`, or `cordis`;
4. you did not configure `mode: basic`.

The substitution doctor turns a missed preset replacement into a loud error instead of silently leaving the session on Basic.

### `/context` is missing

The command is registered only when the DSH command registry exists. A compaction-only host can mount EF without the command plane.

`mode: basic` also intentionally registers no EF surface.

### Recall tools are missing

They are registered only when a ToolRuntime exists.

### Cost shows `unknown`

Two common reasons:

- no provider usage has been observed yet;
- the routed provider/model has no matching economics profile.

EF does not invent a rate.

### Sidebar is missing or duplicated

The panel supports the native right Sidebar and the optional better-sidebar path. Registration is deduplicated because better-sidebar can bridge into the native registry.

See [37](37_RC11_BROWSER_VERIFICATION.md) and [43](43_RC17_SIDEBAR_ENTRY_DEDUPE.md) for the browser verification history.

## 9. Upgrading DSH

Preset substitution is version-sensitive. After a DSH upgrade:

```bash
node scripts/generate-presets.mjs
```

The project also runs a pinned-baseline CI lane and a current-master compatibility probe.

The vendored Basic backend is guarded for drift; do not edit it as ordinary plugin code.

## 10. Safety / current limitations

- Balanced and Quality are product operating points, not proven rankings.
- Route-level realized cost superiority remains provider/cache dependent.
- EF does not automatically turn every user statement into authoritative structured state.
- General `ef/anchor` durable persistence depends on DSH host capability and must not be treated as a universal persistence API.
- External benchmarks are partially integrated; they do not yet establish a universal tier ordering.
