/**
 * The opt-in live tier's gate and route.
 *
 * `EF_LIVE` gating and the `live`/`live` route were restated in sixteen and
 * eleven files respectively. The gate is the one worth centralizing: it decides
 * whether a suite SKIPS or asserts, so sixteen copies of `=== '1'` are sixteen
 * chances for one to drift into `!== undefined` and silently run a live tier
 * that was supposed to stay off.
 *
 * Per-suite knobs (`REPLICATES`, `WINDOW`, `TURNS`) deliberately stay in their
 * own files: they read different env vars with different defaults, so hoisting
 * them would invent a shared meaning they do not have.
 *
 * @module tests/live-gate
 */

/** Whether the opt-in live tier is enabled (`EF_LIVE=1`). */
export const LIVE_ENABLED = process.env.EF_LIVE === '1'

/** The provider every live suite routes to. */
export const LIVE_PROVIDER = 'live'

/** The model route every live suite uses. */
export const MODEL_OPTIONS = { provider: LIVE_PROVIDER, model: 'live' } as const
