#!/usr/bin/env node
/**
 * Does the BRIDGE's own transport reach the provider?
 *
 * ## The defect this exists for
 *
 * The Phase 7 handoff's precondition table told the operator to verify the route
 * with `curl`:
 *
 *     curl -s -o /dev/null -w '%{http_code}' https://opencode.ai/zen/v1/models
 *
 * That check is wrong in kind, and it cost a full LHTB probe. `opencode.ai`
 * resolves to nine A records, four of which refuse TCP 443. `curl` walks the
 * address set and falls back, so it reports 200 and looks healthy. Node's
 * `fetch` does not fall back — and the EF bridge is Node. Measured on the host
 * where this was found:
 *
 *     Node, direct        0/10   (9 x ECONNREFUSED, 1 x ETIMEDOUT)
 *     Node, via proxy     5/5    HTTP 200
 *     curl, direct        200
 *
 * So the precondition passed while every model call in the run failed as
 * `error:fetch failed` — a message that names neither the route nor the proxy,
 * which is why the handoff warns it reads like a credential fault.
 *
 * The fix is not a better curl invocation. It is to ask the question in the
 * transport that will actually make the calls, which is what this does: the same
 * Node `fetch`, against the same URL shape, with the same proxy environment the
 * runner will export.
 *
 * ## What it reports
 *
 * Exit 0 only if at least one attempt reached the provider over HTTP. A non-zero
 * exit means the sweep would have spent its budget on transport failures.
 *
 * The credential is read from the environment and never printed; a failed
 * attempt reports only the error CLASS (ECONNREFUSED, ETIMEDOUT, …), because a
 * provider error body can echo the request that carried it.
 *
 * Usage:
 *   node scripts/check-route.mjs
 *   node scripts/check-route.mjs --attempts 10
 *
 * Environment:
 *   EF_LIVE_BASE_URL   base URL (default https://opencode.ai/zen/v1)
 *   EF_LIVE_API_KEY    credential; absent → the probe is unauthenticated
 */

const attemptsArg = process.argv.indexOf('--attempts')
const ATTEMPTS = attemptsArg >= 0 ? Number(process.argv[attemptsArg + 1]) : 5

const BASE = (process.env.EF_LIVE_BASE_URL ?? 'https://opencode.ai/zen/v1').replace(/\/+$/u, '')
const KEY = process.env.EF_LIVE_API_KEY ?? ''
const URL_UNDER_TEST = `${BASE}/chat/completions`

/**
 * The failure CLASS, not the whole message.
 *
 * Node reports a failed `fetch` as `TypeError: fetch failed` with the real
 * reason on `cause`. When the address set is walked and several entries fail,
 * the cause is an `AggregateError` whose `errors` array carries one entry per
 * address — which is exactly the signal this check exists to surface, since the
 * Phase 7 fault was "four of nine addresses refuse 443". Reporting only the
 * outer message would print `fetch failed` and hide it.
 */
function classify(error) {
  const codes = []
  const visit = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 4) return
    if (typeof node.code === 'string') codes.push(node.code)
    if (typeof node.message === 'string' && node.message.length > 0 && node.message !== 'fetch failed') {
      codes.push(node.message.slice(0, 40))
    }
    if (Array.isArray(node.errors)) for (const inner of node.errors) visit(inner, depth + 1)
    visit(node.cause, depth + 1)
  }
  visit(error, 0)
  const unique = [...new Set(codes)]
  return unique.length === 0 ? 'unknown transport failure' : unique.join(' / ')
}

/** One POST shaped like the adapter's, so the transport path is identical. */
async function attempt() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(URL_UNDER_TEST, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(KEY.length === 0 ? {} : { authorization: `Bearer ${KEY}` }),
      },
      // A deliberately invalid model. The question is whether the request
      // REACHES the provider, not whether it succeeds: a 400/404 proves the
      // round trip works, and avoids spending tokens on a real completion.
      body: JSON.stringify({ model: 'route-preflight-probe', messages: [], max_tokens: 1 }),
      signal: controller.signal,
    })
    return { ok: true, status: response.status }
  } catch (error) {
    return { ok: false, error: classify(error) }
  } finally {
    clearTimeout(timer)
  }
}

