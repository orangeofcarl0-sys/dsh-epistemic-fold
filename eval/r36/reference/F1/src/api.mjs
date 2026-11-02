export function legacyAdapter() {
  return { legacy: true }
}

export function publicApi() {
  return { version: 1, v2: 2 }
}
