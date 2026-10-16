# 118 — Transport: opencode.ai's address set, Node's `fetch`, and the proxy

Status: **measured, read-only.** 2026-10-16, node v24.18.0 / undici 7.28.0, Windows host.
No LHTB episode was started and no model call was made. Every probe below is DNS, TCP, TLS,
a local HTTP server, or an `https://example.com/` GET.

## A. The claim under test

`scripts/run-lhtb.sh:366-371`:

> `opencode.ai` resolves to nine A records, four of which refuse TCP 443, and curl falls back
> across the set while Node's fetch — which the bridge is — does not.

`scripts/check-route.mjs:12-24` repeats it and adds a measurement table:
`Node, direct 0/10 (9 x ECONNREFUSED, 1 x ETIMEDOUT)`, `Node, via proxy 5/5`, `curl, direct 200`.
The stated cause of the ten `fetch failed` provider failures (docs/108 §A) is therefore
"Node does not fall back across the address set".

## B. (a) Measurement — the address set is not nine, and it is healthy

Resolver `Resolve-DnsName`, five samples two seconds apart:

| sample | A records | AAAA (opencode.ai) |
| --- | --- | --- |
| 1-5 | 4 — `172.65.90.20`, `.21`, `.22`, `.23` (order rotates every sample) | 4 — `2606:4700:78::90:0:140-143` |

Node's own resolver agrees on the count: `dns.lookup('opencode.ai', { all: true, family: 0 })`
returns exactly those four IPv4 addresses, and `family: 6` returns `ENOENT` — this host has **no
IPv6 default route** (`Get-NetRoute -AddressFamily IPv6` for `::/0` = 0 rows), so getaddrinfo hands
the bridge four IPv4 addresses and nothing else. `dns.resolve6` does see the four AAAA records; they
never reach a connection attempt.

TCP 443 and TLS 1.3 against every A record (`net.connect` + `tls.connect`, 5s budget):

| address | TCP 443 | TLS |
| --- | --- | --- |
| 172.65.90.20 | ACCEPT 80ms | OK TLSv1.3 460ms |
| 172.65.90.21 | ACCEPT 73ms | OK TLSv1.3 435ms |
| 172.65.90.22 | ACCEPT 77ms | OK TLSv1.3 424ms |
| 172.65.90.23 | ACCEPT 73ms | OK TLSv1.3 422ms |

`net.connect({ host: 'opencode.ai', port: 443 })` with production defaults connects in **75ms**.

**Conclusion (a):** the "nine records, four refusing" condition is **not reproducible today** — 4 of 4
accept 443 and complete TLS. The record count is a time-varying Cloudflare anycast set, so the comment
is a snapshot of one bad minute, not a property of the route. The number must not be quoted as a
constant.

## C. (b) Does Node 24's `fetch` fall back across the set? It does.

**Version.** `node v24.18.0`, `process.versions.undici = 7.28.0` (identical to the vendored
`vendor/.../undici@7.28.0`, so the vendored copy is a faithful stand-in for the built-in one).

**Mechanism, from the code rather than folklore.** undici's `buildConnector`
(`vendor/deepseek-harness/node_modules/.pnpm/undici@7.28.0/node_modules/undici/lib/core/connect.js:62-118`)
forwards the caller's connect options straight through:

```js
socket = tls.connect({ highWaterMark: 16384, ...options, servername, session, localAddress, ... host: hostname })  // :86
socket = net.connect({ highWaterMark: 64 * 1024, ...options, localAddress, port, host: hostname })                // :108
```

`autoSelectFamily` appears **nowhere in undici's `lib/`** (grep: 11 hits, all in `docs/` and
`types/`). undici never sets it, so Node's runtime default applies:

* `net.getDefaultAutoSelectFamily()` → **`true`** (measured on 24.18.0)
* `net.getDefaultAutoSelectFamilyAttemptTimeout()` → **250** ms
* with it on, `net` resolves via `dns.lookup(all: true)` and walks the whole set, collecting
  failures into an `AggregateError` (one entry per address).

**Measurements.** Five independent probes, all on this host:

1. HTTP server bound to `127.0.0.1` only, `fetch http://localhost:PORT/` → **200**. `dns.lookup`
   returned `[::1, 127.0.0.1]`; `::1` refuses; the request still succeeded.
2. The mirror: server on `::1` only → **200**.
3. undici `Agent` with an injected `lookup` of `[127.0.0.2 (dead), 127.0.0.1 (live server)]` →
   **200**. Dead first, live second, and the fetch succeeded.
