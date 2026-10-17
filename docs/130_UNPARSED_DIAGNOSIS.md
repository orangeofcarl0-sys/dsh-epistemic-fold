# 130 — Why the 252K memory run measured nothing

Retitled from "unparsed diagnosis" to what the evidence actually shows. Status: **two independent
fatal defects, both reproduced; the parser was never exercised; one suspected defect (the
disambiguation 0/80 in `last_score.json`) is REFUTED as a bench finding.**

2026-10-17. Repo revision `c9dc2e5` + dirty tree (`eval/memory/documents.json`,
`generation_report.json` modified; `result_{A,B,C,N}_quality_logical.json` untracked). Artifacts
read: the four result files (11:43:28-11:45:18 local), `ef-phase7-logs/mem252k-*.log`,
`ef-phase7-logs/memory-bridge-stderr.log`, `eval/memory/run_cell.py`, `score_probes.py`,
`eval/live/openai-adapter.ts`, `eval/tau2/bridge-host.ts`. Four live requests were made against
`/zen/go/v1` with `cat-jam-free` (the model under test) to obtain the provider's verbatim errors.
No file in `eval/memory/` was modified.

---

## The answer in one line

**No arm ever received the questions, and every request after the first tool call was rejected
HTTP 400 — so `unparsed 204` is not a parser result at all: the parser was handed no input.**

---

## Finding A (primary, and independent of the provider): the probe turn is rendered but NEVER sent

`run_cell.py:384-400`, the whole probe loop:

    396:        turn = score_probes.render_probe_turn(batch_public)
    397:        turn_chars += len(turn)
    398:        reply, failures = step_with_retry(bridge)

`turn` is used for exactly one thing — `len(turn)` — and is then discarded. There is **no
`bridge.append(...)` of the rendered turn anywhere in the file**: every append is a document or an
errata entry (`:254`, `:328`, `:365`, `:391`, `:393`), and `bridge.step()` sends only
`{"op":"step"}` with no message (`eval/bridge/ef_bridge_client.py:308-312`). The module docstring
(`:12`) says the design is `step(probe turn) phase 2, ONE turn` — the step happens, the turn does
not.

**Proof that the questions never arrived — arm N.** Arm N ingests nothing and injects nothing, so its
session holds only `SYSTEM_PUSH` (`run_cell.py:38-41`). Its recorded reply is the first batch's
reply, verbatim (`result_N_quality_logical.json`, field `reply_head`):

    "Ready. Please send the documents; I'll read them as they arrive and answer after the last one."

That is a reply to the SYSTEM PROMPT. It is only possible if the probe turn was not in the session.
Arm N also records `probe_provider_failures: 0` — **20 real, successful model calls, and not one of
them was asked a question.** So 204/204 unparsed would occur even on a perfectly healthy route. The
parser is downstream of this and cannot be blamed.

---

## Finding B: the malformed tool history, and why the adapter's repair does not work

`ef-phase7-logs/memory-bridge-stderr.log` holds **37** occurrences of our own adapter's warning
(lines 61-99; 35 of them "2 unanswered tool_call(s) filled", 2 of them "1"):

    [openai-adapter] repaired an invalid tool shape: 2 unanswered tool_call(s) filled, 0 orphan
    tool result(s) dropped. The provider rejects this shape with HTTP 400, and one bad history
    poisons every later request in the episode.

The repair is `eval/live/openai-adapter.ts:440-502`, and it runs at the TOP of `stream()` —
**before the body is built at `:508`, so it does run on the memory bench's requests.** What it does:

    462-467  calledIds  <- every tool_calls[].id with a NON-EMPTY string id
    469-472  answeredIds <- every tool message's tool_call_id
    473-481  orphan tool results (id never called) are REMOVED
    483-491  for each called id with no answer: messages.push({role:'tool', tool_call_id:id, ...})
    496-501  the warning above

**Verbatim provider errors, measured.** Four requests to `https://opencode.ai/zen/go/v1/chat/completions`,
model `cat-jam-free`, `stream:false`, one `read` tool declared:

