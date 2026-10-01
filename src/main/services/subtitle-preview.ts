import { lstat, mkdir, mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Settings } from '../../shared/contracts'
import {
  subtitlePreviewCues,
  subtitlePreviewRequestSchema,
  type SubtitlePreviewRequest,
  type SubtitlePreviewResult,
} from '../../shared/subtitle-preview'
import { srtToAss } from './subtitles'
import { runTool, type ProcessRunner } from './tool-process'

export class SubtitlePreviewService {
  private job: { id: string; controller: AbortController; done: Promise<void> } | null = null

  constructor(
    private readonly userData: string,
    private readonly readSettings: () => Promise<Settings>,
    private readonly run: ProcessRunner = runTool,
  ) {}

  get active(): boolean {
    return this.job !== null
  }

  async cancel(id: string): Promise<void> {
    if (this.job?.id !== id) return
    await this.stop()
  }

  async stop(): Promise<void> {
    const job = this.job
    job?.controller.abort()
    await job?.done
  }

  async generate(input: SubtitlePreviewRequest): Promise<SubtitlePreviewResult> {
    const parsed = subtitlePreviewRequestSchema.safeParse(input)
    if (!parsed.success) throw new Error('字幕预览参数无效，请检查字体设置。')
    if (this.job) throw new Error('字幕预览正在生成，请稍候再试。')
    const controller = new AbortController()
    let finish!: () => void
    this.job = {
      id: parsed.data.id,
      controller,
      done: new Promise((resolve) => {
        finish = resolve
      }),
    }
    let directory: string | undefined
    const checkCancelled = () => {
      if (controller.signal.aborted) throw new Error('字幕预览已取消。')
    }
    try {
      const settings = await this.readSettings()
      checkCancelled()
      const tools = await this.findTools(settings)
      checkCancelled()
      const root = join(this.userData, 'subtitle-preview')
      if (!isAbsolute(root)) throw new Error('字幕预览缓存路径无效。')
      await mkdir(root, { recursive: true })
      const rootInfo = await lstat(root)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error('字幕预览缓存目录不能是链接。')
      directory = await mkdtemp(join(root, 'clip-'))
      await writeFile(
        join(directory, 'preview.ass'),
        srtToAss(subtitlePreviewCues, parsed.data.style),
        { flag: 'wx' },
      )
      checkCancelled()
      const rendered = await this.run({
        executable: tools.ffmpeg,
        args: [
          '-hide_banner',
          '-nostdin',
          '-n',
          '-filter_threads',
          '2',
          '-f',
          'lavfi',
          '-i',
          'gradients=size=1280x720:rate=24:duration=15:c0=0x20384b:c1=0xa5b5a3:seed=42:speed=0.04',
          '-vf',
          'ass=preview.ass',
          '-t',
          '15',
          '-an',
          '-c:v',
          'libx264',
          '-threads',
          '2',
          '-preset',
          'ultrafast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          'preview.mp4',
        ],
        cwd: directory,
        signal: controller.signal,
        timeoutMs: 60000,
        captureLimit: 32768,
      })
      checkCancelled()
      if (rendered.code !== 0)
        throw new Error('字幕预览生成失败，请确认 FFmpeg 支持 ASS 字幕、渐变画面和 H.264 编码。')
      const output = join(directory, 'preview.mp4')
      const info = await lstat(output)
      if (!info.isFile() || info.isSymbolicLink() || info.size < 32 || info.size > 16 * 1024 * 1024)
        throw new Error('字幕预览视频无效或超过大小限制。')
      const probe = await this.run({
        executable: tools.ffprobe,
        args: [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_type,width,height',
          '-of',
          'json',
          'preview.mp4',
        ],
        cwd: directory,
        signal: controller.signal,
        timeoutMs: 10000,
        captureLimit: 32768,
      })
      checkCancelled()
      let valid = false
      try {
        const metadata = JSON.parse(probe.stdout)
        valid =
          probe.code === 0 &&
          Math.abs(Number(metadata.format?.duration) - 15) < 0.1 &&
          metadata.streams?.some(
            (stream: { codec_type: string; width: number; height: number }) =>
              stream.codec_type === 'video' && stream.width === 1280 && stream.height === 720,
          )
      } catch {
        /* 无效输出统一显示中文错误。 */
      }
      if (!valid) throw new Error('字幕预览视频未通过时长和画面校验。')
      const bytes = await readFile(output)
      checkCancelled()
      return { bytes, duration: 15 }
    } catch (cause) {
      checkCancelled()
      if (cause instanceof Error && /[\u4e00-\u9fff]/.test(cause.message)) throw cause
      throw new Error('字幕预览生成失败，请检查工具是否可运行，以及应用缓存目录是否可写。')
    } finally {
      // 只清理本次创建目录内的两个固定产物，不递归删除目录或历史残留。
      if (directory) {
        await Promise.all(
          ['preview.ass', 'preview.mp4'].map((name) =>
            unlink(join(directory!, name)).catch(() => undefined),
          ),
        )
        await rmdir(directory).catch(() => undefined)
      }
      this.job = null
      finish()
    }
  }

  private async findTools(settings: Settings): Promise<{ ffmpeg: string; ffprobe: string }> {
    const extension = process.platform === 'win32' ? '.exe' : ''
    for (const key of ['jasna', 'whisper', 'mkvmerge'] as const) {
      const configured = settings.paths[key]
      if (!configured || !isAbsolute(configured)) continue
      const info = await stat(configured).catch(() => null)
      if (!info) continue
      const base = info.isDirectory() ? configured : dirname(configured)
      for (const subdirectory of ['', 'tools', 'bin']) {
        const ffmpeg = join(base, subdirectory, `ffmpeg${extension}`)
        const ffprobe = join(base, subdirectory, `ffprobe${extension}`)
        const entries = await Promise.all(
          [ffmpeg, ffprobe].map((file) => stat(file).catch(() => null)),
        )
        if (entries.every((entry) => entry?.isFile())) return { ffmpeg, ffprobe }
      }
    }
    throw new Error(
      '未找到字幕预览工具。请在已保存的 Jasna、Whisper 或 MKVToolNix 目录（或 tools、bin 子目录）放置 FFmpeg 和 ffprobe。',
    )
  }
}
