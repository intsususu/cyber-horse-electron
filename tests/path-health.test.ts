import { access, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkPaths } from '../src/main/services/path-health'
import { defaultSettings } from '../src/shared/contracts'

vi.mock('node:fs/promises', () => ({ access: vi.fn(), stat: vi.fn() }))

describe('环境检测的读取与超时边界', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(access).mockReset()
    vi.mocked(stat).mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('慢速网络目录超时不影响其他项，迟到的读取不会改写结果', async () => {
    let finish!: () => void
    vi.mocked(access).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
      ReturnType<typeof stat>
    >)
    const checking = checkPaths({
      ...defaultSettings,
      paths: { ...defaultSettings.paths, nas: resolve('网络目录') },
    })
    await vi.advanceTimersByTimeAsync(5000)
    const result = await checking
    expect(result.find((item) => item.key === 'nas')).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('超时'),
    })
    expect(result.filter((item) => item.status === 'unconfigured')).toHaveLength(9)
    finish()
    await vi.runAllTimersAsync()
    expect(result.find((item) => item.key === 'nas')?.status).toBe('unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('读取失败不宣称可用，并清理超时计时器', async () => {
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('拒绝读取'), { code: 'EACCES' }))
    const result = await checkPaths({
      ...defaultSettings,
      paths: { ...defaultSettings.paths, mdc: resolve('工具.exe') },
    })
    expect(result.find((item) => item.key === 'mdc')).toMatchObject({
      status: 'missing',
      message: '路径不存在或无读取权限',
    })
    expect(stat).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('可读取入口只报告路径结果，不宣称工具运行通过', async () => {
    vi.mocked(access).mockResolvedValue(undefined)
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>)
    const result = await checkPaths({
      ...defaultSettings,
      paths: { ...defaultSettings.paths, mdc: resolve('工具入口.txt') },
    })
    expect(result.find((item) => item.key === 'mdc')).toMatchObject({
      status: 'ready',
      message: '入口文件可读取',
    })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('Whisper 源码目录需同时具有入口脚本和虚拟环境', async () => {
    vi.mocked(access).mockResolvedValue(undefined)
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
      ReturnType<typeof stat>
    >)
    const path = resolve('Whisper源码')
    const result = await checkPaths({
      ...defaultSettings,
      paths: { ...defaultSettings.paths, whisper: path },
    })
    expect(result.find((item) => item.key === 'whisper')).toMatchObject({
      status: 'ready',
      message: expect.stringContaining('运行环境待预览检测'),
    })
    expect(access).toHaveBeenCalledTimes(3)
  })
})
