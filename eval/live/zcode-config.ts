/**
 * Live route resolution for the opt-in live behavioral subset (R1 §21).
 *
 * The route is taken from the ZCode configuration that drives this workspace,
 * so the live tier measures the model actually in use rather than a
 * separately-configured one. Resolution is deliberately layered:
 *
 *   1. Explicit environment overrides win, so CI and other machines can point
 *      the tier somewhere else without touching code.
 *   2. Otherwise the ZCode provider config is read, the provider serving the
 *      requested model is found through its own model rules, and that
 *      provider's endpoint and key are used.
 *
 * **The API key never enters the repository.** It is read at runtime, held in
 * memory for the duration of a run, and never logged, serialized, or written
 * to a bundle. Any error message that could contain it is redacted.
 *
 * @module eval/live/zcode-config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** A resolved live model route. `apiKey` is runtime-only and never persisted. */
export interface LiveRoute {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
  /** Where the route came from, for the report (never includes the key). */
  readonly origin: string
  /**
   * Extra request headers this route requires, from `EF_LIVE_HEADERS`.
   *
   * A property of the ROUTE rather than of any one model, so it travels with the
   * route instead of being rebuilt at each call site. `https://opencode.ai/zen/go/v1`
   * is why this exists: without an `x-opencode-session` header it answers
   * `400 MissingSessionID` ("cannot be routed efficiently") on every call, while
   * the sibling `/zen/v1` route does not ask for one.
   *
   * Deliberately not a place for credentials: the key has its own field and is
   * redacted on the error paths, whereas these values are printed in the route
   * report.
   */
  readonly headers?: Readonly<Record<string, string>>
}

/** The default model: this workspace's ZCode session model. */
const DEFAULT_MODEL = 'deepseek-v4.1-flash'

/**
 * Candidate ZCode config paths, in preference order.
 *
 * Note the two distinct files: `provider_config.json` (named by
 * `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`) holds only provider ORDER and model
 * rules, while the sibling `config.json` in the same directory holds the
 * endpoints and keys. Deriving from the provider-config path's directory is
 * therefore what actually finds credentials.
 */
function configPathCandidates(): string[] {
  const paths: string[] = []
  const explicit = process.env.EF_LIVE_CONFIG_PATH
  if (explicit !== undefined && explicit.length > 0) paths.push(explicit)
  const v2 = process.env.ZCODE_V2_CONFIG_FILE
  if (v2 !== undefined && v2.length > 0) paths.push(v2)
  const personal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  if (personal !== undefined && personal.length > 0) {
    paths.push(join(dirname(personal), 'config.json'))
  }
  paths.push(join(homedir(), '.zcode', 'v2', 'config.json'))
  return [...new Set(paths)]
}

/** Strip anything key-shaped from text before it can reach a log or a report. */
export function redactSecret(text: string, secret?: string): string {
  if (secret !== undefined && secret.length > 0) {
    return text.split(secret).join('<redacted>')
  }
  return text.replace(/\b(sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/gu, '<redacted>')
}

interface ProviderEntry {
  readonly kind?: string
  readonly options?: { readonly apiKey?: string; readonly baseURL?: string }
}

interface ProviderModelRule {
  readonly modelId?: string
  readonly providerId?: string
}

interface ZcodeConfig {
  readonly provider?: Record<string, ProviderEntry>
  readonly config?: {
    readonly modelConfigRules?: {
      readonly providerModelRules?: readonly ProviderModelRule[]
    }
  }
}

/**
 * Read the ZCode provider config. Throws a redacted error when it is missing
 * or malformed — the live tier must fail loudly rather than silently fall back
 * to a keyless route and report synthetic behavior as live behavior.
 */
function readConfig(path: string): ZcodeConfig {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ZcodeConfig
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`live route: cannot read ZCode provider config at ${path}: ${redactSecret(message)}`)
  }
}

