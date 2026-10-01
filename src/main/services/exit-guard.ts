/** 退出确认和收尾互斥；取消确认不停止任务或关机计划。 */
export class ExitGuard {
  private requesting = false
  private stopping = false
  private requests = new Set<Promise<unknown>>()
  approved = false

  constructor(
    private confirm: (busy: boolean) => Promise<boolean>,
    private busy: () => boolean,
    private stop: () => Promise<void>,
    private close: () => void,
    private failed: () => void,
    private beginStop: () => void,
  ) {}

  get pending() {
    return this.requests.size > 0
  }

  async runTask<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.stopping) throw new Error('应用正在退出，不能开始新的操作。')
    const work = Promise.resolve().then(action)
    this.requests.add(work)
    try {
      return await work
    } finally {
      this.requests.delete(work)
    }
  }

  async request(): Promise<void> {
    if (this.requesting || this.approved) return
    this.requesting = true
    try {
      if (!(await this.confirm(this.pending || this.busy()))) return
      this.stopping = true
      this.beginStop()
      // 等待已受理的预检、删除和保留操作落定，再停止所有执行器，避免迟到的启动。
      await Promise.allSettled([...this.requests])
      await this.stop()
      this.approved = true
      this.close()
    } catch {
      this.failed()
    } finally {
      this.requesting = false
    }
  }
}
