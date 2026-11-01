export function watchChanges({ fs, dir, onEvent, intervalMs = 5 }) {
  let seen = new Set(fs.readdir(dir))
  const timer = setInterval(() => {
    const next = new Set(fs.readdir(dir))
    for (const name of next) {
      if (!seen.has(name)) onEvent({ type: 'add', name })
    }
    seen = next
  }, intervalMs)
  timer.unref?.()
  return { close: () => clearInterval(timer) }
}
