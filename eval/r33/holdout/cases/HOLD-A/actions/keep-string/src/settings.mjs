export function readSettings(input) {
  const name = typeof input === 'string' ? input : input.name
  return { name, retries: 3 }
}
