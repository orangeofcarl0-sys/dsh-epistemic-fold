# EF-R4 health probe

Verdict: **fail**

Requests: 0/16 succeeded, 1 failed.
Latency: p50 51 ms, p95 51 ms, max 51 ms.
Pre-registered p95 bound: 60,000 ms; met: true.

First failure:
- t13-summary-failed-shape #1: 51 ms, finish error, usage missing, error LIVE_TRANSPORT

The transport/usage acceptance failed before the first success. The 36-cell campaign must not start; no automatic retry.