const results = []
for (let i = 0; i < ATTEMPTS; i += 1) results.push(await attempt())

const reached = results.filter(r => r.ok)
const failures = results.filter(r => !r.ok)
const classes = {}
for (const f of failures) classes[f.error] = (classes[f.error] ?? 0) + 1

/**
 * What Node will ACTUALLY do with the proxy environment, not what it contains.
 *
 * ## The defect this replaced
 *
 * The label was `NODE_USE_ENV_PROXY === '1' || HTTPS_PROXY !== undefined`, so a
 * bare `HTTPS_PROXY` printed `proxy: enabled` — while Node ignored it and
 * connected directly. Measured: with `HTTPS_PROXY` set to a dead port and
 * `NODE_USE_ENV_PROXY` unset, a request still reached the origin (HTTP 200);
 * with the flag set, the same request died `ECONNREFUSED`. That is an ironic
 * failure for a tool whose whole purpose is to stop a check from describing the
 * environment instead of the transport — which is exactly what `curl` did.
 *
 * Node honours `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` only when
 * `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`). So the honest label has three
 * states, and the middle one is a trap worth naming out loud.
 */
function proxyState() {
  const set = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .filter(name => (process.env[name] ?? '').length > 0)
  const flag = process.env.NODE_USE_ENV_PROXY
  const honoured = flag === '1' || flag === 'true'
  if (honoured && set.length > 0) {
    const primary = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY
    return { label: `in effect — Node will route via ${primary}`, trap: false }
  }
  if (honoured) return { label: 'in effect, but NO proxy variable is set (Node routes direct)', trap: false }
  if (set.length > 0) {
    // The misleading case, and the one this function exists to stop reporting
    // as "enabled".
    return {
      label: `NOT in effect — ${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set but Node `
        + 'ignores the proxy environment without NODE_USE_ENV_PROXY=1',
      trap: true,
    }
  }
  return { label: 'not in effect — direct connection', trap: false }
}

const proxy = proxyState()
console.log(`route: ${URL_UNDER_TEST}`)
console.log(`proxy: ${proxy.label}`)
console.log(`node fetch: ${reached.length}/${ATTEMPTS} reached`)
if (reached.length > 0) {
  const statuses = [...new Set(reached.map(r => r.status))].sort((a, b) => a - b)
  console.log(`  HTTP ${statuses.join(', ')}`)
}
if (failures.length > 0) {
  console.log(`  failures: ${Object.entries(classes).map(([k, n]) => `${n} x ${k}`).join(', ')}`)
}

// A proxy that is set but NOT in effect is the most likely cause of a failure
// here, and the least likely to be suspected — the environment says a proxy is
// configured. Say it before the generic advice.
if (proxy.trap) {
  console.error(
    '\nNOTE: a proxy is configured in the environment but Node is NOT using it.\n'
    + 'Node ignores HTTPS_PROXY/HTTP_PROXY/NO_PROXY unless NODE_USE_ENV_PROXY=1.\n'
    + 'Set that flag (scripts/run-lhtb.sh does, under EF_USE_PROXY=1) if the\n'
    + 'route needs the proxy.\n',
  )
}

if (reached.length === 0) {
  console.error(
    '\nThe BRIDGE cannot reach the provider, so a run would fail every model call\n'
    + 'with `error:fetch failed`. curl may still report 200: it falls back across\n'
    + 'the address set and Node does not.\n'
    + '\nIf the route genuinely needs a proxy, verify the proxy answers THIS check\n'
    + 'first, then run with EF_USE_PROXY=1.\n',
  )
  process.exit(1)
}