4. All addresses refusing → `TypeError: fetch failed`, cause `AggregateError` with
   `code: 'ECONNREFUSED'` and `errors: ['ECONNREFUSED','ECONNREFUSED']` — i.e. **two** addresses
   were attempted for a two-address host.
5. `connect: { autoSelectFamily: false }` → only the first address is tried and the fetch fails
   `ECONNREFUSED 127.0.0.2`. The knob exists and it **disables** fallback; the default has it on.

**Conclusion (b): the claim is false on Node 24.18.0.** Node's `fetch` does fall back across the
address set, so "four of nine refuse 443" cannot by itself produce `fetch failed`: Node would have
walked past the four. When a run fails every call, either *every* address failed at once (the route is
down — the runner's own direct 0/20 measurement), or the failure is upstream of the origin
(a dead proxy, or DNS).

**One real defect this measurement did expose.** `neverReachedProvider`
(`eval/live/openai-adapter.ts:701-721`) walks only `.cause` and reads only `.code`. An
`AggregateError`'s `code` is the **first** inner error's code, so the release decision depends on
address order:

| injected address order | error the adapter sees | `neverReachedProvider` |
| --- | --- | --- |
| blackhole first, refused second | `AggregateError code=ETIMEDOUT`, inner `['ETIMEDOUT','ECONNREFUSED']` | **false** — 32,768-token reserve stranded |
| refused first, blackhole second | `ConnectTimeoutError UND_ERR_CONNECT_TIMEOUT` | true — reserve released |

`ETIMEDOUT` is a pre-send failure (no bytes left the machine) but it is not in the allow-list
(`openai-adapter.ts:702-710`: `ENOTFOUND, EAI_AGAIN, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT,
ERR_INVALID_URL, ENETUNREACH, EHOSTUNREACH`), and the inner `errors` array is never consulted.
docs/108 §F predicted "if they were pre-send failures that becomes 0"; for the mixed-address shape it
does not become 0. The runner's own table lists one `ETIMEDOUT` among ten failures, so this is not a
hypothetical branch.

## D. (c) The proxy is in the bridge's path, and it changes the picture

Wiring, all measured by reading the code path:

* `scripts/run-lhtb.sh:246` — `EF_USE_PROXY` defaults to **1**.
* `:258-272` — the port is *discovered* from `7890 7897 10808 1080 7891`; `7890` answers `400`,
  so `HTTPS_PROXY=http://127.0.0.1:7890` is exported.
* `:274-276` — `NODE_USE_ENV_PROXY=1` is exported with it.
* `:462` — `exec "$HARBOR_EXE" run -c "$CONFIG_TMP"`, so harbor, the agent and the bridge inherit it.
* `eval/bridge/ef_bridge_client.py:113` `env = dict(os.environ)` and `:132-146` `Popen(['node',
  '--experimental-transform-types', .../bridge-host.ts], env=env)` — nothing strips it.
* `eval/live/openai-adapter.ts:269` — the adapter uses `globalThis.fetch`, i.e. the transport the
  env proxy applies to.

Node honours the env proxy **only** with the flag. Four runs against `https://example.com/`:

| flag | `HTTPS_PROXY` | result |
| --- | --- | --- |
| off | `http://127.0.0.1:45999` (dead) | 200 — variable ignored |
| **on** | `http://127.0.0.1:45999` (dead) | `ECONNREFUSED 127.0.0.1:45999` — variable used |
| off | `http://127.0.0.1:7890` (live) | 200 |
| **on** | `http://127.0.0.1:7890` (live) | 200 |

So `check-route.mjs:158-178`'s three-state proxy label is correct, and a bare `HTTPS_PROXY` without
the flag is indeed ignored.

With the proxy in effect the **origin's address set is not the client's problem**: the client
connects to the proxy's single address and the proxy resolves the origin. Measured:

* `CONNECT opencode.ai:443` through `127.0.0.1:7890` → `HTTP/1.1 200 Connection established` (2ms)
* `CONNECT 172.65.90.20:443` → `HTTP/1.1 200 Connection established` (1ms)
* `GET https://opencode.ai/` → 200 direct **and** 200 proxied
* `GET https://opencode.ai/zen/v1/models` → 200 direct **and** 200 proxied

`NO_PROXY` (`scripts/proxy-env.sh:42` → `localhost,127.0.0.1,::1`) does not cover `opencode.ai`,
so the proxy is used for it, not bypassed.

**Conclusion (c):** yes, the proxy is in the bridge's path by default whenever one of the five ports
answers — it does today (`7890` and `7897` listen; this shell already carries
`HTTPS_PROXY=http://127.0.0.1:7890` and `NODE_USE_ENV_PROXY=1`). It removes the address-set question
entirely, which is why the proxy route was the one that worked while direct was 0/20.

## E. (d) The minimal robust fix

**Do not add a custom undici dispatcher.** The default already walks the address set (section C);
pinning `autoSelectFamily: true` in a dispatcher changes nothing, and `autoSelectFamily: false`
would *break* the fallback that exists. The only dispatcher knob with real value is
`connect.timeout`, whose error (`UND_ERR_CONNECT_TIMEOUT`) is already in the release allow-list, and
undici already defaults it to 10s (`connect.js:69`).

**Recommended, in order:**

1. **Fix `neverReachedProvider` (`eval/live/openai-adapter.ts:701-721`).** Walk `AggregateError.errors`
   (or accept `ETIMEDOUT` for a connect that provably sent nothing) so the mixed-address shape releases
   its reservation. This is the smallest change that is provably correct, and it is exactly the case
   docs/108 §F left open. Cost S, risk low — but note there is **no test pinning this function today**
   (`neverReachedProvider` has 0 hits under `tests/`; `tests/live-budget-admission.spec.ts` pins the
   `release()` path with synthetic codes only). Add the AggregateError case there.
2. **Bounded transport retry in `requestWithRetry` (`openai-adapter.ts:314-377`).** It currently
   retries only HTTP 429 (`:369`); transport is single-shot by design (`:302-304`). Gate a retry on
   `neverReachedProvider` — 2 extra attempts, ~250-500ms backoff — so a transient connect fault costs
   two cheap attempts instead of a provider failure. Cost S, risk low.
3. **Runner: keep `check-route.mjs`, correct its claim, and make it print the address set.** The
   preflight's *shape* is right (it asks with the bridge's transport and the bridge's proxy
   environment). Two fixes: (i) delete the false "Node does not fall back" mechanism from
   `run-lhtb.sh:366-371` and `check-route.mjs:12-24`, because it sends the operator to the wrong
   remedy; (ii) print the resolved A count, the per-address TCP result, and the proxy decision, so the
   output distinguishes "one address dead, fallback handled it" from "every address dead, route is
   down". Cost S, risk low.