| # | shape sent | result |
|---|---|---|
| R1 | assistant tool_call `call_abc123` **immediately followed by** its tool result | **HTTP 200** |
| R2 | same call, **no** result | **HTTP 400** `{"error":{"param":"messages[2].tool_calls","type":"invalid_request_error","message":"Upstream request failed: [invalid_value] messages[2] has tool calls with no result before messages[3]: 'call_abc123'. An assistant message with 'tool_calls' must be followed by a tool message answering each call."}}` |
| R3 | tool_call with **empty id**, no result | **HTTP 400** `{"error":{"param":"messages[2].tool_calls[0].id","type":"invalid_request_error","message":"Upstream request failed: [invalid_value] Invalid value for 'messages[2].tool_calls[0].id': minimum string length is 1."}}` |
| R4 | **the adapter's repaired shape**: same call as R2, placeholder result appended **last** | **HTTP 400 — the identical error as R2** |

R4 is the finding. The adapter's comment at `:450` asserts "**Order does not matter** and the CONTENT
does not matter". On this route order **does** matter: the provider requires the answering tool message
*before the next message*, and `messages.push(...)` at `:485` puts it at the very end. So the repair
fills 2 calls, prints "repaired", and the request is rejected with the same error it started with —
exactly the "reports 2 filled, still rejects" shape.

R3 is the second hole: a tool_call whose id is empty is **skipped** by the repair
(`:466` requires `c.id.length > 0`) but is still serialized (`:134-141` emits `id: block.id`), and
the provider rejects it outright. The streamed path can produce such an id: the accumulator
initialises `{ id: '', ... }` (`:678`) and emits `id: call.id` with **no fallback** (`:685-689`),
while the non-streamed path does synthesise one (`:615`, `call.id ?? 'call-' + index`). So the same
malformed history behaves differently depending on whether the response was streamed.

**Why the 20 probe batches took 23.5s (and why 429 is refuted).** `run_cell.py:60-81` retries only if
`retryable(error)` is true, and that list is `("HTTP 429","HTTP 500","HTTP 502","HTTP 503","HTTP 504",
"transport","fetch failed","timeout","ECONNRESET","socket hang up")` (`:53-54`). A retried batch would
sleep `min(5*2^min(failures,4),120)` = 10+20+40+80+80 = **230s** (`:80`). Arm A's
`probe_seconds: 23.5` for 20 batches, with 17 failures, is arithmetically incompatible with any
retry. The verbatim 400 above matches none of the retryable markers, so each failure returned after
one attempt. **A 429 is ruled out by the timing, not merely unproven.**

---

## Finding C: what the MEMORY BENCH does to create unanswered tool calls

The bench offers the model tools it never answers, on every call:

1. `run_cell.py:250,298` calls `bridge.init(SYSTEM_PUSH, [])` — an empty *benchmark* tool list.
2. But `bridge-host.ts:1208-1220` `toolSchemas()` returns `[...benchmarkTools, ...efTools]`, and
   `modelTurn` passes it on every call (`:1353`). The host documents this itself at `:514`:
   "`toolSchemas()` forwards `ctx.tools.schemas()` to the provider UNCONDITIONALLY".
   `efTools` is non-empty because `init` mounts a ToolRuntime and the plugin registers the recall
   tools against it (`src/plugin.ts:176`, `registerRecallTools(toolsCtx, ...)`). So the model is
   offered `context_search` / `context_recall` even though the bench's protocol is "answer with a
   letter".
3. When the model calls one, `modelTurn` writes the assistant message **with the tool_calls** into
   the session (`bridge-host.ts:1457-1474`) and emits `tool/call` events (`:1480-1486`).
4. **`run_cell.py` has no tool-call handling at all** — grep for `tool_calls|call_tool|role.*tool`
   in the file returns **0 hits**. It reads only `reply.get("content")` (`:400`). Compare
   `eval/lhtb/ef_lhtb_agent.py:691-720`, which executes each call and appends a `role: tool` result.

So one tool call anywhere in the episode leaves an unanswered `tool_calls` in the history, and per
the adapter's own comment and R2/R4, **every later request in that episode is rejected**. That is the
17/21/21 failures in arms A/B/C. Arm N has 0 failures for a consistent reason: with no documents and
no questions, the model has nothing to call a tool for — it just says "Ready".

