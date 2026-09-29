import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { defaultSettings } from '../src/shared/contracts'
import type { PipelineStep } from '../src/shared/pipeline'
import { TaskWorkspaces } from '../src/main/services/task-workspaces'
import { TaskProcessing } from '../src/main/services/task-processing'
import { TaskJournal } from '../src/main/services/task-journal'
import { PipelineTools } from '../src/main/services/pipeline-tools'
import { mediaIdentity } from '../src/main/services/media-identity'
import type { ProcessRequest, ProcessRunner } from '../src/main/services/tool-process'

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }))
const temporary: string[] = []
const help =
  '--sub_formats --audio_suffixes --device --output_dir --identify --output --input --working-directory --post-export-action --post-export-video-command --cli --config-override --local-config-file -show_format -show_streams'
const srt = '1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n'
const signal = () => new AbortController().signal

async function fixture(steps: PipelineStep[] = ['subtitle-mux', 'video', 'scrape']) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'horse-processing-')))
  temporary.push(root)
  const settings = structuredClone(defaultSettings)
  for (const key of [
    'download',
    'preprocess',
    'nas',
    'whisperOutput',
    'videoOutput',
    'mdcOutput',
  ] as const) {
    settings.paths[key] = join(root, key)
    await fs.mkdir(settings.paths[key])
  }
  const toolsRoot = join(root, '工具安装目录')
  await fs.mkdir(toolsRoot)
  for (const key of ['whisper', 'mkvmerge', 'jasna', 'mdc'] as const) {
    settings.paths[key] = join(toolsRoot, key + '.exe')
    await fs.writeFile(settings.paths[key], '工具替身')
  }
  await fs.writeFile(
    join(toolsRoot, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
    '校验工具',
  )
  const source = join(settings.paths.preprocess, 'CLUB-494_1.mp4')
  await fs.writeFile(source, '隔离视频内容')
  const data = join(root, '应用数据')
  const workspaces = new TaskWorkspaces(data)
  const calls: ProcessRequest[] = []
  let mode = ''
  const runner: ProcessRunner = async (request) => {
    calls.push(request)
    const { args } = request
    const value = (flag: string) => args[args.indexOf(flag) + 1]!
    const done = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (args.includes('--help'))
      return done(mode === '旧版字幕工具' ? help.replace('--output_dir', '') : help)
    if (args.includes('-show_format')) return done('{"format":{"duration":"10"}}')
    if (args.includes('-J'))
      return done(
        JSON.stringify({
          container: { recognized: true, supported: true },
          tracks: [
            { type: 'video' },
            { type: 'audio' },
            { type: 'subtitles', properties: { language: 'chi' } },
          ],
        }),
      )
    if (mode === '处理失败') return { code: 4, stdout: '', stderr: '模拟工具异常' }
    if (args.includes('--sub_formats')) {
      expect(args).toContain('--output_dir')
      await fs.writeFile(
        join(value('--output_dir'), basename(args.at(-1)!, extname(args.at(-1)!)) + '.srt'),
        srt,
      )
    } else if (args.includes('--input')) {
      expect(value('--post-export-action')).toBe('none')
      expect(value('--working-directory')).toContain('.work')
      await fs.copyFile(value('--input'), value('--output'))
    } else if (args.includes('-o')) {
      await fs.copyFile(value('--no-subtitles'), value('-o'))
    } else if (args.includes('-cli')) {
      const input = value('-cli')
      const outputRoot = args
        .find((arg) => arg.startsWith('common:success_folder='))!
        .slice('common:success_folder='.length)
      const identity = mediaIdentity(input)
      const output = join(outputRoot, '演员', identity.number!)
      await fs.mkdir(output, { recursive: true })
      const name = mode === '丢标记' ? identity.number + extname(input) : basename(input)
      await fs.copyFile(input, join(output, name))
      for (const file of (await fs.readdir(dirname(input)))
        .filter((name) => name !== basename(input))
        .filter((name) => mode !== '丢字幕' || !name.endsWith('.srt')))
        await fs.copyFile(join(dirname(input), file), join(output, file))
      if (mode === '移动输入') await fs.unlink(input)
      const tags =
        mode === '丢标签'
          ? ''
          : `${identity.chinese ? '<tag>中文字幕</tag>' : ''}${identity.restored ? '<tag>破解</tag>' : ''}`
      await fs.writeFile(
        join(output, basename(name, extname(name)) + '.nfo'),
        `<movie><title>测试</title><num>${identity.number}</num>${tags}</movie>`,
      )
      await fs.writeFile(join(output, 'poster.jpg'), '隔离封面替身')
    }
    return done()
  }
  const processing = new TaskProcessing(workspaces, new PipelineTools(runner))
  const create = (path = source, companions: string[] = []) =>
    workspaces.create(
      settings.paths.download,
      {
        origin: 'workbench',
        steps,
        destination: { kind: 'preprocess', root: settings.paths.preprocess },
        files: [{ path, companions }],
      },
      [settings.paths.preprocess],
    )
  return {
    root,
    source,
    settings,
    workspaces,
    processing,
    calls,
    toolsRoot,
    create,
    mode: (next: string) => {
      mode = next
    },
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  const base = await fs.realpath(tmpdir())
  for (const root of temporary.splice(0)) {
    if (!resolve(root).startsWith(base + sep) || !basename(root).startsWith('horse-processing-'))
      throw new Error('测试清理越界。')
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('任务目录内的处理步骤', () => {
  it('同批相同番号独立执行，两个版本都保留且不添加防重尾缀', async () => {
    const f = await fixture(['video', 'scrape'])
    const second = join(f.settings.paths.preprocess, 'CLUB-494_2.mp4')
    await fs.writeFile(second, '另一个版本')
    const workspace = await f.workspaces.create(
      f.settings.paths.download,
      {
        origin: 'workbench',
        steps: ['video', 'scrape'],
        destination: { kind: 'preprocess', root: f.settings.paths.preprocess },
        files: [{ path: f.source }, { path: second }],
      },
      [f.settings.paths.preprocess],
    )
    const task = await f.processing.run(
      workspace.directory,
      workspace.task.id,
      f.settings,
      signal(),
    )
    const outputs = task.files.map((file) =>
      join(workspace.directory, file.steps.at(-1)!.outputVideo!),
    )
    expect(new Set(outputs).size).toBe(2)
    expect(outputs.every((path) => basename(path) === 'CLUB-494-hack.mkv')).toBe(true)
    expect(await fs.readFile(outputs[0]!, 'utf8')).toBe('隔离视频内容')
    expect(await fs.readFile(outputs[1]!, 'utf8')).toBe('另一个版本')
  })

  it('复用并校验已有 SRT，ASS 封装后记录与清理临时字幕', async () => {
    const f = await fixture(['subtitle-mux'])
    f.settings.subtitle.format = 'ass'
    const sidecar = f.source.replace('.mp4', '.srt')
    await fs.writeFile(sidecar, srt)
    const workspace = await f.create(f.source, [sidecar])
    const task = await f.processing.run(
      workspace.directory,
      workspace.task.id,
      f.settings,
      signal(),
    )
    expect(f.calls.some((call) => call.args.includes('--sub_formats'))).toBe(false)
    const file = task.files[0]!
    expect(file.steps[0]!.outputFiles.some((path) => path.endsWith('CLUB-494-C.ass'))).toBe(true)
    expect(
      file.artifacts
        .filter((entry) => entry.role === 'subtitle')
        .every((entry) => entry.state === 'removed'),
    ).toBe(true)
    for (const path of file.steps[0]!.outputFiles)
      expect((await fs.stat(join(workspace.directory, path))).size).toBeGreaterThan(0)
  })

  it('字幕、视频和 MDC 全部在文件任务内完成，状态保留 C/UC；等待发布不伪报完成', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const result = await f.processing.run(
      workspace.directory,
      workspace.task.id,
      f.settings,
      signal(),
    )
    expect(result.state).toBe('finalizing')
    const file = result.files[0]!
    expect(file.steps.map((step) => step.state)).toEqual(['verified', 'verified', 'verified'])
    expect(file.marks).toEqual({
      chinese: { present: true, evidence: 'verified-output' },
      restored: { present: true, evidence: 'verified-output' },
    })
    const output = join(workspace.directory, file.steps.at(-1)!.outputVideo!)
    expect(basename(output)).toBe('CLUB-494-UC.mkv')
    expect(await fs.readFile(output, 'utf8')).toBe('隔离视频内容')
    expect(file.steps.at(-1)!.outputFiles.some((path) => path.endsWith('CLUB-494-UC.srt'))).toBe(
      true,
    )
    const mdc = f.calls.find((call) => call.args.includes('-cli'))!
    expect(basename(mdc.args[1]!)).toBe('CLUB-494-UC.mkv')
    expect(f.calls.every((call) => call.cwd === f.toolsRoot)).toBe(true)
    for (const key of ['preprocess', 'nas', 'whisperOutput', 'videoOutput', 'mdcOutput'] as const)
      expect(await fs.readdir(f.settings.paths[key])).toEqual([])
    const events = await fs.readFile(join(workspace.directory, '执行事件.jsonl'), 'utf8')
    expect(events).toContain('"state":"removing"')
    await expect(
      f.processing.run(workspace.directory, workspace.task.id, f.settings, signal()),
    ).rejects.toThrow('首次执行')
  })

  it.each<PipelineStep[]>([
    ['subtitle-mux'],
    ['video'],
    ['scrape'],
    ['video', 'scrape'],
    ['archive'],
  ])('单步和部分组合只执行所选步骤：%j', async (...steps) => {
    const f = await fixture(steps)
    const workspace = await f.create()
    const task = await f.processing.run(
      workspace.directory,
      workspace.task.id,
      f.settings,
      signal(),
    )
    expect(task.steps).toEqual(steps)
    expect(f.calls.some((call) => call.args.includes('--sub_formats'))).toBe(
      steps.includes('subtitle-mux'),
    )
    expect(f.calls.some((call) => call.args.includes('--input'))).toBe(steps.includes('video'))
    expect(f.calls.some((call) => call.args.includes('-cli'))).toBe(steps.includes('scrape'))
    if (steps.includes('video') && steps.includes('scrape'))
      expect(f.calls.find((call) => call.args.includes('-cli'))!.args[1]).toMatch(
        /CLUB-494-hack\.mkv$/,
      )
    expect(task.state).toBe('finalizing')
  })

  it('已有 UC 跳过两个处理步骤，规范输入名消除 _1，MDC 移动输入也能核对', async () => {
    const f = await fixture()
    const path = join(f.settings.paths.preprocess, 'CLUB-494-UC_1.mkv')
    await fs.rename(f.source, path)
    const workspace = await f.create(path)
    f.mode('移动输入')
    const task = await f.processing.run(
      workspace.directory,
      workspace.task.id,
      f.settings,
      signal(),
    )
    expect(task.files[0]!.steps.map((step) => step.state)).toEqual([
      'skipped',
      'skipped',
      'verified',
    ])
    expect(task.files[0]!.marks.chinese.evidence).toBe('filename')
    expect(f.calls.find((call) => call.args.includes('-cli'))!.args[1]).toMatch(/CLUB-494-UC\.mkv$/)
  })

  it.each(['丢标记', '丢标签'])('MDC 返回成功但%s时停止，保留输入与产物', async (mode) => {
    const f = await fixture(['scrape'])
    const path = join(f.settings.paths.preprocess, 'CLUB-494-UC_1.mkv')
    await fs.rename(f.source, path)
    const workspace = await f.create(path)
    f.mode(mode)
    await expect(
      f.processing.run(workspace.directory, workspace.task.id, f.settings, signal()),
    ).rejects.toThrow(/标记|标签/)
    const task = (await new TaskJournal(workspace.directory).read()).task
    expect(task.state).toBe('failed')
    expect(task.files[0]!.steps[0]!.state).toBe('failed')
    expect(
      await fs.readFile(join(workspace.directory, task.files[0]!.steps[0]!.inputVideo!), 'utf8'),
    ).toBe('隔离视频内容')
    expect(await fs.readdir(f.settings.paths.nas)).toEqual([])
  })

  it('不支持输出目录的旧工具与空间不足均在接管前拒绝', async () => {
    const f = await fixture(['subtitle-mux'])
    f.mode('旧版字幕工具')
    const first = await f.create()
    await expect(
      f.processing.run(first.directory, first.task.id, f.settings, signal()),
    ).rejects.toThrow('--output_dir')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离视频内容')
    f.mode('')
    const second = await f.create()
    const space = await fs.statfs(f.settings.paths.download)
    vi.spyOn(fs, 'statfs').mockResolvedValue({ ...space, bavail: 0 })
    await expect(
      f.processing.run(second.directory, second.task.id, f.settings, signal()),
    ).rejects.toThrow('空间不足')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离视频内容')
  })

  it('保留并规范化已有字幕旁车，取消不会删除唯一输入', async () => {
    const f = await fixture(['video', 'scrape'])
    const sidecar = f.source.replace('.mp4', '.srt')
    await fs.writeFile(sidecar, srt)
    const workspace = await f.create(f.source, [sidecar])
    const task = await f.processing.run(
      workspace.directory,
      workspace.task.id,
      f.settings,
      signal(),
    )
    expect(
      task.files[0]!.steps.at(-1)!.outputFiles.some((path) => path.endsWith('CLUB-494-hack.srt')),
    ).toBe(true)
    const cancelled = await fixture(['video'])
    const pending = await cancelled.create()
    const controller = new AbortController()
    controller.abort()
    await expect(
      cancelled.processing.run(
        pending.directory,
        pending.task.id,
        cancelled.settings,
        controller.signal,
      ),
    ).rejects.toThrow('取消')
    expect(await fs.readFile(cancelled.source, 'utf8')).toBe('隔离视频内容')
    expect((await new TaskJournal(pending.directory).read()).task.state).toBe('cancelled')
  })

  it('MDC 遗漏原有字幕时不清理输入，工具失败也不添加成功标记', async () => {
    const f = await fixture(['scrape'])
    const sidecar = f.source.replace('.mp4', '.srt')
    await fs.writeFile(sidecar, srt)
    const workspace = await f.create(f.source, [sidecar])
    f.mode('丢字幕')
    await expect(
      f.processing.run(workspace.directory, workspace.task.id, f.settings, signal()),
    ).rejects.toThrow('缺少原有字幕')
    const task = (await new TaskJournal(workspace.directory).read()).task
    const subtitle = task.files[0]!.artifacts.find(
      (entry) =>
        entry.role === 'input' && entry.state === 'verified' && entry.path.endsWith('.srt'),
    )!
    expect(await fs.readFile(join(workspace.directory, subtitle.path), 'utf8')).toBe(srt)
    const failed = await fixture(['video'])
    failed.mode('处理失败')
    const queued = await failed.create()
    await expect(
      failed.processing.run(queued.directory, queued.task.id, failed.settings, signal()),
    ).rejects.toThrow('执行失败')
    const record = (await new TaskJournal(queued.directory).read()).task
    expect(record.files[0]!.marks.restored.present).toBe(false)
    expect(
      await fs.readFile(join(queued.directory, record.files[0]!.sources[0]!.target), 'utf8'),
    ).toBe('隔离视频内容')
  })

  it('步骤成功记录写入失败时，输出和被替换输入均保留供核对', async () => {
    const f = await fixture(['video'])
    const workspace = await f.create()
    const original = TaskJournal.prototype.update
    vi.spyOn(TaskJournal.prototype, 'update').mockImplementation(function (
      this: TaskJournal,
      revision,
      patch,
    ) {
      if (patch.message === '步骤产物已校验，尚未发布到最终目录。')
        throw new Error('模拟提交记录失败')
      return original.call(this, revision, patch)
    })
    await expect(
      f.processing.run(workspace.directory, workspace.task.id, f.settings, signal()),
    ).rejects.toThrow('提交记录失败')
    const file = (await new TaskJournal(workspace.directory).read()).task.files[0]!
    expect(await fs.readFile(join(workspace.directory, file.sources[0]!.target), 'utf8')).toBe(
      '隔离视频内容',
    )
    const output = file.artifacts.find((entry) => entry.role === 'output')!
    expect(await fs.readFile(join(workspace.directory, output.path), 'utf8')).toBe('隔离视频内容')
    expect(file.steps[0]!.state).toBe('failed')
  })

  it('整个执行周期互斥，同一任务不能由两个处理器同时启动', async () => {
    const f = await fixture(['scrape'])
    const workspace = await f.create()
    let release!: () => void
    let entered!: () => void
    const running = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = PipelineTools.prototype.check
    vi.spyOn(PipelineTools.prototype, 'check').mockImplementationOnce(async function (
      this: PipelineTools,
      ...args
    ) {
      entered()
      await gate
      return original.apply(this, args)
    })
    const first = f.processing.run(workspace.directory, workspace.task.id, f.settings, signal())
    await running
    try {
      await expect(
        f.processing.run(workspace.directory, workspace.task.id, f.settings, signal()),
      ).rejects.toThrow('执行锁')
    } finally {
      release()
    }
    expect((await first).state).toBe('finalizing')
    expect(f.calls.filter((call) => call.args.includes('-cli'))).toHaveLength(1)
  })
})