**What none of this fixes:**

* **All addresses down at once.** Measured: direct `0/20` while proxy `6/20` in the same minute
  (`run-lhtb.sh:233-240`). No retry and no dispatcher can help; only the proxy can. The runner already
  defaults `EF_USE_PROXY=1`, which is the correct fix and is why this is not the ten-failure cause
  today.
* **A dead or refusing proxy.** The retry fails identically; only the preflight's proxy label
  (`check-route.mjs:158-178`) detects it.
* **HTTP 429 / 5xx.** Deliberately not retried (`openai-adapter.ts:302-304`); that is provider
  capacity, ~30% of nominal throughput per `run-lhtb.sh:242-245`.
* **The archive still cannot say which shape failed.** `lastProviderError` is
  `finishReason.slice('error:'.length)` (`eval/tau2/bridge-host.ts:1443`) and the finish reason is
  built from `error.message` (`openai-adapter.ts:540`, `:571`), which for a failed fetch is the
  literal `fetch failed` — the `cause` chain is dropped. docs/108 §F says "the error detail is now
  preserved in `lastProviderError` rather than flattened to `fetch failed`"; that is **not true for
  transport failures**, and it is why the ten failures could not be classified after the run.
  Surfacing `error.cause.code` (and the AggregateError's inner codes) is a separate, cheap change.
* **The 55-minute stall** (docs/103-115): unrelated to transport.

## F. Reproduce

```sh
# address set and health
powershell -c "Resolve-DnsName opencode.ai -Type A -DnsOnly"
node -e "require('node:dns').lookup('opencode.ai',{all:true},(e,a)=>console.log(a))"
node -e "const n=require('node:net');console.log(n.getDefaultAutoSelectFamily(),n.getDefaultAutoSelectFamilyAttemptTimeout())"

# Node's own fallback, no external request: a server on one family only, fetched as localhost
# (see section C probes 1-3; the vendored undici 7.28.0 is byte-identical to the built-in one)

# proxy decision, four runs of: HTTPS_PROXY=... NODE_USE_ENV_PROXY=... node -e "fetch('https://example.com/')"

# route, both ways
node scripts/check-route.mjs
```
