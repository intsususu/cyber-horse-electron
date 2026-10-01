import { checkpoint, pathKey, overlap } from './safe-files'
import { acquireResource } from './task-resource-lease'

type Waiting = {
  signal: AbortSignal
  run: () => void
  reject: (error: Error) => void
  cancel: () => void
}
/** 文件级公平调度；MDC、传输各一个槽位，不限制 GPU 并发。 */
export class TaskScheduler {
  private queues = new Map<string, Waiting[]>()
  private occupied = new Set<string>()
  private claims = new Map<string, string[]>()

  claim(id: string, paths: string[], extend = false): () => void {
    const previous = this.claims.get(id)
    const keys = [...new Set([...(extend ? (previous ?? []) : []), ...paths.map(pathKey)])]
    for (const [owner, existing] of this.claims)
      if (owner !== id && keys.some((path) => existing.some((old) => overlap(old, path))))
        throw new Error('来源或发布目标已有任务占用，请等待结束或处理残留任务。')
    if (this.claims.has(id) && !extend) throw new Error('任务已经进入调度，不能重复启动。')
    this.claims.set(id, keys)
    return () => {
      if (extend && previous) this.claims.set(id, previous)
      else this.claims.delete(id)
    }
  }

  async use<T>(
    resource: 'mdc' | 'transfer',
    signal: AbortSignal,
    action: () => Promise<T>,
    directory?: string,
  ): Promise<T> {
    checkpoint(signal)
    await new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(resource) ?? []
      this.queues.set(resource, queue)
      const entry: Waiting = {
        signal,
        run: resolve,
        reject,
        cancel: () => {
          const index = queue.indexOf(entry)
          if (index >= 0) queue.splice(index, 1)
          signal.removeEventListener('abort', entry.cancel)
          reject(new Error('排队任务已取消。'))
        },
      }
      queue.push(entry)
      signal.addEventListener('abort', entry.cancel, { once: true })
      this.advance(resource)
    })
    let release: (() => Promise<void>) | undefined
    try {
      checkpoint(signal)
      if (directory) release = await acquireResource(directory, resource, signal)
      return await action()
    } finally {
      try {
        await release?.()
      } finally {
        this.occupied.delete(resource)
        this.advance(resource)
      }
    }
  }

  private advance(resource: string) {
    if (this.occupied.has(resource)) return
    const queue = this.queues.get(resource)!
    const entry = queue.shift()
    if (!entry) return
    entry.signal.removeEventListener('abort', entry.cancel)
    if (entry.signal.aborted) {
      entry.reject(new Error('排队任务已取消。'))
      this.advance(resource)
      return
    }
    this.occupied.add(resource)
    entry.run()
  }
}
