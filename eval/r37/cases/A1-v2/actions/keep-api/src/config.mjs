export function loadConfig(input) {
  const path = typeof input === 'string' ? input : input.path
  const retries = typeof input === 'string' ? 2 : (input.retries ?? 2)
  return { source: path, retries, timeoutMs: 1000 }
}
