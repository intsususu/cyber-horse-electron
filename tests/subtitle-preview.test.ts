import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../src/shared/contracts'
import { defaultSubtitleStyle } from '../src/shared/subtitle-style'
import { SubtitlePreviewService } from '../src/main/services/subtitle-preview'
import type { ProcessRunner } from '../src/main/services/tool-process'

async function fixture(run?: ProcessRunner) {
  const root = await mkdtemp(join(tmpdir(), 'horse-preview-test-'))
  const tools = join(root, 'tools')
  await mkdir(tools)
  for (const name of ['ffmpeg', 'ffprobe'])
    await writeFile(join(tools, `${name}${process.platform === 'win32' ? '.exe' : ''}`), '')
  const settings = structuredClone(defaultSettings)
  settings.paths.whisper = root
  const calls: string[] = []
  const runner: ProcessRunner =
    run ??
    (async (request) => {
      calls.push(request.executable)
      expect(request.cwd.startsWith(join(root, 'subtitle-preview', 'clip-'))).toBe(true)
      if (request.executable.includes('ffmpeg')) {
        expect(request.args).toContain('ass=preview.ass')
        const ass = await readFile(join(request.cwd, 'preview.ass'), 'utf8')
        expect(ass).toContain('Style: Default,KaiTi,64,')
        expect(ass).toContain('0:00:11.00,0:00:15.00')
        expect(ass.match(/^Dialogue:/gm)).toHaveLength(4)
        await writeFile(join(request.cwd, 'preview.mp4'), Buffer.alloc(128))
        return { code: 0, stdout: '', stderr: '' }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          format: { duration: 15 },
          streams: [{ codec_type: 'video', width: 1280, height: 720 }],
        }),
      }
    })
  return { root, calls, service: new SubtitlePreviewService(root, async () => settings, runner) }
}
const request = () => ({
  id: randomUUID(),
  style: { ...defaultSubtitleStyle, fontName: 'KaiTi', fontSize: 64 },
})

describe('15 秒 ASS 预览', () => {
  it('使用草稿样式生成四句真实 ASS，校验产物并只清理本次文件', async () => {
    const { root, service, calls } = await fixture()
    const old = join(root, 'subtitle-preview', '历史残留')
    await mkdir(old, { recursive: true })
    await writeFile(join(old, '保留.txt'), '唯一副本')
    const result = await service.generate(request())
    expect(result.duration).toBe(15)
    expect(result.bytes.length).toBe(128)
    expect(calls).toHaveLength(2)
    expect(await readdir(join(root, 'subtitle-preview'))).toEqual(['历史残留'])
    expect(service.active).toBe(false)
  })

  it('拒绝工具路径注入及缺少预览工具，不调用进程', async () => {
    const root = await mkdtemp(join(tmpdir(), 'horse-preview-missing-'))
    const run = vi.fn<ProcessRunner>()
    const service = new SubtitlePreviewService(root, async () => defaultSettings, run)
    await expect(service.generate({ ...request(), path: 'C:/任意文件' } as never)).rejects.toThrow(
      '参数无效',
    )
    await expect(service.generate(request())).rejects.toThrow('未找到字幕预览工具')
    expect(run).not.toHaveBeenCalled()
  })

  it('重复启动互斥，旧取消标识不干扰当前任务，取消后清理并释放', async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const { service, root } = await fixture(async ({ signal }) => {
      started()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      return { code: 1, stdout: '', stderr: '' }
    })
    const input = request()
    const generating = service.generate(input)
    const failure = expect(generating).rejects.toThrow('已取消')
    await ready
    await expect(service.generate(request())).rejects.toThrow('正在生成')
    await service.cancel(randomUUID())
    expect(service.active).toBe(true)
    await service.cancel(input.id)
    await failure
    expect(service.active).toBe(false)
    expect(await readdir(join(root, 'subtitle-preview'))).toEqual([])
  })

  it.each(['生成失败', '错误时长', '超出大小'])('拒绝%s并清理产物', async (mode) => {
    const { service, root } = await fixture(async ({ executable, cwd }) => {
      if (executable.includes('ffmpeg')) {
        await writeFile(
          join(cwd, 'preview.mp4'),
          Buffer.alloc(mode === '超出大小' ? 16 * 1024 * 1024 + 1 : 128),
        )
        return { code: mode === '生成失败' ? 1 : 0, stdout: '', stderr: '' }
      }
      return { code: 0, stderr: '', stdout: '{"format":{"duration":3},"streams":[]}' }
    })
    await expect(service.generate(request())).rejects.toThrow(/失败|校验|大小/)
    expect(await readdir(join(root, 'subtitle-preview'))).toEqual([])
    expect(service.active).toBe(false)
  })
})
