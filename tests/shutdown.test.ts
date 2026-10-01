import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ShutdownService,
  windowsShutdownAdapter,
  type ShutdownQueue,
} from '../src/main/services/shutdown'
import { shutdownRequestSchema } from '../src/shared/shutdown'

afterEach(() => vi.useRealTimers())

function fixture(initial: Partial<ShutdownQueue> = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T00:00:00Z'))
  const queue = { busy: false, hasTasks: false, awaitingConfirmation: false, ...initial }
  const execute = vi.fn(async () => {})
  const service = new ShutdownService(() => queue, { supported: true, testMode: true, execute })
  return { queue, execute, service }
}

describe('定时关机和全部任务结束关机', () => {
  it('倒计时由主进程维护，到期只提交一次系统请求', async () => {
    const { service, execute } = fixture()
    expect(service.start({ mode: 'timer', minutes: 1 }).remainingSeconds).toBe(60)
    await vi.advanceTimersByTimeAsync(59000)
    expect(execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    await service.tick()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(service.snapshot().phase).toBe('requested')
    await expect(service.runTask(() => true)).rejects.toThrow('正在关机')
  })

  it('全部任务模式在空队列和历史失败记录下等待新任务，不立即关机', async () => {
    const { service, execute } = fixture()
    service.start({ mode: 'tasks' })
    await vi.advanceTimersByTimeAsync(120000)
    expect(service.snapshot()).toMatchObject({ phase: 'waiting', remainingSeconds: null })
    expect(execute).not.toHaveBeenCalled()
    service.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('排队、运行和取消收尾期间不触发；最后任务失败也启动 60 秒倒计时', async () => {
    const { service, queue, execute } = fixture({ busy: true, hasTasks: true })
    service.start({ mode: 'tasks' })
    await vi.advanceTimersByTimeAsync(90000)
    // 队列状态已结束，但执行器仍在保存记录或清理临时文件。
    queue.hasTasks = false
    await vi.advanceTimersByTimeAsync(90000)
    expect(service.snapshot().phase).toBe('waiting')
    expect(execute).not.toHaveBeenCalled()
    queue.busy = false
    await service.tick()
    expect(service.snapshot()).toMatchObject({ phase: 'countdown', remainingSeconds: 60 })
    await vi.advanceTimersByTimeAsync(60000)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('快速失败任务即使短于轮询间隔也被观察到，失败启动请求不算任务', async () => {
    const { service, execute } = fixture()
    service.start({ mode: 'tasks' })
    await expect(
      service.runTask(() => {
        throw new Error('预检不通过')
      }),
    ).rejects.toThrow('预检不通过')
    expect(service.snapshot().phase).toBe('waiting')
    await service.runTask(() => ({ status: 'failed' }))
    expect(service.snapshot().phase).toBe('countdown')
    await vi.advanceTimersByTimeAsync(60000)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('新任务加入会撤回旧倒计时，包括在一个轮询间隔内结束的任务', async () => {
    const { service, execute } = fixture()
    service.start({ mode: 'tasks' })
    await service.runTask(() => true)
    await vi.advanceTimersByTimeAsync(59000)
    await service.runTask(() => true)
    expect(service.snapshot().remainingSeconds).toBe(60)
    await vi.advanceTimersByTimeAsync(59000)
    expect(execute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('异步启动预检保护最后复核窗口，不能在任务创建前关机', async () => {
    const { service, execute } = fixture()
    service.start({ mode: 'tasks' })
    await service.runTask(() => true)
    await vi.advanceTimersByTimeAsync(59000)
    let finish!: () => void
    const pending = service.runTask(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await vi.advanceTimersByTimeAsync(90000)
    expect(execute).not.toHaveBeenCalled()
    finish()
    await pending
    expect(service.snapshot()).toMatchObject({ phase: 'countdown', remainingSeconds: 60 })
    service.stop()
  })

  it('待用户确认收尾阻止触发，确认后才重新倒计时', async () => {
    const { service, queue, execute } = fixture({ hasTasks: true, busy: true })
    service.start({ mode: 'tasks' })
    queue.hasTasks = false
    queue.busy = false
    queue.awaitingConfirmation = true
    await vi.advanceTimersByTimeAsync(120000)
    expect(service.snapshot().message).toContain('待用户确认')
    expect(execute).not.toHaveBeenCalled()
    queue.awaitingConfirmation = false
    await service.tick()
    expect(service.snapshot().remainingSeconds).toBe(60)
    service.stop()
  })

  it.each(['busy', 'awaitingConfirmation'] as const)(
    '按时间模式到期仍有 %s 时取消关机',
    async (key) => {
      const { service, queue, execute } = fixture()
      service.start({ mode: 'timer', minutes: 1 })
      queue[key] = true
      await vi.advanceTimersByTimeAsync(60000)
      expect(service.snapshot().phase).toBe('failed')
      expect(execute).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(['timer', 'tasks'] as const)(
    '取消或关闭应用会清除 %s 计划，重复启动被拒绝',
    async (mode) => {
      const { service, execute } = fixture({ hasTasks: true })
      const request = mode === 'timer' ? { mode, minutes: 1 } : { mode }
      service.start(request)
      expect(() => service.start(request)).toThrow('已有关机计划')
      service.cancel()
      expect(service.snapshot().phase).toBe('idle')
      service.start(request)
      service.stop()
      await vi.advanceTimersByTimeAsync(120000)
      expect(execute).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('系统拒绝或状态读取异常停止计划，不自动重试', async () => {
    const { service, execute } = fixture()
    execute.mockRejectedValueOnce(new Error('系统权限不足'))
    service.start({ mode: 'timer', minutes: 1 })
    await vi.advanceTimersByTimeAsync(120000)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(service.snapshot().phase).toBe('failed')
    expect(vi.getTimerCount()).toBe(0)
    const broken = new ShutdownService(
      () => {
        throw new Error('状态不可用')
      },
      { supported: true, testMode: true, execute },
    )
    expect(() => broken.start({ mode: 'tasks' })).toThrow('状态不可用')
    expect(broken.snapshot().phase).toBe('idle')
  })

  it('时间模式遇到新任务失败默认取消，历史失败不影响本次计划', async () => {
    const { service, queue, execute } = fixture({ failedTaskIds: ['历史失败'] })
    service.start({ mode: 'timer', minutes: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(service.snapshot().phase).toBe('countdown')
    queue.failedTaskIds = ['历史失败', '本次失败']
    await service.tick()
    expect(service.snapshot()).toMatchObject({
      phase: 'failed',
      message: '任务失败，已取消此次定时关机。',
    })
    await vi.advanceTimersByTimeAsync(60000)
    expect(execute).not.toHaveBeenCalled()
    service.start({ mode: 'tasks' })
    await service.runTask(() => true)
    queue.failedTaskIds.push('明确允许的失败')
    await vi.advanceTimersByTimeAsync(60000)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('Windows 适配器固定系统程序和参数，不使用 shell 或强制关闭', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const adapter = windowsShutdownAdapter('win32', 'C:\\Windows', run)
    await adapter.execute()
    expect(run).toHaveBeenCalledWith(
      expect.stringMatching(/Windows[\\/]System32[\\/]shutdown.exe$/),
      ['/s', '/t', '0'],
      { shell: false, windowsHide: true, timeout: 10000 },
    )
    const unsupported = windowsShutdownAdapter('linux', undefined, run)
    await expect(unsupported.execute()).rejects.toThrow('不支持')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('拒绝任意参数、无效时长和不支持的平台', () => {
    for (const value of [
      { mode: 'timer', minutes: 0 },
      { mode: 'timer', minutes: 721 },
      { mode: 'timer', minutes: 1.5 },
      { mode: 'tasks', minutes: 1 },
      { mode: 'tasks', command: 'shutdown' },
      { mode: 'other' },
    ])
      expect(shutdownRequestSchema.safeParse(value).success).toBe(false)
    const service = new ShutdownService(
      () => ({ busy: false, hasTasks: false, awaitingConfirmation: false }),
      { supported: false, testMode: false, execute: async () => {} },
    )
    expect(() => service.start({ mode: 'tasks' })).toThrow('不支持')
  })
})
