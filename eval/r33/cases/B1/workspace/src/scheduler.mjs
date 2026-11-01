export function createScheduler(options = {}) {
  const tasks = []
  return {
    mode: 'memory',
    async enqueue(task) {
      tasks.push(task)
      return { queued: true }
    },
    async drain() {
      return tasks.splice(0, tasks.length)
    },
  }
}
