# EF-R2 — E1 compaction failure attribution

Campaign `e2e-lg-confirm-1`: 42 attempts, 11 committed, 31 failed.

| Reason | Count |
|---|---|
| shrink-refusal | 31 |

## The decision that matters

- Failed attempts whose **body** was at least the span: **31/31**.
- Failed attempts whose **state-only body** was at least the span: **0/31**.
- State-only tokens: 12–12; span tokens: 58–207.

**Decision: none production fix.** The state-only body is only the marker (12 estimated tokens in every failure); the rationale is the excess. The model call was necessary to know whether the rationale would fit, and a shorter rationale could have committed. A pre-call guard would therefore convert one refusal into another, not prevent a doomed transaction.

**Retry suppression: not justified.** The retries are not uniformly futile. In T9-s1-E1-r2 and T10-s1-E1-r1 the first attempt failed on a 200-token span, and the next attempt committed after folding a ~9.2k-token span. A blanket retry suppression would lose those two commits. A refusal cache keyed on the exact span seqs is a candidate, but the archive does not retain the failed attempts' span seqs, so its effect on these cells is unverified. It belongs to a future round whose witness captures those seqs.

Cells with retries: 14; cells where a later attempt committed: 2.

**Candidate mismatch, not a claimed fix:** admitLeafEconomically prices the widest legal span with retainTokens=0, while the executor folds the span left after spec.retainTokens. In these cells the executed span is 58-207 tokens, below the 530-token framing fallback, but that does not prove the decider would have refused it. Whether economic admission prevents these attempts needs a dedicated replay with the real measurement; it is a hypothesis, not a result.

## Failed attempts

| Cell | # | Span | Body | State-only | Rationale finish | Input | Output |
|---|---|---|---|---|---|---|---|
| T7-s1-E1-r1 | 1 | 62 | 248 | 12 | stop | 210 | 183 |
| T7-s1-E1-r1 | 2 | 62 | 296 | 12 | stop | 274 | 235 |
| T7-s1-E1-r2 | 1 | 62 | 325 | 12 | stop | 210 | 253 |
| T7-s1-E1-r2 | 2 | 62 | 496 | 12 | stop | 146 | 383 |
| T7-s2-E1-r1 | 1 | 62 | 180 | 12 | stop | 208 | 126 |
| T7-s2-E1-r1 | 2 | 62 | 260 | 12 | stop | 272 | 192 |
| T7-s2-E1-r1 | 3 | 62 | 375 | 12 | stop | 144 | 284 |
| T7-s2-E1-r1 | 4 | 62 | 310 | 12 | stop | 144 | 235 |
| T7-s2-E1-r2 | 1 | 62 | 273 | 12 | stop | 208 | 204 |
| T7-s2-E1-r2 | 2 | 62 | 280 | 12 | stop | 144 | 207 |
| T8-s1-E1-r1 | 1 | 58 | 240 | 12 | stop | 201 | 170 |
| T8-s1-E1-r1 | 2 | 58 | 372 | 12 | stop | 393 | 263 |
| T8-s1-E1-r1 | 3 | 58 | 217 | 12 | stop | 137 | 142 |
| T8-s1-E1-r2 | 1 | 58 | 220 | 12 | stop | 201 | 151 |
| T8-s1-E1-r2 | 2 | 58 | 362 | 12 | stop | 137 | 267 |
| T8-s1-E1-r2 | 3 | 58 | 322 | 12 | stop | 137 | 223 |
| T8-s2-E1-r1 | 1 | 58 | 281 | 12 | stop | 201 | 200 |
| T8-s2-E1-r1 | 2 | 58 | 272 | 12 | stop | 137 | 191 |
| T8-s2-E1-r2 | 1 | 58 | 303 | 12 | stop | 201 | 212 |
| T8-s2-E1-r2 | 2 | 58 | 328 | 12 | stop | 137 | 233 |
| T9-s1-E1-r1 | 1 | 207 | 260 | 12 | stop | 420 | 265 |
| T9-s1-E1-r2 | 1 | 207 | 308 | 12 | stop | 164 | 319 |
| T9-s2-E1-r2 | 1 | 205 | 290 | 12 | stop | 161 | 266 |
| T9-s2-E1-r2 | 2 | 205 | 322 | 12 | stop | 353 | 297 |
| T10-s1-E1-r1 | 1 | 200 | 305 | 12 | stop | 425 | 303 |
| T10-s1-E1-r2 | 1 | 200 | 317 | 12 | stop | 169 | 316 |
| T10-s1-E1-r2 | 2 | 200 | 377 | 12 | stop | 361 | 369 |
| T10-s2-E1-r1 | 1 | 200 | 245 | 12 | stop | 425 | 272 |
| T10-s2-E1-r1 | 2 | 200 | 407 | 12 | stop | 361 | 399 |
| T10-s2-E1-r2 | 1 | 200 | 411 | 12 | stop | 169 | 409 |
| T10-s2-E1-r2 | 2 | 200 | 342 | 12 | stop | 233 | 321 |

Failed-call cost: 7083 input, 7890 output tokens. The calls were paid for; the bodies were never delivered.

