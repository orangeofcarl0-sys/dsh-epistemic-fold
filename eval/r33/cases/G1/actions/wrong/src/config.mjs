export function loadConfig(input) {
  const path = typeof input === 'string' ? input : input.path
  return { source: path, timeoutMs: 1000 }
}