---

## Finding D: the LHTB lane is exposed to the same adapter defects

`eval/live/openai-adapter.ts` is the shared provider adapter for both lanes (imported by
`eval/tau2/bridge-host.ts`, which serves LHTB and tau2 as well as the memory bench). Two of the
defects are lane-independent:

- **The repair-order defect (R4)** fires whenever an LHTB history holds an unanswered call. LHTB
  normally answers every call (`ef_lhtb_agent.py:691-720`), so it does not trigger routinely — but
  the repair is the safety net for exactly that case, and on this route the net does not hold.
- **The empty-id defect (R3)** is directly reachable in LHTB: `ef_lhtb_agent.py:716` appends the
  result as `"id": call.get("id") or ""`, so a model call that arrives without an id produces a tool
  message with an **empty** `tool_call_id`, which R3 shows the provider rejects with
  "minimum string length is 1" — and the adapter's repair cannot fix it (`:466` skips empty ids).

I did not reproduce either in a live LHTB episode (no episode was started). The claim is limited to:
the code path is shared, and both rejection shapes are proven against the route.

---

## Finding E: a run with 85% provider failure still exits 0 and writes a full result

- `run_cell.py:432` does persist `probe_provider_failures`, and `score.overall` reports
  `scored: 0, accuracy: null` — those two are honest.
- But `main()` (`:495-507`) has no gate: it prints
  `cell A/quality/logical depth=5: folds 1/5, accuracy None (floor 0.25, unparsed 204)` and exits 0,
  having written a complete result file (`ef-phase7-logs/mem252k-fix-armA.log`).
- Verdict: **yes, it can reach that state, and nothing stops it.** A 204-probe cell whose every
  measurement failed is indistinguishable, by exit code and by the existence of an artifact, from a
  cell that measured something. `accuracy: null` is the only signal, and it is one field in a
  53 KB file.

---

## Finding F (demoted): the parser was never exercised

Required format — the renderer asks for it at `score_probes.py:40-41`:

    "Answer each question with ONE letter. Reply with exactly one line per question, in the form \"N: X\"."

and renders each question as `{p['id']}. {p['q']}` (`:45`) with options `A) ... B) ...` (`:46-48`).
The parser accepts two shapes:

    :53  _STRICT = re.compile(r"^\s*(\d+)\s*[:.)]\s*([A-Da-d])\b")
    :62  _LOOSE  = re.compile(r"\b(\d{1,3})\D{1,24}?\b([A-Da-d])\b")

Both require a **digit run followed by a letter**; `parse_answers` walks `text.splitlines()` (`:75`)
and any id left unfound lands in `unparsed` (`:85`).

In the 252K run the parser received, per the artifacts: `"(no response)"` (arm A, 13 chars), `""`
(arms B and C, 0 chars), and arm N's system-prompt acknowledgement. **None contains a digit+letter
pair, so neither regex could match, and `parsed_strict: 0, parsed_loose: 0` in all four result files
confirms it.** The parser did not reject anything; it was handed input that could not contain an
answer. No change to the parser would have changed any of these numbers.

---

## Finding G: the scorer cannot be audited against its own input

- Only the **first** batch's reply is kept, and only its first **300** characters:
  `run_cell.py:401-402` `if len(reply_heads) < 2: reply_heads.append(text[:300])`. The other 19
  batches' raw text is discarded.
- The provider's verbatim error is not in any artifact. It lives in the bridge's
  `lastFinishReason` / `lastProviderError`, but `run_cell.py:440-443` persists only nine telemetry
  keys (`folds, roots, emergencies, compactionFailures, compactionFailureKinds, promptTokensLast,
  surfaceNodesLast, costTotal, providerFailures`) — not those. `memory-bridge-stderr.log` contains
  **only** the adapter's own warning plus Node's ExperimentalWarning lines: I counted 100 lines, 37
  repair messages, 31 process banners, and **zero** other lines.
- I had to re-derive the provider's errors with four live requests (§B) because they were nowhere on
  disk. That is the "scorer that cannot be audited against its input" defect, and it applies to the
  reply text and the error text alike.