/**
 * The provider id whose model rules serve `model`. The rules live in
 * `provider_config.json`, which is a DIFFERENT file from the one carrying
 * keys, so this reads the provider-config file named by the environment.
 */
function providerForModel(model: string): string | undefined {
  const personal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  const paths = [
    ...(personal !== undefined && personal.length > 0 ? [personal] : []),
    join(homedir(), '.zcode', 'v2', 'provider_config.json'),
  ]
  for (const path of paths) {
    let config: ZcodeConfig
    try {
      config = readConfig(path)
    } catch {
      continue
    }
    const rules = config.config?.modelConfigRules?.providerModelRules ?? []
    // Last matching rule wins, mirroring how the client applies overrides.
    let found: string | undefined
    for (const rule of rules) {
      if (rule.modelId === model && rule.providerId !== undefined) found = rule.providerId
    }
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Resolve the live route for `model`.
 *
 * @param options - optional model override and config path.
 * @returns the route, or `undefined` when no usable route exists (no key, no
 *   endpoint, or no such model) — an absent live route is a normal condition
 *   that skips the tier, never an error.
 */
/**
 * Parse `EF_LIVE_HEADERS`: a JSON object of extra request headers for the route.
 *
 * A malformed value is an ERROR rather than a silently ignored one. A route that
 * needs a header and does not receive it answers 400 on *every* call, and a run
 * whose every model call fails reads as a provider fault rather than as a typo —
 * which is the same shape as the `error:fetch failed` trap documented in
 * `docs/50_PHASE7_HANDOFF.md` §2.1. The failure mode is identical whether the
 * header is missing or misspelled, so the value is checked once, here.
 */
function resolveHeaders(): Readonly<Record<string, string>> | undefined {
  const raw = process.env.EF_LIVE_HEADERS
  if (raw === undefined || raw.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`EF_LIVE_HEADERS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('EF_LIVE_HEADERS must be a JSON object of header names to values')
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`EF_LIVE_HEADERS entry "${name}" must be a string`)
    }
    headers[name] = value
  }
  return Object.keys(headers).length === 0 ? undefined : headers
}

export function resolveLiveRoute(options: {
  readonly model?: string
  readonly configPath?: string
} = {}): LiveRoute | undefined {
  const model = options.model ?? process.env.EF_LIVE_MODEL ?? DEFAULT_MODEL
  const headers = resolveHeaders()

  // 1. Explicit environment overrides.
  const envBase = process.env.EF_LIVE_BASE_URL
  const envKey = process.env.EF_LIVE_API_KEY
  if (envBase !== undefined && envBase.length > 0 && envKey !== undefined && envKey.length > 0) {
    return headers === undefined
      ? { baseUrl: envBase, model, apiKey: envKey, origin: 'environment' }
      : { baseUrl: envBase, model, apiKey: envKey, origin: 'environment', headers }
  }

  // 2. ZCode provider config (first readable candidate that yields a route).
  const paths = options.configPath === undefined ? configPathCandidates() : [options.configPath]
  for (const path of paths) {
    let config: ZcodeConfig
    try {
      config = readConfig(path)
    } catch {
      continue
    }
    const providers = config.provider ?? {}
    const preferred = process.env.EF_LIVE_PROVIDER_ID ?? providerForModel(model)

    const candidates = preferred === undefined
      ? Object.keys(providers)
      : [preferred, ...Object.keys(providers).filter(id => id !== preferred)]

    for (const id of candidates) {
      const entry = providers[id]
      const baseUrl = entry?.options?.baseURL
      const apiKey = entry?.options?.apiKey
      if (baseUrl === undefined || baseUrl.length === 0) continue
      if (apiKey === undefined || apiKey.length === 0) continue
      return headers === undefined
        ? { baseUrl, model, apiKey, origin: `zcode config ${path} (provider ${id})` }
        : { baseUrl, model, apiKey, origin: `zcode config ${path} (provider ${id})`, headers }
    }
  }
  return undefined
}
