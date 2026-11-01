export function createScheduler(options = {}) {
  const tasks = []
  return {
    mode: 'outbox',
    async enqueue(task) {
      if (options.storage?.append !== undefined) await options.storage.append(task)
      tasks.push(task)
      return { queued: true, durable: options.storage?.append !== undefined }
    },
    async drain() {
      return tasks.splice(0, tasks.length)
    },
  }
}
