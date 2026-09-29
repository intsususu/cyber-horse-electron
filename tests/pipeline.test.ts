import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, parse, resolve, sep } from 'node:path'
import { defaultSettings } from '../src/shared/contracts'
import { pipelinePreviewSchema, type PipelineStep } from '../src/shared/pipeline'
import { PipelineService } from '../src/main/services/pipeline'
import { PipelineTools } from '../src/main/services/pipeline-tools'
import { ExecutionLock } from '../src/main/services/execution-lock'
import { PreparationService } from '../src/main/services/preparation'
import { collectMediaInputs } from '../src/main/services/media-inputs'
import { type ProcessRequest, type ProcessRunner } from '../src/main/services/tool-process'
import { parseSrt, srtToAss } from '../src/main/services/subtitles'
import { emptyRun, isRunning, runReducer } from '../src/renderer/src/lib/workflow'

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }))
const temporary: string[] = []
const subtitle = '1\n00:00:00,500 --> 00:00:01,500\n中文测试字幕\n'
const help =
  '--sub_formats --audio_suffixes --device --identify --output --input --post-export-action --post-export-video-command --cli --config-override --local-config-file -show_format -show_streams'
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'horse-pipeline-')))
  temporary.push(root)
  const settings = structuredClone(defaultSettings)
  for (const key of [
    'download',
    'preprocess',
    'whisperOutput',
    'videoOutput',
    'mdcOutput',
    'nas',
  ] as const) {
    settings.paths[key] = join(root, key)
    await fs.mkdir(settings.paths[key])
  }
  for (const key of ['whisper', 'jasna', 'mdc', 'mkvmerge'] as const) {
    settings.paths[key] = join(root, `${key}.exe`)
    await fs.writeFile(settings.paths[key], '仅供测试的工具标记')
  }
  const source = join(settings.paths.preprocess, 'ABC-123.mp4')
  await fs.writeFile(
    join(root, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
    '校验工具替身',
  )
  await fs.writeFile(source, '隔离的媒体替身')
  const calls: ProcessRequest[] = []
  let mode = ''
  let observe: ((request: ProcessRequest) => void) | undefined
  const runner: ProcessRunner = async (request) => {
    calls.push(request)
    const { args } = request
    const value = (flag: string) => args[args.indexOf(flag) + 1]!
    const success = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (args.includes('--help')) return success(help)
    observe?.(request)
    if (args.includes('-show_format'))
      return success(
        JSON.stringify({
          format: { duration: mode === '短片' && args.at(-1)!.includes('.partial') ? '1' : '10' },
        }),
      )
    if (mode === '挂起') {
      await new Promise<void>((_, reject) =>
        request.signal.addEventListener('abort', () => reject(new Error('任务已取消。')), {
          once: true,
        }),
      )
    }
    if (args.includes('-J')) {
      const output = args.at(-1)!
      return success(
        JSON.stringify({
          container: {
            recognized: true,
            supported: true,
            properties: { duration: mode === '短片' && output.includes('.partial') ? 1e9 : 10e9 },
          },
          tracks: [
            { type: 'video' },
            { type: 'audio' },
            ...(/-(?:C|UC)/.test(output) && !output.endsWith('.jasna.mkv') && mode !== '缺字幕轨'
              ? [{ type: 'subtitles', properties: { language: 'chi' } }]
              : []),
          ],
        }),
      )
    }
    if (mode === '工具失败') return { code: 4, stdout: '', stderr: '测试失败' }
    if (mode === 'CUDA 缺失' && args.includes('--sub_formats'))
      return {
        code: 1,
        stdout: '',
        stderr: 'RuntimeError: Library cublas64_12.dll is not found or cannot be loaded',
      }
    if (mode === 'Python 不可访问' && args.includes('--sub_formats'))
      return { code: 103, stdout: '', stderr: 'No Python at \u0027"Z:\\不可访问\\python.exe\u0027' }
    if (mode === 'Whisper 编码失败' && args.includes('--sub_formats'))
      return {
        code: 1,
        stdout: '',
        stderr: "UnicodeEncodeError: 'gbk' codec can't encode character '\\u26a0' in position 0",
      }
    if (args.includes('--sub_formats')) {
      const input = args.at(-1)!
      await fs.writeFile(
        join(dirname(input), basename(input, extname(input)) + '.srt'),
        mode === '坏字幕' ? 'invalid' : subtitle,
      )
    } else if (args.includes('-o')) {
      expect(args).toContain('--gui-mode')
      await fs.copyFile(value('--no-subtitles'), value('-o'))
    } else if (args.includes('--input')) {
      expect(value('--post-export-action')).toBe('none')
      expect(value('--post-export-video-command')).toBe('')
      await fs.copyFile(value('--input'), value('--output'))
    } else if (args.includes('-cli')) {
      expect(args.some((arg) => arg.startsWith('common:source_folders=['))).toBe(true)
      const selectedInput = args[1]!
      const inputDirectory = dirname(selectedInput)
      expect(args).not.toContain('-p')
      const output = args.find((arg) => arg.startsWith('common:success_folder='))!.split('=')[1]!
      const video = basename(selectedInput)
      const stem = basename(video, extname(video))
      const number = stem.replace(/-(?:UC|U|C)(?:_\d+)?$/i, '').replace(/_\d+$/, '')
      const mediaOutput = mode === 'MDC 分层目录' ? join(output, '演员', number) : output
      await fs.mkdir(mediaOutput, { recursive: true })
      const names = (await fs.readdir(inputDirectory)).filter(
        (name) => name === video || (name.startsWith(stem + '.') && !/\.(mp4|mkv)$/.test(name)),
      )
      for (const name of names)
        await fs.copyFile(join(inputDirectory, name), join(mediaOutput, name))
      if (mode === 'MDC 移动') await fs.unlink(selectedInput)
      if (mode === '缺元数据') return success()
      const tags = [
        /-(?:C|UC)(?:_\d+)?$/i.test(stem) ? '<tag>中文字幕</tag>' : '',
        /-(?:U|UC|hack)(?:_\d+)?$/i.test(stem) ? '<tag>破解</tag>' : '',
      ].join('')
      await fs.writeFile(
        join(mediaOutput, basename(video, extname(video)) + '.nfo'),
        mode === '坏元数据'
          ? '<movie></movie>'
          : `<movie><title>测试</title>${mode === 'MDC丢标签' ? '' : tags}</movie>`,
      )
      await fs.writeFile(join(mediaOutput, 'poster.jpg'), '封面替身')
      if (mode === 'MDC改视频') await fs.writeFile(join(mediaOutput, video), '意外变化')
      if (mode === 'MDC丢标记') {
        await fs.rename(join(mediaOutput, video), join(mediaOutput, number + extname(video)))
        await fs.rename(join(mediaOutput, stem + '.nfo'), join(mediaOutput, number + '.nfo'))
      }
    }
    request.onLine?.('测试输出 token=不能写入日志', false)
    return success()
  }
  const lock = new ExecutionLock()
  const service = new PipelineService(join(root, '应用数据'), [], new PipelineTools(runner), lock)
  const preview = (
    steps: PipelineStep[],
    selection: { mode: 'all' } | { mode: 'selected'; relativePaths: string[] } = { mode: 'all' },
  ) =>
    service.preview(
      settings,
      { steps, source: 'preprocess', recursive: true, selection },
      settings.paths.preprocess,
    )
  const start = async (steps: PipelineStep[]) => {
    const plan = await preview(steps)
    await service.start(plan.id, settings, settings.paths.preprocess)
    await service.wait()
    return service.snapshot()!
  }
  return {
    root,
    settings,
    source,
    service,
    preview,
    start,
    calls,
    lock,
    observe: (callback: (request: ProcessRequest) => void) => {
      observe = callback
    },
    mode: (value: string) => {
      mode = value
    },
  }
}
async function sourceWhisperFixture(root: string): Promise<string> {
  const directory = join(root, 'Whisper源码')
  const packageDirectory = join(directory, 'src', 'faster_whisper_transwithai_chickenrice')
  const pythonDirectory = join(directory, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
  await fs.mkdir(packageDirectory, { recursive: true })
  await fs.mkdir(pythonDirectory, { recursive: true })
  await fs.mkdir(join(directory, 'models'))
  for (const path of [
    join(directory, 'infer.py'),
    join(directory, 'generation_config.json5'),
    join(packageDirectory, 'infer.py'),
    join(directory, 'models', 'config.json'),
    join(directory, 'models', 'model.bin'),
    join(directory, 'models', 'whisper_vad.onnx'),
    join(directory, 'models', 'whisper_vad_metadata.json'),
    join(pythonDirectory, process.platform === 'win32' ? 'python.exe' : 'python'),
  ])
    await fs.writeFile(path, '隔离的源码与模型标记')
  return directory
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of temporary.splice(0)) {
    if (
      !resolve(root).startsWith((await fs.realpath(tmpdir())) + sep) ||
      !parse(root).base.startsWith('horse-pipeline-')
    )
      throw new Error('测试目录越界')
    await fs.rm(root, { recursive: true, force: true })
  }
})
describe('四步处理与文件保护', () => {
  it('取消后丢弃迟到工具进度，并保留停止位置与源文件', async () => {
    const f = await fixture()
    let late: ProcessRequest['onLine']
    f.observe((request) => {
      if (!request.args.includes('--input')) return
      late = request.onLine
      request.onLine?.('Processing video: 42%|####|', true)
      f.mode('挂起')
      queueMicrotask(() => f.service.cancel())
    })
    const result = await f.start(['video'])
    expect(result.status).toBe('cancelled')
    expect(result.tasks[0]!.current).toEqual({ phase: 'restore', percent: 42 })
    late?.('Processing video: 100%|####|', true)
    expect(f.service.snapshot()!.tasks).toEqual(result.tasks)
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('工具进度透传到状态；阶段完成不增加文件数，下一文件重新等待真实进度', async () => {
    const f = await fixture()
    await fs.writeFile(join(f.settings.paths.preprocess, 'DEF-456.mp4'), '第二个媒体替身')
    const starts: (number | null | undefined)[] = []
    f.observe((request) => {
      if (request.args.includes('--sub_formats')) {
        const task = f.service.snapshot()!.tasks[0]!
        starts.push(task.current?.percent)
        expect(task.current?.phase).toBe('transcribe')
        request.onLine?.('VAD进度：1/4 块（25.0%）在 cuda 上', false)
        expect(f.service.snapshot()!.tasks[0]!.current).toEqual({ phase: 'vad', percent: 25 })
        request.onLine?.('[00:00.00 --> 00:05.00] 中文识别内容', true)
        const during = f.service.snapshot()!.tasks[0]!
        expect(during.current).toEqual({ phase: 'transcribe', percent: 50, approximate: true })
        expect(during.completed).toBe(starts.length - 1)
        expect(during.status).toBe('running')
      }
      if (request.args.includes('-o')) {
        request.onLine?.('#GUI#progress 100%', false)
        expect(f.service.snapshot()!.tasks[0]!.status).toBe('running')
        expect(f.service.snapshot()!.tasks[0]!.completed).toBe(starts.length - 1)
      }
    })
    const result = await f.start(['subtitle-mux'])
    expect(result.status, result.message).toBe('succeeded')
    expect(starts).toEqual([null, null])
    expect(result.tasks[0]!.current).toBeUndefined()
    expect(result.tasks[0]!.completed).toBe(2)
    expect(result.logs.some((entry) => entry.text.includes('中文识别内容'))).toBe(false)
  })
  it('Jasna 报告 100% 后校验失败仍失败且保留原文件', async () => {
    const f = await fixture()
    f.mode('短片')
    f.observe((request) => {
      if (request.args.includes('--input')) {
        request.onLine?.(
          'Processing video: 100%|###|Processed: 1:23 (250f) | Remaining: 0:00 | Speed: 35.0fps',
          true,
        )
        const task = f.service.snapshot()!.tasks[0]!
        expect(task.current).toEqual({ phase: 'restore', percent: 100, fps: 35, etaSeconds: 0 })
        expect(task.completed).toBe(0)
        expect(task.status).toBe('running')
      }
    })
    const result = await f.start(['video'])
    expect(result.status).toBe('failed')
    expect(result.tasks[0]!.current).toEqual({ phase: 'validate', percent: null })
    expect(result.tasks[0]!.completed).toBe(0)
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('保留重名编号和字幕标记，视频单步后配套文件跟随新名称', async () => {
    const f = await fixture()
    await fs.rename(f.source, join(f.settings.paths.preprocess, 'ABC-123-C_1.mkv'))
    await fs.writeFile(join(f.settings.paths.preprocess, 'ABC-123-C_1.srt'), subtitle)
    const result = await f.start(['video'])
    expect(result.status, result.message).toBe('succeeded')
    expect(await fs.readFile(join(f.settings.paths.preprocess, 'ABC-123-UC_1.srt'), 'utf8')).toBe(
      subtitle,
    )
    const plan = await f.preview(['archive'])
    expect(plan.relatedFiles[0]!.files).toContain(
      join(f.settings.paths.preprocess, 'ABC-123-UC_1.srt'),
    )
  })
  it('固定顺序直接处理原文件，成功后清理本地文件，NAS 不含生成的 ASS 旁车', async () => {
    const f = await fixture()
    f.settings.subtitle.format = 'ass'
    const result = await f.start(['archive', 'scrape', 'video', 'subtitle-mux'])
    expect(result.status, result.message).toBe('succeeded')
    expect(result.tasks.map((task) => task.id)).toEqual([
      'subtitle-mux',
      'video',
      'scrape',
      'archive',
    ])
    expect(result.tasks.every((task) => task.progress === 100)).toBe(true)
    const target = join(f.settings.paths.nas, 'ABC-123')
    expect(await fs.readFile(join(target, 'ABC-123-UC.mkv'), 'utf8')).toBe('隔离的媒体替身')
    expect((await fs.readdir(target)).some((name) => name.endsWith('.ass'))).toBe(false)
    await expect(fs.stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.calls.some((call) => call.args.includes(f.source))).toBe(true)
    expect(await fs.readdir(f.settings.paths.preprocess)).toEqual([])
    expect(await fs.readdir(f.settings.paths.whisperOutput)).toEqual([])
    expect(await fs.readdir(f.settings.paths.videoOutput)).toEqual([])
    expect(f.calls.some((call) => call.args.includes('--no-video'))).toBe(true)
    expect(await fs.readFile(result.journal, 'utf8')).not.toContain('不能写入日志')
    expect((await collectMediaInputs([f.settings.paths.mdcOutput], true, true)).files).toHaveLength(
      0,
    )
    const state = runReducer(emptyRun, { type: 'pipeline', state: result })
    expect(runReducer(state, { type: 'tick', now: '12:00' })).toBe(state)
    expect(isRunning(state)).toBe(false)
  })
  it('保留 MDC 的演员与番号层级，归档不加入视频名外层，未配置日志时只输出到控制台', async () => {
    const f = await fixture()
    f.mode('MDC 分层目录')
    const consoleOutput = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = await f.start(['scrape', 'archive'])
      expect(result.status, result.message).toBe('succeeded')
      const expected = join('演员', 'ABC-123', 'ABC-123.mp4')
      expect(await fs.readFile(join(f.settings.paths.nas, expected), 'utf8')).toBe('隔离的媒体替身')
      expect(await fs.readdir(f.settings.paths.mdcOutput)).toEqual([])
      expect(await fs.readdir(f.settings.paths.mdcOutput)).not.toContain('.cyber-horse-work')
      await expect(fs.stat(join(f.root, '.cyber-horse-work'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await fs.readdir(f.settings.paths.nas)).toEqual(['演员'])
      const mdcCall = f.calls.find((call) => call.args.includes('-cli'))!
      expect(mdcCall.args).toContain('--log-dir=')
      expect(consoleOutput).toHaveBeenCalledWith('MDC · 测试输出 token=[已隐藏]')
      expect(await fs.readFile(result.journal, 'utf8')).not.toContain('MDC · 测试输出')
    } finally {
      consoleOutput.mockRestore()
    }
  })
  it('MDC 按单文件处理并直接写入输出目录，保留未选文件和已有产物', async () => {
    const f = await fixture()
    const other = join(f.settings.paths.preprocess, '其他.mp4')
    const existing = join(f.settings.paths.mdcOutput, '已有.mp4')
    await fs.writeFile(other, '未选文件')
    await fs.writeFile(existing, '已有产物')
    const plan = await f.preview(['scrape'], { mode: 'selected', relativePaths: ['ABC-123.mp4'] })
    await f.service.start(plan.id, f.settings, f.settings.paths.preprocess)
    await f.service.wait()
    expect(f.service.snapshot()!.status, f.service.snapshot()!.message).toBe('succeeded')
    expect(await fs.readFile(other, 'utf8')).toBe('未选文件')
    expect(await fs.readFile(existing, 'utf8')).toBe('已有产物')
    expect(f.calls.find((call) => call.args.includes('-cli'))!.args[1]).toBe(f.source)
    await expect(fs.stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      await fs.readFile(join(f.settings.paths.preprocess, 'ABC-123', 'ABC-123.mp4'), 'utf8'),
    ).toBe('隔离的媒体替身')
    expect(await fs.readdir(f.settings.paths.mdcOutput)).toEqual(['已有.mp4'])
    const archivePlan = await f.preview(['archive'])
    expect(archivePlan.files.map((file) => file.relativePath)).toContain(
      join('ABC-123', 'ABC-123.mp4'),
    )
  })
  it('MDC 自行移动源文件后正常验证产物，不再创建输入副本', async () => {
    const f = await fixture()
    f.mode('MDC 移动')
    expect((await f.start(['scrape'])).status).toBe('succeeded')
    await expect(fs.stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      await fs.readFile(join(f.settings.paths.preprocess, 'ABC-123', 'ABC-123.mp4'), 'utf8'),
    ).toBe('隔离的媒体替身')
    expect(await fs.readdir(f.settings.paths.mdcOutput)).toEqual([])
  })

  it.each(['MDC丢标记', 'MDC丢标签'])(
    'CLUB-494 重名尾缀场景在标记校验失败时禁止归档：%s',
    async (mode) => {
      const f = await fixture()
      const original = join(f.settings.paths.preprocess, 'CLUB-494-UC_1.mkv')
      await fs.rename(f.source, original)
      f.mode(mode)
      const result = await f.start(['scrape', 'archive'])
      expect(result.status).toBe('failed')
      expect(result.message).toMatch(/标记|标签/)
      expect(await fs.readFile(original, 'utf8')).toBe('隔离的媒体替身')
      expect(await fs.readdir(f.settings.paths.nas)).toEqual([])
      expect(await fs.readdir(f.settings.paths.mdcOutput)).not.toHaveLength(0)
    },
  )
  it('MDC 单步搬回演员与番号目录，已有同名文件夹不被覆盖', async () => {
    const f = await fixture()
    f.mode('MDC 分层目录')
    const occupied = join(f.settings.paths.preprocess, '演员', 'ABC-123')
    await fs.mkdir(occupied, { recursive: true })
    await fs.writeFile(join(occupied, '备注.txt'), '原有内容')
    const result = await f.start(['scrape'])
    expect(result.status, result.message).toBe('succeeded')
    expect(await fs.readFile(join(occupied, '备注.txt'), 'utf8')).toBe('原有内容')
    expect(
      await fs.readFile(
        join(f.settings.paths.preprocess, '演员', 'ABC-123_1', 'ABC-123.mp4'),
        'utf8',
      ),
    ).toBe('隔离的媒体替身')
    expect(await fs.readdir(f.settings.paths.mdcOutput)).toEqual([])
    const archive = await f.start(['archive'])
    expect(archive.status, archive.message).toBe('succeeded')
    expect(
      await fs.readFile(join(f.settings.paths.nas, '演员', 'ABC-123', 'ABC-123.mp4'), 'utf8'),
    ).toBe('隔离的媒体替身')
    expect(await fs.readdir(join(f.settings.paths.nas, '演员'))).toEqual(['ABC-123'])
  })
  it('CJOD-392-C 经过 MDC 后归档到原番号目录，回搬的 _1 不传给 NAS', async () => {
    const f = await fixture()
    f.mode('MDC 分层目录')
    await fs.rename(f.source, join(f.settings.paths.preprocess, 'CJOD-392-C.mp4'))
    const occupiedPreprocess = join(f.settings.paths.preprocess, '演员', 'CJOD-392')
    const occupiedNas = join(f.settings.paths.nas, '演员', 'CJOD-392')
    const actor = dirname(occupiedNas)
    await fs.mkdir(occupiedPreprocess, { recursive: true })
    await fs.writeFile(join(occupiedPreprocess, '备注.txt'), '预处理目录旧内容')
    await fs.mkdir(occupiedNas, { recursive: true })
    await fs.mkdir(join(actor, '其他番号'))
    await fs.writeFile(join(actor, '演员说明.txt'), '演员目录原有内容')
    await fs.writeFile(join(occupiedNas, 'CJOD-392.mp4'), 'NAS 旧视频')
    await fs.writeFile(join(occupiedNas, '备注.txt'), 'NAS 旧内容')
    const result = await f.start(['scrape', 'archive'])
    expect(result.status, result.message).toBe('succeeded')
    expect(await fs.readFile(join(occupiedNas, 'CJOD-392-C.mp4'), 'utf8')).toBe('隔离的媒体替身')
    expect(await fs.readdir(occupiedNas)).toEqual([
      'CJOD-392-C.mp4',
      'CJOD-392-C.nfo',
      'poster.jpg',
    ])
    expect(await fs.readFile(join(occupiedPreprocess, '备注.txt'), 'utf8')).toBe('预处理目录旧内容')
    expect(await fs.readdir(join(f.settings.paths.preprocess, '演员'))).toEqual(['CJOD-392'])
    expect(await fs.readdir(actor)).toEqual(['CJOD-392', '其他番号', '演员说明.txt'])
    expect(await fs.readFile(join(actor, '演员说明.txt'), 'utf8')).toBe('演员目录原有内容')
    await expect(fs.stat(`${occupiedNas}_tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('CJOD-392-C 视频破解后生成 UC.mkv，MDC 与归档仍指向原番号目录', async () => {
    const f = await fixture()
    f.mode('MDC 分层目录')
    await fs.rename(f.source, join(f.settings.paths.preprocess, 'CJOD-392-C.mp4'))
    const result = await f.start(['video', 'scrape', 'archive'])
    expect(result.status, result.message).toBe('succeeded')
    expect(
      await fs.readFile(join(f.settings.paths.nas, '演员', 'CJOD-392', 'CJOD-392-UC.mkv'), 'utf8'),
    ).toBe('隔离的媒体替身')
    expect(await fs.readdir(join(f.settings.paths.nas, '演员'))).toEqual(['CJOD-392'])
  })
  it('已有 CJOD-392-UC.mp4 跳过视频破解，MDC 与归档仍指向原番号目录', async () => {
    const f = await fixture()
    f.mode('MDC 分层目录')
    await fs.rename(f.source, join(f.settings.paths.preprocess, 'CJOD-392-UC.mp4'))
    const result = await f.start(['video', 'scrape', 'archive'])
    expect(result.status, result.message).toBe('succeeded')
    expect(result.tasks[0]!.status).toBe('skipped')
    expect(
      await fs.readFile(join(f.settings.paths.nas, '演员', 'CJOD-392', 'CJOD-392-UC.mp4'), 'utf8'),
    ).toBe('隔离的媒体替身')
    expect(await fs.readdir(join(f.settings.paths.nas, '演员'))).toEqual(['CJOD-392'])
  })
  it('MDC 产物搬回失败时保留 MDC 输出和原视频', async () => {
    const f = await fixture()
    const originalLink = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (String(target) === join(f.settings.paths.preprocess, 'ABC-123', 'ABC-123.mp4'))
        throw Object.assign(new Error('模拟目标写入失败'), { code: 'EIO' })
      return originalLink(source, target)
    })
    const result = await f.start(['scrape'])
    expect(result.status).toBe('failed')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
    expect(await fs.readFile(join(f.settings.paths.mdcOutput, 'ABC-123.mp4'), 'utf8')).toBe(
      '隔离的媒体替身',
    )
  })
  it('MDC 同名输出阻止调用工具且保留原视频', async () => {
    const f = await fixture()
    const target = join(f.settings.paths.mdcOutput, 'ABC-123.mp4')
    await fs.writeFile(target, '已有影片')
    const result = await f.start(['scrape'])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('已有同名视频')
    expect(f.calls.some((call) => call.args.includes('-cli'))).toBe(false)
    expect(await fs.readFile(target, 'utf8')).toBe('已有影片')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('已有 SRT 先校验复用，失败时保留字幕与源视频并清理中间输出', async () => {
    const f = await fixture()
    const existing = join(f.settings.paths.preprocess, 'ABC-123.srt')
    await fs.writeFile(existing, subtitle)
    f.mode('缺字幕轨')
    expect((await f.start(['subtitle-mux'])).status).toBe('failed')
    expect(f.calls.some((call) => call.args.includes('--sub_formats'))).toBe(false)
    expect(await fs.readFile(existing, 'utf8')).toBe(subtitle)
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
    expect(await fs.readdir(f.settings.paths.whisperOutput)).toEqual([])
  })
  it('拒绝已保存工作目录之外的输入，不执行工具或删除文件', async () => {
    const f = await fixture()
    const outside = join(f.root, '非工作目录')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'ABC-123.mp4'), '目录外文件')
    await expect(
      f.service.preview(
        f.settings,
        { steps: ['archive'], source: 'current', recursive: true, selection: { mode: 'all' } },
        outside,
      ),
    ).rejects.toThrow('不在已保存的工作目录内')
    expect(await fs.readFile(join(outside, 'ABC-123.mp4'), 'utf8')).toBe('目录外文件')
    expect(f.calls).toEqual([])
  })
  it('ASS 封装成功后清理生成字幕，已有字幕随输出改名且内容不变', async () => {
    const f = await fixture()
    f.settings.subtitle.format = 'ass'
    const original = join(f.settings.paths.preprocess, 'ABC-123.ass')
    await fs.writeFile(original, '用户已有字幕')
    const result = await f.start(['subtitle-mux'])
    expect(result.status, result.message).toBe('succeeded')
    await expect(fs.stat(original)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(join(f.settings.paths.preprocess, 'ABC-123-C.ass'), 'utf8')).toBe(
      '用户已有字幕',
    )
    const mux = f.calls.find((call) => call.args.includes('-o'))!
    const generated = mux.args.at(-1)!
    expect(generated.endsWith('.ass')).toBe(true)
    await expect(fs.stat(generated)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(generated.replace(/\.ass$/, '.srt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it('ASS 封装产物校验失败时清理本次中间文件并保留源视频', async () => {
    const f = await fixture()
    f.settings.subtitle.format = 'ass'
    f.mode('缺字幕轨')
    const result = await f.start(['subtitle-mux'])
    expect(result.status).toBe('failed')
    const generated = f.calls.find((call) => call.args.includes('-o'))!.args.at(-1)!
    await expect(fs.stat(generated)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('预览冻结选中范围，不纳入后加文件；归档替换同名目标文件夹', async () => {
    const f = await fixture()
    await fs.writeFile(join(f.settings.paths.preprocess, '其他.mp4'), '保持原样')
    await fs.writeFile(join(f.settings.paths.preprocess, 'ABC-123.nfo'), '已有元数据')
    const plan = await f.preview(['archive'], { mode: 'selected', relativePaths: ['ABC-123.mp4'] })
    expect(plan.relatedFiles[0]!.files).toHaveLength(2)
    await fs.writeFile(join(f.settings.paths.preprocess, '新增.mp4'), '不加入快照')
    const occupied = join(f.settings.paths.nas, 'ABC-123')
    await fs.mkdir(join(occupied, '旧子目录'), { recursive: true })
    await fs.writeFile(join(occupied, 'ABC-123.mp4'), '旧视频')
    await fs.writeFile(join(occupied, '旧子目录', '旧封面.jpg'), '旧封面')
    const originalOpen = fs.open
    let renamedBeforeCopy = false
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (String(path) === join(occupied, 'ABC-123.mp4') && flags === 'wx')
        renamedBeforeCopy =
          (await fs.readFile(join(`${occupied}_tmp`, 'ABC-123.mp4'), 'utf8')) === '旧视频'
      return originalOpen(path, flags, mode)
    })
    await f.service.start(plan.id, f.settings, f.settings.paths.preprocess)
    await f.service.wait()
    expect(f.service.snapshot()!.status).toBe('succeeded')
    expect(f.calls).toHaveLength(0)
    expect(await fs.readFile(join(occupied, 'ABC-123.nfo'), 'utf8')).toBe('已有元数据')
    expect(await fs.readFile(join(occupied, 'ABC-123.mp4'), 'utf8')).toBe('隔离的媒体替身')
    expect(renamedBeforeCopy).toBe(true)
    expect(await fs.readdir(occupied)).toEqual(['ABC-123.mp4', 'ABC-123.nfo'])
    expect(await fs.readdir(f.settings.paths.nas)).toEqual(['ABC-123'])
    await expect(fs.stat(`${occupied}_tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(join(f.settings.paths.preprocess, '其他.mp4'), 'utf8')).toBe(
      '保持原样',
    )
    expect(await fs.readFile(join(f.settings.paths.preprocess, '新增.mp4'), 'utf8')).toBe(
      '不加入快照',
    )
  })
  it('部分组合不补跑字幕或 MDC', async () => {
    const f = await fixture()
    expect((await f.start(['video', 'archive'])).status).toBe('succeeded')
    expect(f.calls.some((call) => /whisper|mdc/.test(basename(call.executable)))).toBe(false)
    expect(await fs.readFile(join(f.settings.paths.nas, 'ABC-123', 'ABC-123-U.mkv'), 'utf8')).toBe(
      '隔离的媒体替身',
    )
  })
  it.each(['工具失败', '坏字幕', '短片', '缺字幕轨'])(
    '字幕失败保留源文件并停止后续：%s',
    async (mode) => {
      const f = await fixture()
      f.mode(mode)
      const result = await f.start(['subtitle-mux', 'archive'])
      expect(result.status).toBe('failed')
      expect(result.tasks[1]!.status).toBe('skipped')
      expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
      expect(await fs.readdir(f.settings.paths.nas)).toEqual([])
    },
  )
  it('Whisper 的 GBK 编码崩溃给出修复提示并保留源文件', async () => {
    const f = await fixture()
    f.mode('Whisper 编码失败')
    const result = await f.start(['subtitle-mux', 'archive'])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('更换修复了标准输出编码的 Whisper 版本')
    expect(result.tasks[1]!.status).toBe('skipped')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('Python 在运行时不可访问则停止流程并保留源文件', async () => {
    const f = await fixture()
    f.mode('Python 不可访问')
    const result = await f.start(['subtitle-mux', 'video'])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('虚拟环境无法访问基础 Python（退出码 103）')
    expect(f.calls.some((call) => call.args.includes('--input'))).toBe(false)
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('GPU 运行库缺失时显示修复提示且保留源文件', async () => {
    const f = await fixture()
    f.mode('CUDA 缺失')
    const result = await f.start(['subtitle-mux', 'video'])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('Whisper 无法加载 GPU 运行库 cublas64_12.dll')
    expect(result.message).toContain('cuda/bin')
    expect(f.calls.some((call) => call.args.includes('--input'))).toBe(false)
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it.skipIf(process.platform !== 'win32')(
    '源码 CUDA 搜索目录传递到检测与运行，运行库变化后拒绝旧清单',
    async () => {
      const f = await fixture()
      const source = await sourceWhisperFixture(f.root)
      f.settings.paths.whisper = source
      const cuda = join(source, 'cuda', 'bin')
      await fs.mkdir(cuda, { recursive: true })
      const library = join(cuda, 'cublas64_12.dll')
      await fs.writeFile(library, '运行库替身')
      const plan = await f.preview(['subtitle-mux'])
      await fs.writeFile(library, '运行库替身已变化')
      await expect(
        f.service.start(plan.id, f.settings, f.settings.paths.preprocess),
      ).rejects.toThrow('文件已变化')
      expect((await f.start(['subtitle-mux'])).status).toBe('succeeded')
      const calls = f.calls.filter((call) => call.executable.endsWith('python.exe'))
      expect(calls.some((call) => call.args.includes('--help'))).toBe(true)
      expect(calls.some((call) => call.args.includes('--sub_formats'))).toBe(true)
      for (const call of calls) expect(call.pathEntries).toEqual([cuda])
      for (const call of f.calls.filter((call) => !call.executable.endsWith('python.exe')))
        expect(call.pathEntries).toBeUndefined()
    },
  )
  it.each(['stderr', 'stdout'] as const)(
    'Python 启动失败从 %s 提供环境修复提示',
    async (stream) => {
      const f = await fixture()
      f.settings.paths.whisper = await sourceWhisperFixture(f.root)
      const runner = vi.fn(async () => ({
        code: 103,
        stdout: '',
        stderr: '',
        [stream]: 'No Python at \u0027"Z:\\不可访问\\python.exe\u0027',
      }))
      await expect(
        new PipelineTools(runner).check(f.settings, ['subtitle-mux'], new AbortController().signal),
      ).rejects.toThrow('请检查 .venv/pyvenv.cfg 中 home')
      expect(runner).toHaveBeenCalledTimes(1)
      expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
    },
  )
  it('源码模式使用固定虚拟环境和参数数组，源码变化后拒绝启动', async () => {
    const f = await fixture()
    const directory = await sourceWhisperFixture(f.root)
    f.settings.paths.whisper = directory
    const plan = await f.preview(['subtitle-mux'])
    const helpCall = f.calls.find(
      (call) => call.args.includes('--help') && call.args.some((arg) => arg.endsWith('infer.py')),
    )
    expect(helpCall?.executable).toBe(
      join(
        directory,
        '.venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python',
      ),
    )
    expect(helpCall?.cwd).toBe(directory)
    expect(helpCall?.args).toContain(join(directory, 'models'))
    await fs.writeFile(
      join(directory, 'src', 'faster_whisper_transwithai_chickenrice', 'infer.py'),
      '源码变化',
    )
    await expect(f.service.start(plan.id, f.settings, f.settings.paths.preprocess)).rejects.toThrow(
      '文件已变化',
    )
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('源码模式实际运行入口并校验字幕，缺少虚拟环境时明确失败', async () => {
    const f = await fixture()
    const directory = await sourceWhisperFixture(f.root)
    f.settings.paths.whisper = directory
    const result = await f.start(['subtitle-mux'])
    expect(result.status, result.message).toBe('succeeded')
    const invocation = f.calls.find((call) => call.args.includes('--sub_formats'))
    expect(invocation?.args.at(-1)).toMatch(/\.mp4$/)
    expect(invocation?.args.slice(0, 5)).toEqual([
      '-I',
      '-B',
      '-X',
      'utf8',
      join(directory, 'infer.py'),
    ])
    await fs.unlink(
      join(
        directory,
        '.venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python',
      ),
    )
    await expect(f.preview(['subtitle-mux'])).rejects.toThrow('虚拟环境')
  })
  it('源码目录消失时提供中文配置提示', async () => {
    const f = await fixture()
    f.settings.paths.whisper = join(f.root, '不存在的源码')
    await expect(f.preview(['subtitle-mux'])).rejects.toThrow('Whisper 入口不存在')
  })
  it('工具能力检测区分退出错误和缺失参数，并隐藏凭据', async () => {
    const f = await fixture()
    const signal = new AbortController().signal
    const failed = new PipelineTools(async () => ({
      code: 1,
      stdout: '',
      stderr: '导入失败：password=私密值',
    }))
    await expect(failed.check(f.settings, ['subtitle-mux'], signal)).rejects.toThrow(
      'Whisper 命令行能力检测失败，退出码 1。导入失败：password=[已隐藏]',
    )
    const incomplete = new PipelineTools(async () => ({
      code: 0,
      stdout: '--sub_formats --device',
      stderr: '',
    }))
    await expect(incomplete.check(f.settings, ['subtitle-mux'], signal)).rejects.toThrow(
      'Whisper 命令行能力检测缺少参数：--audio_suffixes',
    )
  })
  it.each(['缺元数据', '坏元数据', 'MDC改视频'])('MDC 返回零也必须校验产物：%s', async (mode) => {
    const f = await fixture()
    f.mode(mode)
    expect((await f.start(['scrape'])).status).toBe('failed')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('NAS 整批失败保留所有本地源文件，残留包不进入扫描', async () => {
    const f = await fixture()
    await fs.writeFile(join(f.settings.paths.preprocess, 'ZZZ-999.mp4'), '第二个源文件')
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (String(path).includes(join('nas', 'ZZZ-999')) && flags === 'wx')
        throw Object.assign(new Error('磁盘满'), { code: 'ENOSPC' })
      return original(path, flags, mode)
    })
    const result = await f.start(['archive'])
    expect(result.status).toBe('failed')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
    expect(await fs.readFile(join(f.settings.paths.preprocess, 'ZZZ-999.mp4'), 'utf8')).toBe(
      '第二个源文件',
    )
    expect((await collectMediaInputs([f.settings.paths.nas], true, true)).files).toHaveLength(1)
  })
  it('NAS 同名目录写入失败时保留旧目录和本地源文件', async () => {
    const f = await fixture()
    const occupied = join(f.settings.paths.nas, 'ABC-123')
    await fs.mkdir(occupied)
    await fs.writeFile(join(occupied, 'ABC-123.mp4'), '旧视频')
    await fs.writeFile(join(occupied, '说明.txt'), '原有内容')
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (String(path).startsWith(occupied + sep) && flags === 'wx')
        throw Object.assign(new Error('磁盘满'), { code: 'ENOSPC' })
      return original(path, flags, mode)
    })
    const result = await f.start(['archive'])
    expect(result.status).toBe('failed')
    expect(await fs.readFile(join(occupied, 'ABC-123.mp4'), 'utf8')).toBe('旧视频')
    expect(await fs.readFile(join(occupied, '说明.txt'), 'utf8')).toBe('原有内容')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
    expect(await fs.readdir(occupied)).toEqual(['ABC-123.mp4', '说明.txt'])
    await expect(fs.stat(`${occupied}_tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('NAS 历史目录清理失败时保留 _tmp 和本地源文件并提示核对', async () => {
    const f = await fixture()
    await fs.writeFile(join(f.settings.paths.preprocess, 'ABC-123.nfo'), '新元数据')
    const occupied = join(f.settings.paths.nas, 'ABC-123')
    await fs.mkdir(occupied)
    await fs.writeFile(join(occupied, 'ABC-123.mp4'), '旧视频')
    const original = fs.unlink
    vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (String(path) === join(`${occupied}_tmp`, 'ABC-123.mp4'))
        throw Object.assign(new Error('模拟旧目录删除失败'), { code: 'EIO' })
      return original(path)
    })
    const result = await f.start(['archive'])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('旧目录清理未完成')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
    expect(await fs.readFile(join(f.settings.paths.preprocess, 'ABC-123.nfo'), 'utf8')).toBe(
      '新元数据',
    )
    expect(await fs.readFile(join(occupied, 'ABC-123.mp4'), 'utf8')).toBe('隔离的媒体替身')
    expect(await fs.readFile(join(`${occupied}_tmp`, 'ABC-123.mp4'), 'utf8')).toBe('旧视频')
    expect(await fs.readFile(join(`${occupied}_tmp`, '.cyber-horse-incomplete'), 'utf8')).toBe(
      result.id,
    )
  })
  it('NAS 已有 _tmp 时停止，不触碰同名番号目录', async () => {
    const f = await fixture()
    const occupied = join(f.settings.paths.nas, 'ABC-123')
    await fs.mkdir(occupied)
    await fs.mkdir(`${occupied}_tmp`)
    await fs.writeFile(join(occupied, 'ABC-123.mp4'), '旧视频')
    await fs.writeFile(join(`${occupied}_tmp`, '备注.txt'), '待核对的历史目录')
    const result = await f.start(['archive'])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('历史临时目录已存在')
    expect(await fs.readFile(join(occupied, 'ABC-123.mp4'), 'utf8')).toBe('旧视频')
    expect(await fs.readFile(join(`${occupied}_tmp`, '备注.txt'), 'utf8')).toBe('待核对的历史目录')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('本批同名归档目录冲突时停止，保留尚未删除的本地文件', async () => {
    const f = await fixture()
    const second = join(f.settings.paths.preprocess, 'ABC-123-C.mkv')
    await fs.writeFile(second, '另一段隔离媒体替身')
    const result = await f.start(['archive'])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('同一归档目录')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
    expect(await fs.readFile(second, 'utf8')).toBe('另一段隔离媒体替身')
  })
  it('NAS 归档只向目标写入文件内容，不从 NAS 回读或二次复制', async () => {
    const f = await fixture()
    const originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (String(path).startsWith(f.settings.paths.nas + sep) && flags === 'r')
        throw new Error('归档不应读取 NAS 文件内容。')
      return originalOpen(path, flags, mode)
    })
    const originalCopy = fs.copyFile
    vi.spyOn(fs, 'copyFile').mockImplementation(async (source, target, mode) => {
      if (String(source).startsWith(f.settings.paths.nas + sep))
        throw new Error('归档不应在 NAS 内二次复制。')
      return originalCopy(source, target, mode)
    })
    expect((await f.start(['archive'])).status).toBe('succeeded')
    expect(await fs.readFile(join(f.settings.paths.nas, 'ABC-123', 'ABC-123.mp4'), 'utf8')).toBe(
      '隔离的媒体替身',
    )
  })
  it('NAS 目标文件大小不一致时保留本地源文件', async () => {
    const f = await fixture()
    const original = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const value = await original(path, options)
      if (String(path).startsWith(f.settings.paths.nas + sep) && String(path).endsWith('.mp4'))
        return new Proxy(value, {
          get(target, key) {
            if (key === 'size')
              return typeof target.size === 'bigint' ? target.size + 1n : target.size + 1
            return Reflect.get(target, key, target)
          },
        })
      return value
    })
    const result = await f.start(['archive'])
    expect(result.status).toBe('failed')
    expect(result.message).toContain('文件大小')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('取消挂起工具；主进程阻止重复开始和并行预处理', async () => {
    const f = await fixture()
    f.mode('挂起')
    const plan = await f.preview(['video', 'archive'])
    await f.service.start(plan.id, f.settings, f.settings.paths.preprocess)
    await vi.waitFor(() => expect(f.calls.some((call) => call.args.includes('-J'))).toBe(true))
    await expect(f.service.start(plan.id, f.settings, f.settings.paths.preprocess)).rejects.toThrow(
      '正在',
    )
    const preparation = new PreparationService(join(f.root, '数据'), [], 32, f.lock)
    await expect(preparation.preview(f.settings.paths)).rejects.toThrow('正在')
    f.service.cancel()
    await f.service.wait()
    expect(f.service.snapshot()!.status).toBe('cancelled')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离的媒体替身')
  })
  it('文件或配置在预览后变化时阻止执行', async () => {
    const f = await fixture()
    let plan = await f.preview(['archive'])
    await fs.writeFile(f.source, '文件变化')
    await expect(f.service.start(plan.id, f.settings, f.settings.paths.preprocess)).rejects.toThrow(
      '文件已变化',
    )
    plan = await f.preview(['archive'])
    f.settings.subtitle.format = 'ass'
    await expect(f.service.start(plan.id, f.settings, f.settings.paths.preprocess)).rejects.toThrow(
      '配置',
    )
  })
  it('拒绝目录重叠、越界选择和缺失选择', async () => {
    const f = await fixture()
    await expect(
      f.preview(['archive'], { mode: 'selected', relativePaths: ['../其他.mp4'] }),
    ).rejects.toThrow('超出')
    await expect(
      f.preview(['archive'], { mode: 'selected', relativePaths: ['不存在.mp4'] }),
    ).rejects.toThrow('不在目录')
    f.settings.paths.nas = f.settings.paths.preprocess
    await expect(f.preview(['archive'])).rejects.toThrow('不能')
  })
  it.each(['-C', '-UC', '-c', '-uc', '-C_1', '-UC_2'])(
    '已有 %s 后缀时跳过字幕识别与封装，保留原文件',
    async (suffix) => {
      const f = await fixture()
      const video = join(f.settings.paths.preprocess, `ABC-123${suffix}.mkv`)
      await fs.rename(f.source, video)
      const result = await f.start(['subtitle-mux'])
      expect(result.tasks[0]).toMatchObject({ status: 'skipped', skipped: 1, completed: 1 })
      expect(f.calls.every((call) => call.args.includes('--help'))).toBe(true)
      expect(result.outputs).toEqual([])
      expect(result.resultFiles).toContain(video)
      expect(await fs.readFile(video, 'utf8')).toBe('隔离的媒体替身')
    },
  )
  it('已有 C 标记只跳过字幕，视频步骤仍执行并输出 UC', async () => {
    const f = await fixture()
    await fs.rename(f.source, join(f.settings.paths.preprocess, 'ABC-123-C.mkv'))
    const result = await f.start(['subtitle-mux', 'video'])
    expect(result.tasks.map((task) => task.status)).toEqual(['skipped', 'succeeded'])
    expect(f.calls.some((call) => call.args.includes('--sub_formats'))).toBe(false)
    expect(f.calls.some((call) => call.args.includes('--input'))).toBe(true)
    expect(result.outputs[0]).toBe(join(f.settings.paths.preprocess, 'ABC-123-UC.mkv'))
  })
  it('已有 U 标记仍识别并封装字幕，输出 UC 后跳过视频处理', async () => {
    const f = await fixture()
    await fs.rename(f.source, join(f.settings.paths.preprocess, 'ABC-123-U.mkv'))
    const result = await f.start(['subtitle-mux', 'video'])
    expect(result.tasks.map((task) => task.status)).toEqual(['succeeded', 'skipped'])
    const whisperIndex = f.calls.findIndex((call) => call.args.includes('--sub_formats'))
    const muxIndex = f.calls.findIndex((call) => call.args.includes('-o'))
    expect(whisperIndex).toBeGreaterThan(-1)
    expect(muxIndex).toBeGreaterThan(whisperIndex)
    expect(f.calls[muxIndex]!.executable).toBe(f.settings.paths.mkvmerge)
    expect(f.calls[muxIndex]!.args).toContain('0:chi')
    expect(f.calls.some((call) => call.args.includes('--input'))).toBe(false)
    expect(result.outputs[0]).toBe(join(f.settings.paths.preprocess, 'ABC-123-UC.mkv'))
  })
  it('已有 UC 标记时跳过字幕与视频，不假报工具处理完成', async () => {
    const f = await fixture()
    await fs.rename(f.source, join(f.settings.paths.preprocess, 'ABC-123-UC.mkv'))
    const result = await f.start(['subtitle-mux', 'video'])
    expect(result.tasks.map((task) => task.status)).toEqual(['skipped', 'skipped'])
    expect(f.calls.every((call) => call.args.includes('--help'))).toBe(true)
  })
  it('拒绝空步骤、空选中和任意命令 IPC 参数', () => {
    const request = {
      steps: ['archive'],
      source: 'current',
      recursive: true,
      selection: { mode: 'all' },
    }
    for (const invalid of [
      { ...request, steps: [] },
      { ...request, steps: ['archive', 'archive'] },
      { ...request, selection: { mode: 'selected', relativePaths: [] } },
      { ...request, command: '任意命令' },
    ])
      expect(pipelinePreviewSchema.safeParse(invalid).success).toBe(false)
  })
  it('字幕必须为有效 UTF-8 与时间轴，ASS 保留中文并转义控制内容', () => {
    expect(srtToAss(parseSrt(Buffer.from(subtitle)))).toContain('中文测试字幕')
    expect(() => parseSrt(Buffer.from([255]))).toThrow()
    expect(() => parseSrt(Buffer.from(subtitle.replace('01,500', '00,100')))).toThrow()
  })
})
