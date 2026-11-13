# EF-R3 health probe

Verdict: **pass-with-latency-caveat**

Requests: 16/16 succeeded, 0 failed.
Latency: p50 21798 ms, p95 82290 ms, max 82290 ms.
Pre-registered p95 bound: 60,000 ms; met: false.

Requests over 60s:
- t13-summary-failed-shape-s2 #4: 82290 ms, finish max-tokens, usage 30059 in / 1024 out

The transport/usage acceptance is separate from the latency bound. No transport error occurred in 16/16 requests.

