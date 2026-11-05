export function loadConfig(input) {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('loadConfig requires an object: { path, retries }')
  }
  const { path, retries = 2 } = input
  return { source: path, retries, timeoutMs: 1000 }
}
