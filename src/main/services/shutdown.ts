import { execFile, type ExecFileOptions } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import {
  shutdownRequestSchema,
  type ShutdownRequest,
  type ShutdownState,
} from '../../shared/shutdown'

export type ShutdownQueue = {
  busy: boolean
  hasTasks: boolean
  awaitingConfirmation: boolean
  failedTaskIds?: string[]
}
export type ShutdownAdapter = { supported: boolean; testMode: boolean; execute(): Promise<void> }

/** 倒计时留在应用内，最后才请求系统关机，避免系统延时关机隐含强制关闭应用。 */
export function windowsShutdownAdapter(
  platform = process.platform,
  windowsDirectory = process.env.SystemRoot,
  run: (file: string, args: string[], options: ExecFileOptions) => Promise<unknown> = promisify(
    execFile,
  ),
): ShutdownAdapter {
  const supported = platform === 'win32' && !!windowsDirectory && isAbsolute(windowsDirectory)
  return {
    supported,
    testMode: false,
    async execute() {
      if (!supported) throw new Error('当前系统不支持关机。')
      await run(join(windowsDirectory!, 'System32', 'shutdown.exe'), ['/s', '/t', '0'], {
        shell: false,
        windowsHide: true,
        timeout: 10000,
      })
    },
  }
}

/** 会话内计划；任务失败也视为结束，但收尾和文件保护工作必须先完成。 */
export class ShutdownService {
  private phase: ShutdownState['phase'] = 'idle'
  private mode: ShutdownRequest['mode'] | null = null
  private deadline: number | null = null
  private observedTask = false
  private existingFailures = new Set<string>()
  private starting = 0
  private timer?: ReturnType<typeof setInterval>
  private message = '尚未设置关机计划。'

  constructor(
    private queue: () => ShutdownQueue,
    private adapter: ShutdownAdapter,
    private now = () => Date.now(),
  ) {}

  snapshot(): ShutdownState {
    return {
      phase: this.phase,
      mode: this.mode,
      remainingSeconds:
        this.deadline === null ? null : Math.max(0, Math.ceil((this.deadline - this.now()) / 1000)),
      message: this.message,
      supported: this.adapter.supported,
      testMode: this.adapter.testMode,
    }
  }

  start(value: ShutdownRequest): ShutdownState {
    const request = shutdownRequestSchema.parse(value)
    if (!this.adapter.supported) throw new Error('当前系统不支持关机。')
    if (['waiting', 'countdown', 'executing', 'requested'].includes(this.phase))
      throw new Error('已有关机计划，请先取消。')
    const queue = this.queue()
    this.mode = request.mode
    this.observedTask = queue.hasTasks
    this.existingFailures = new Set(queue.failedTaskIds)
    this.deadline = request.mode === 'timer' ? this.now() + request.minutes * 60000 : null
    this.phase = request.mode === 'timer' ? 'countdown' : 'waiting'
    this.message =
      request.mode === 'timer' ? '已开启定时关机。' : '等待所有任务结束（包含失败和取消）。'
    this.timer = setInterval(() => void this.tick(), 250)
    this.timer.unref()
    return this.snapshot()
  }

  cancel(): ShutdownState {
    if (['executing', 'requested'].includes(this.phase))
      throw new Error('已向系统提交关机请求，无法在应用内取消。')
    this.clearTimer()
    this.phase = 'idle'
    this.mode = null
    this.deadline = null
    this.observedTask = false
    this.message = '已取消关机计划。'
    return this.snapshot()
  }

  /** 从请求开始保护异步预检窗口；只在启动成功后记为本次任务。 */
  async runTask<T>(action: () => T | Promise<T>): Promise<T> {
    if (['executing', 'requested'].includes(this.phase))
      throw new Error('正在关机，不能启动新任务。')
    this.starting++
    if (this.mode === 'tasks' && this.phase === 'countdown') {
      this.phase = 'waiting'
      this.deadline = null
      this.message = '有新任务加入，继续等待所有任务结束。'
    }
    try {
      const result = await action()
      if (['waiting', 'countdown'].includes(this.phase)) this.observedTask = true
      return result
    } finally {
      this.starting--
      await this.tick()
    }
  }

  async tick(): Promise<void> {
    if (!['waiting', 'countdown'].includes(this.phase)) return
    try {
      const queue = this.queue()
      if (
        this.mode === 'timer' &&
        queue.failedTaskIds?.some((id) => !this.existingFailures.has(id))
      )
        throw new Error('任务失败，已取消此次定时关机。')
      if (queue.hasTasks) this.observedTask = true
      const blocked = queue.busy || queue.awaitingConfirmation || this.starting > 0
      if (this.mode === 'tasks') {
        if (blocked || !this.observedTask) {
          this.phase = 'waiting'
          this.deadline = null
          this.message = queue.awaitingConfirmation
            ? '任务仍待用户确认收尾，暂不关机。'
            : this.observedTask
              ? '等待所有任务结束（包含失败和取消）。'
              : '当前没有任务，等待任务启动并结束。'
          return
        }
        if (this.phase === 'waiting') {
          this.phase = 'countdown'
          this.deadline = this.now() + 60000
          this.message = '所有任务已结束（包含失败和取消），将在 60 秒后关机。'
        }
      }
      if (this.deadline === null || this.now() < this.deadline) return
      if (blocked) throw new Error('仍有任务执行或待确认，已取消此次定时关机。')
      // 同一主进程回合冻结新启动请求，避免最后一次复核后有任务进入队列。
      this.phase = 'executing'
      this.deadline = null
      this.clearTimer()
      this.message = '正在向系统提交关机请求。'
      await this.adapter.execute()
      this.phase = 'requested'
      this.message = this.adapter.testMode
        ? '关机替身已收到请求，未执行系统关机。'
        : '已向系统提交关机请求。'
    } catch (error) {
      this.clearTimer()
      this.phase = 'failed'
      this.deadline = null
      this.message =
        error instanceof Error &&
        (error.message.startsWith('仍有任务') || error.message.startsWith('任务失败'))
          ? error.message
          : '关机请求失败，已停止计划；请检查系统权限后重新设置。'
    }
  }

  stop(): void {
    this.clearTimer()
    if (!['executing', 'requested'].includes(this.phase)) this.cancel()
  }
  private clearTimer() {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