---

## Question 4 answered, and the claim REFUTED

`last_score.json` (02:26 local, before the regeneration) does show `accuracy 0.6078`, extraction
1.0, composition 1.0, abstention 1.0, update 1.0, **disambiguation 0.0 (0/80)**. Confirmed as file
content — but it is **not a bench result, and the 0/80 is not a model behaviour**.

`tests/memory-probe-scorer.spec.ts:78-87` builds exactly that pattern on purpose:

    const reply = key.probes.map(p => p.id + ': ' + (p.kind === 'disambiguation'
      ? 'ABCD'[(p.answer_index + 1) % 4]     // deliberately one letter off
      : L[p.answer_index])).join('\n')

`:43` pipes it into `score_probes.py`, which writes `last_score.json` (`score_probes.py:168`), and
`:44` reads it back. 124 correct of 204 (80 extraction + 20 composition + 20 abstention + 4 update)
with all 80 disambiguation probes deliberately wrong = 124/204 = 0.6078 — an exact match.
`run_cell.py` never writes `last_score.json` at all; it writes `result_*.json` and calls
`score_probes.score()` directly (`:411`), which does not touch the file.

**Verdict: the "disambiguation 0/80" is a test fixture, not evidence about `cat-jam-free`, and it
does not point at the same cause — it points at no cause.**

---

## Not established

- **Which tool the model called, and how many.** `bridge-host.ts:1487-1491` returns
  `tool_calls` to Python and `run_cell.py:400` discards them; the transcript keeps no record. The
  37 repair messages imply at least one unanswered call per poisoned episode (35 with 2, 2 with 1),
  but not which tool or which turn.
- **Whether the empty-id path (R3) actually occurred in this run.** It is a proven rejection shape and
  a proven gap in the repair (`:466` vs `:678-689`), but the run's ids were not persisted, so I
  cannot say it fired here. The repair-order defect (R4) alone explains the observed 400s.
- **Why the stderr log's last write is 03:43:38** while arms B and C ran at 03:45:08/03:45:18 and
  recorded 21 failures each. The file holds 37 repair messages against 59 recorded provider failures;
  whether it was re-pointed, truncated, or the later runs used a different `EF_BRIDGE_STDERR` is not
  determinable from what is on disk.
- **Whether LHTB has actually been hit by R3/R4.** The shared code path and both rejection shapes are
  proven; no live LHTB episode was started to observe it.
- **The raw reply text of batches 2-20** in every arm. Not persisted (Finding G).

---

## Minimal fixes (ours; none applied)

1. **Send the probe turn.** `run_cell.py:396-398`: append the rendered turn before stepping —
   `bridge.append({"role":"user","content":turn})` then `step_with_retry(bridge)`. Nothing else in
   this report matters until this is done; without it every arm is guaranteed 204 unparsed.
2. **Answer or forbid tool calls in the bench.** Either handle `reply.get("tool_calls")` the way
   `ef_lhtb_agent.py:691-720` does, or stop offering tools the bench will not answer — pass an
   explicit empty tool surface through to `toolSchemas()` (`bridge-host.ts:1208-1220`) instead of
   merging `ctx.tools.schemas()` unconditionally.
3. **Fix the adapter repair (shared, so this is the highest-leverage one).** Insert each synthetic
   `role:'tool'` message **immediately after** the assistant message that carries the call, not at
   the end of `messages` (`:485`); and treat an empty id as a call that needs an id, either by
   synthesising one in the streamed path as the non-streamed path already does (`:615` vs
   `:685-689`) or by dropping the id-less call. The comment at `:450` ("Order does not matter")
   should be corrected — R4 disproves it on this route.
4. **Persist the provider error and the raw reply.** Add `lastFinishReason` / `lastProviderError`
   to the telemetry keys at `run_cell.py:440-443`, and write each batch's raw reply (not just the
   first 300 chars of batch 1).
5. **Gate the run.** If `probe_provider_failures` exceeds a fraction of `probe_batches`, exit
   non-zero and mark the cell failed rather than writing a result file that reads like a measurement.
