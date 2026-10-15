# 99 — Upgraded as authorized; hand-replication still 403; plugin itself UNVERIFIED

Status: **FREE TIER STILL NOT REACHABLE FROM THIS LANE. CONTEXT LENGTH NOT MEASURED.**
2026-10-16. Parent `ae7a9af`.

## A. The upgrade was done

```
@deepseek-ai/dsh        0.2.1-alpha.2  ->  0.2.1-alpha.3     (npm -g, verified by `dsh --version`)
dsh-opencode-free       0.3.3          ->  0.3.4            (profile `web`, verified by plugin list)
```

alpha.3 and not alpha.4, because v0.3.4 pins DSH `0.2.1-alpha.3` exactly. Both confirmed after the
fact, not assumed.

## B. The v0.3.4 protocol, extracted

```
BASE_URL   https://opencode.ai/inference/v1          <- the migrated endpoint, now present
channels   ZEN_CHANNELS = ['openai-completions', 'openai-responses']
tools      enforceAnonymousTools() re-adds `read`/`bash` at the PAYLOAD boundary
           completions: {type:'function', function:{...}}   responses: {type:'function', ...tool}
gate       declarations need REAL schemas (admissionTool), not stubs
identity   Authorization: Bearer public, OpenCode CLI User-Agent, x-opencode-* headers
session    sha256(per-process SALT + 'opencode-zen-free:' + id) -> ses_ + 12 hex + 14 base62
```

## C. Three request shapes, three 403s

```
A  /inference/v1/chat/completions   messages + nested tools   403 FreeTierError
B  /inference/v1/responses          input    + flat tools     403 FreeTierError
C  /zen/v1/responses                input    + flat tools     403 FreeTierError
```

So the admission rule is **not fully captured by the protocol the plugin documents**. That is not a
surprise the plugin hides -- its own notes say:

> The minimum upstream admission rules are **not fully verified** and may change.
> ... upstream changes may break it without notice.

## D. What I did NOT establish, and will not claim

**I never ran the plugin itself.** `dsh-opencode-free` works by wrapping DSH's process-wide HTTP
entry points, so testing it means starting a DSH session with the plugin loaded and selecting the
model -- not reproducing its protocol by hand. **My replication failing says nothing about whether the
plugin works; it says my replication is incomplete.**

```
DSH upgraded to the required version            YES
plugin v0.3.4 installed                        YES
protocol extracted                             YES
hand-replication of admission                  FAILED -- 403 on all three shapes
PLUGIN ITSELF VERIFIED WORKING                 NO -- never executed
free model reachable from the LHTB lane        NO
real context length                            NOT MEASURED
```

## E. Context length

**Not measured, and still not obtainable from the catalogue**: every Zen entry carries only
`id`, `object`, `created`, `owned_by`. Without one successful request there is nothing to ladder
prompt sizes against, and **a number here would be invented**. `not measured` is not
`measured, no problem`.

## F. The decisive test, unrun

Start DSH with the `web` profile (plugin loaded), select **OpenCode Zen Free / deepseek-v4.1-flash-free**,
and send one trivial prompt. If it answers, the plugin works and the context ladder can then be run
against that path; if it 403s too, then the free tier is closed regardless of client and the
question is settled the other way. **Either answer is worth more than another hand-rolled header set.**
