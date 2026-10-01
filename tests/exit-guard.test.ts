import { describe, expect, it, vi } from 'vitest'
import { ExitGuard } from '../src/main/services/exit-guard'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(busy = false) {
  const answer = deferred<boolean>()
  const confirm = vi.fn(() => answer.promise)
  const stop = vi.fn(async () => {})
  const close = vi.fn()
  const failed = vi.fn()
  const beginStop = vi.fn()
  const guard = new ExitGuard(confirm, () => busy, stop, close, failed, beginStop)
  return { guard, answer, confirm, stop, close, failed, beginStop }
}
describe('退出确认', () => {
  it.each([false, true])('空闲或运行中取消不改变任务和计划（运行：%s）', async (busy) => {
    const f = fixture(busy)
    const request = f.guard.request()
    await f.guard.request()
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(busy)
    f.answer.resolve(false)
    await request
    expect(f.beginStop).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.close).not.toHaveBeenCalled()
    expect(await f.guard.runTask(() => '仍可启动')).toBe('仍可启动')
  })
  it('确认后拒绝新任务，等待迟到的启动与文件操作，然后收尾并关闭一次', async () => {
    const f = fixture()
    const pending = deferred<void>()
    const work = f.guard.runTask(() => pending.promise)
    const request = f.guard.request()
    expect(f.confirm).toHaveBeenCalledWith(true)
    f.answer.resolve(true)
    await vi.waitFor(() => expect(f.beginStop).toHaveBeenCalledOnce())
    await expect(f.guard.runTask(() => {})).rejects.toThrow('正在退出')
    expect(f.stop).not.toHaveBeenCalled()
    pending.resolve()
    await work
    await request
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.guard.approved).toBe(true)
    await f.guard.request()
    expect(f.close).toHaveBeenCalledOnce()
  })
  it('收尾失败保留窗口且不放行新任务，可以再次尝试退出', async () => {
    const f = fixture(true)
    f.stop.mockRejectedValueOnce(new Error('写入失败'))
    f.answer.resolve(true)
    await f.guard.request()
    expect(f.failed).toHaveBeenCalledOnce()
    expect(f.guard.approved).toBe(false)
    expect(f.close).not.toHaveBeenCalled()
    await expect(f.guard.runTask(() => {})).rejects.toThrow('正在退出')
    await f.guard.request()
    expect(f.close).toHaveBeenCalledOnce()
  })
})
