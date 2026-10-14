# 92 — Per-request reserves: implemented, two tests unresolved, NO RERUN

Status: **BUDGET GATE BLOCKED — NO LIVE RUN.** 2026-10-15. Parent `196273f`.

## A. The leftover bridge process did not exist

Checked with a signature the detector's own command line cannot match (assembled by concatenation,
and excluding `powershell` wrappers): **0 genuine `bridge-host` processes**, 0 containers, 0 harbor
processes. The "1 left" reported after the P1 run was a **self-match artifact again** -- my check
contained the literal `tau2`, which its own command line also contained. Nothing was reaped because
nothing was there.

## B. The budget fix, implemented

**The reserve now follows the request actually sent.** `admit()` takes the request's own bound and
returns a CREDENTIAL; `record()` settles that credential. The adapter reads the bound from the same
`options.maxTokens` that goes on the wire, so an escalated reply raises the reserve with it.

* the prompt side is the context window;
* the output side is **this call's `max_tokens`**, not a constant;
* a request with no reliable bound **fails closed** (`unknown-output-bound`);
* a bound above the approved per-request ceiling is **refused** (`output-reserve-exceeds-approved-max`);
* every 429 retry is its own admission with its own credential, so a retry costs what it costs;
* `settle(credential)` removes exactly that reservation, which is what makes different-sized
  reservations safe under concurrency and out-of-order completion.

This is the defect that ended the P1 run at call 13: a constant 131,072 reserve against a 100,000
output limit, where ONE failed request whose reserve rightly stood made `consumedOutput()` exceed the
limit permanently.

## C. Two tests I could not resolve, and why that stops the rerun

15 of 17 admission tests pass. **Two of the tests I added this round fail**, both in the multi-attempt
429 case, and I did not establish why within this round's budget:

* `keeps only its own max_tokens when a request fails, and the run continues`
* `settles only the credential it is given, so a failed request keeps its reserve`

I tried a hardcoded expectation, then a derived one tied to the provider's own attempt count, and
neither matched. The cause is therefore NOT simply my arithmetic, and I am not going to guess at it
and then launch a 90-minute episode on top of the guess.

**The rerun did not happen.** The brief's own rule is that a failing test stops the launch, and a
gate whose accounting cannot be explained is exactly the condition that rule exists for. Reporting a
launch here would be fabrication.

## D. What the failing tests do NOT tell us

They are NEW tests of NEW behaviour. They do not show that the previous defect is unfixed: the
per-request reserve is in place and 15 tests -- including the token-boundary, partial-usage,
dimension-settlement and concurrency cases -- pass. What is unresolved is whether the two new
scenarios behave as I described them, which is a narrower and more honest statement.

## E. Next step

Print the actual snapshot from inside those two tests and read it, rather than asserting against a
predicted value. That is one run, and it is the only thing standing between this state and a
launch decision.
