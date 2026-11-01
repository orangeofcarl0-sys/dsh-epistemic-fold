export function loadConfig(input) {
  const path = typeof input === 'string' ? input : input.path
  return { source: path, timeoutMs: typeof input === 'string' ? 500 : (input.timeoutMs ?? 500) }
}
