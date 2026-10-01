import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  readdir,
  rm,
  unlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { defaultSettings } from '../src/shared/contracts'
import { WorkspaceTasks, taskConfiguration, taskServer } from '../src/main/services/workspace-tasks'
import { TaskScheduler } from '../src/main/services/task-scheduler'
import { PipelineTools } from '../src/main/services/pipeline-tools'
import { mediaIdentity } from '../src/main/services/media-identity'
import { fileStamp, exists, inside } from '../src/main/services/safe-files'
import { TaskJournal } from '../src/main/services/task-journal'
import * as journalService from '../src/main/services/task-journal'
import type { ProcessRunner } from '../src/main/services/tool-process'
import type { PipelineStep } from '../src/shared/pipeline'

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }))

const roots: string[] = []
const signal = () => new AbortController().signal
function forbidNasReads(
  root: string,
  opened?: (
    handle: Awaited<ReturnType<typeof fs.open>>,
    path: string,
    flags: string | number,
  ) => void,
) {
  const reads: string[] = []
  const open = fs.open
  const copy = fs.copyFile
  vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    if (inside(root, String(path)) && (flags === 'r' || String(flags).includes('+'))) {
      reads.push(String(path))
      throw new Error('禁止 NAS 内容下行。')
    }
    const handle = await open(path, flags, mode)
    opened?.(handle, String(path), flags ?? 'r')
    return handle
  })
  vi.spyOn(fs, 'copyFile').mockImplementation(async (source, target, mode) => {
    if (inside(root, String(source))) {
      reads.push(String(source))
      throw new Error('禁止以 NAS 为源二次复制。')
    }
    return copy(source, target, mode)
  })
  return reads
}
async function fixture() {
  const root = await fs.realpath(await mkdtemp(join(tmpdir(), 'horse-unified-')))
  roots.push(root)
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
    await mkdir(settings.paths[key])
  }
  const install = join(root, 'tools')
  await mkdir(install)
  for (const key of ['whisper', 'mkvmerge', 'mdc', 'jasna'] as const) {
    settings.paths[key] = join(install, key + '.exe')
    await writeFile(settings.paths[key], '替身')
  }
  await writeFile(join(install, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'), '替身')
  let failure = false
  let movedFailure = false
  let sync = true
  const calls: string[] = []
  const runner: ProcessRunner = async (request) => {
    const { args } = request
    const value = (flag: string) => args[args.indexOf(flag) + 1]!
    const result = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (args.includes('--help'))
      return result(
        '--sub_formats --audio_suffixes --device --output_dir --identify --output --input --working-directory --post-export-action --post-export-video-command --cli --config-override --local-config-file -show_format -show_streams',
      )
    if (args.includes('-show_format')) return result('{"format":{"duration":"10"}}')
    if (args.includes('-J'))
      return result(
        JSON.stringify({
          container: { recognized: true, supported: true },
          tracks: [
            { type: 'video' },
            { type: 'audio' },
            { type: 'subtitles', properties: { language: 'chi' } },
          ],
        }),
      )
    calls.push(args.includes('-cli') ? 'scrape' : args.includes('--input') ? 'video' : 'subtitle')
    if (failure) return { code: 4, stdout: '', stderr: '隔离工具失败' }
    if (args.includes('--sub_formats'))
      await writeFile(
        join(value('--output_dir'), basename(args.at(-1)!, extname(args.at(-1)!)) + '.srt'),
        '1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n',
      )
    else if (args.includes('--input')) await copyFile(value('--input'), value('--output'))
    else if (args.includes('-o')) await copyFile(value('--no-subtitles'), value('-o'))
    else if (args.includes('-cli')) {
      const input = value('-cli'),
        identity = mediaIdentity(input)
      const output = join(
        args.find((arg) => arg.startsWith('common:success_folder='))!.split('=')[1]!,
        '演员',
        identity.number!,
      )
      await mkdir(output, { recursive: true })
      for (const name of await readdir(dirname(input)))
        await copyFile(join(dirname(input), name), join(output, name))
      await writeFile(
        join(output, basename(input, extname(input)) + '.nfo'),
        `<movie><title>隔离影片</title><num>${identity.number}</num>${identity.chinese ? '<tag>中文字幕</tag>' : ''}${identity.restored ? '<tag>破解</tag>' : ''}</movie>`,
      )
      await writeFile(join(output, 'poster.jpg'), '隔离封面')
      if (movedFailure) {
        await unlink(input)
        await writeFile(
          join(output, basename(input, extname(input)) + '.nfo'),
          '<movie><title>标记缺失</title></movie>',
        )
      }
    }
    return result()
  }
  const tools = new PipelineTools(runner)
  const data = join(root, 'data')
  const synchronize = vi.fn(async () => sync)
  const tasks = new WorkspaceTasks(data, [], async () => settings, tools, synchronize)
  const source = join(settings.paths.preprocess, 'CLUB-494_1.mp4')
  await writeFile(source, '隔离视频内容')
  const enqueue = (steps: PipelineStep[] = ['archive'], path = source) =>
    tasks.enqueue(
      settings,
      {
        origin: 'workbench',
        steps,
        files: [{ path }],
        destination: {
          kind: steps.includes('archive') ? 'nas' : 'preprocess',
          root: steps.includes('archive') ? settings.paths.nas : settings.paths.preprocess,
        },
      },
      [settings.paths.preprocess],
    )
  return {
    root,
    data,
    tasks,
    settings,
    source,
    tools,
    enqueue,
    calls,
    synchronize,
    fail: (value: boolean) => {
      failure = value
    },
    failMoved: (value: boolean) => {
      movedFailure = value
    },
    sync: (value: boolean) => {
      sync = value
    },
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('统一任务、发布与用户确认恢复', () => {
  for (const steps of [
    ['archive'],
    ['subtitle-mux', 'video', 'scrape', 'archive'],
  ] as PipelineStep[][])
    it(`${steps.length === 1 ? '仅归档' : '全部流程'}发布和最终收尾均不回读 NAS`, async () => {
      const f = await fixture()
      const reads = forbidNasReads(f.settings.paths.nas)
      const id = await f.enqueue(steps)
      const task = await f.tasks.wait(id)
      expect(task?.state, task?.message).toBe('completed')
      expect(reads).toEqual([])
      for (const publication of task!.files[0]!.publications)
        expect(publication.targetStamp).toEqual(await fileStamp(publication.target))
    })
  it('NAS 不支持硬链接时从本地独占重传，不从 NAS 暂存文件复制', async () => {
    const f = await fixture()
    const link = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (inside(f.settings.paths.nas, String(target)))
        throw Object.assign(new Error('不支持硬链接'), { code: 'ENOTSUP' })
      return link(source, target)
    })
    const reads = forbidNasReads(f.settings.paths.nas)
    const task = await f.tasks.wait(await f.enqueue())
    expect(task?.state, task?.message).toBe('completed')
    expect(reads).toEqual([])
    expect(await readFile(task!.files[0]!.publications[0]!.target, 'utf8')).toBe('隔离视频内容')
  })
  it('原名回写只下载所选旁车一次，提交和清理不读取 NAS 原视频或旁车', async () => {
    const f = await fixture()
    const parent = join(f.settings.paths.nas, '原影片')
    await mkdir(parent)
    const original = join(parent, 'CLUB-494.mp4')
    const companion = join(parent, 'CLUB-494.nfo')
    await writeFile(original, '旧视频')
    await writeFile(companion, '所选旁车')
    let downloads = 0
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (
        inside(f.settings.paths.nas, String(path)) &&
        (flags === 'r' || String(flags).includes('+'))
      ) {
        if (String(path) !== companion || ++downloads !== 1)
          throw new Error('只能在明确下载阶段读取一次所选旁车。')
      }
      return open(path, flags, mode)
    })
    const id = await f.tasks.enqueue(
      f.settings,
      {
        origin: 'media-library',
        steps: ['archive'],
        files: [{ path: f.source, companionBase: original, companions: [companion] }],
        destination: { kind: 'media-original', root: parent },
        context: {
          configuration: taskConfiguration(f.settings),
          replacements: await Promise.all(
            [original, companion].map(async (path) => ({
              path,
              stamp: await fileStamp(path),
              sha256: null,
              removed: false,
              removalPending: false,
            })),
          ),
          sync: null,
        },
      },
      [f.settings.paths.preprocess, f.settings.paths.nas],
    )
    const task = await f.tasks.wait(id)
    expect(task?.state, task?.message).toBe('completed')
    expect(downloads).toBe(1)
    expect(await readFile(original, 'utf8')).toBe('隔离视频内容')
    expect(await readFile(companion, 'utf8')).toBe('所选旁车')
  })
  it('NAS 上传落盘时取消保留本地输入与暂存文件，恢复不按相同大小认领', async () => {
    const f = await fixture()
    let id = ''
    const reads = forbidNasReads(f.settings.paths.nas, (handle, path, flags) => {
      if (inside(f.settings.paths.nas, path) && flags === 'wx') {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync()
          f.tasks.cancel(id)
        })
      }
    })
    id = await f.enqueue()
    const task = await f.tasks.wait(id)
    expect(task?.state).toBe('cancelled')
    const plan = await f.tasks.previewAction(id, 'resume')
    expect(await exists(join(plan.directory, task!.files[0]!.publications[0]!.source))).toBe(true)
    await f.tasks.confirmAction(plan.planId, plan.revision)
    const resumed = await f.tasks.wait(id)
    expect(resumed?.state).toBe('failed')
    expect(resumed?.message).toContain('快照')
    expect(reads).toEqual([])
  }, 15000)
  for (const message of ['NAS 暂存写入完成，快照已保存。', '目标写入已完成，发布快照已保存。'])
    it(`${message}记账失败时不凭大小认领残留，保留本地来源`, async () => {
      const f = await fixture()
      const reads = forbidNasReads(f.settings.paths.nas)
      const update = TaskJournal.prototype.update
      let injected = false
      vi.spyOn(TaskJournal.prototype, 'update').mockImplementation(function (
        this: TaskJournal,
        revision,
        patch,
      ) {
        if (!injected && patch.message === message) {
          injected = true
          return Promise.reject(new Error('故障注入'))
        }
        return update.call(this, revision, patch)
      })
      const id = await f.enqueue()
      expect((await f.tasks.wait(id))?.state).toBe('failed')
      const plan = await f.tasks.previewAction(id, 'resume')
      await f.tasks.confirmAction(plan.planId, plan.revision)
      const task = await f.tasks.wait(id)
      expect(task?.state).toBe('failed')
      expect(task?.message).toContain('快照')
      expect(
        await readFile(join(plan.directory, task!.files[0]!.publications[0]!.source), 'utf8'),
      ).toBe('隔离视频内容')
      expect(reads).toEqual([])
    }, 15000)
  it('NAS 写入校验失败时不清理本地来源', async () => {
    const f = await fixture()
    const reads = forbidNasReads(f.settings.paths.nas)
    const stat = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const value = await stat(path, options)
      if (inside(f.settings.paths.nas, String(path)) && value.isFile())
        Object.assign(value, { size: Number(value.size) + 1 })
      return value
    })
    const id = await f.enqueue()
    const task = await f.tasks.wait(id)
    expect(task?.state).toBe('failed')
    const view = (await f.tasks.list()).tasks.find((entry) => entry.task.id === id)!
    expect(await exists(join(view.directory, task!.files[0]!.publications[0]!.source))).toBe(true)
    expect(reads).toEqual([])
  })
  for (const change of ['修改同大小目标', '旧记录缺少快照'] as const)
    it(`${change}时恢复停止，不能删除本地唯一输入`, async () => {
      const f = await fixture()
      const reads = forbidNasReads(f.settings.paths.nas)
      const update = TaskJournal.prototype.update
      let injected = false
      vi.spyOn(TaskJournal.prototype, 'update').mockImplementation(function (
        this: TaskJournal,
        revision,
        patch,
      ) {
        if (!injected && patch.message === '目标内容已核对，等待本地清理。') {
          injected = true
          return Promise.reject(new Error('故障注入'))
        }
        return update.call(this, revision, patch)
      })
      const id = await f.enqueue()
      const task = (await f.tasks.wait(id))!
      const view = (await f.tasks.list()).tasks.find((entry) => entry.task.id === id)!
      const publication = task.files[0]!.publications[0]!
      if (change === '修改同大小目标')
        await writeFile(publication.target, Buffer.alloc(publication.size, 1))
      else {
        const journal = await f.tasks.workspaces.openJournal(view.directory, id)
        delete publication.targetStamp
        publication.state = 'published'
        await journal.update(task.revision, { files: task.files })
      }
      const plan = await f.tasks.previewAction(id, 'resume')
      await f.tasks.confirmAction(plan.planId, plan.revision)
      expect((await f.tasks.wait(id))?.state).toBe('failed')
      expect(await exists(join(plan.directory, publication.source))).toBe(true)
      expect(reads).toEqual([])
    }, 15000)
  it('完成历史尚在落盘时保持运行，清理目录后才投影成功', async () => {
    const f = await fixture()
    const write = journalService.writeTaskJson
    let entered!: () => void, release!: () => void
    const pending = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(journalService, 'writeTaskJson').mockImplementation(async (...args) => {
      if (args[0].endsWith('workspace-tasks')) {
        entered()
        await gate
      }
      return write(...args)
    })
    const id = await f.enqueue()
    await pending
    expect(f.tasks.project(id)?.status).toBe('running')
    expect((await f.tasks.list()).tasks.find((view) => view.task.id === id)).toMatchObject({
      active: true,
      task: { state: 'completed' },
    })
    release()
    await f.tasks.wait(id)
    expect(f.tasks.project(id)?.status).toBe('succeeded')
    expect((await f.tasks.list()).tasks.find((view) => view.task.id === id)?.directory).toBe('')
  })
  it('仅归档真实接管、校验发布、清理本任务目录并恢复历史，不调用其他步骤', async () => {
    const f = await fixture(),
      id = await f.enqueue()
    const task = await f.tasks.wait(id)
    expect(task?.state).toBe('completed')
    expect(f.calls).toEqual([])
    expect(await readFile(join(f.settings.paths.nas, 'CLUB-494', 'CLUB-494.mp4'), 'utf8')).toBe(
      '隔离视频内容',
    )
    expect(await exists(f.source)).toBe(false)
    expect(
      (await readdir(join(f.settings.paths.download, '.work'))).filter(
        (name) => name !== '资源占用',
      ),
    ).toEqual([])
    const restarted = new WorkspaceTasks(f.data, [], async () => f.settings, f.tools)
    expect((await restarted.list()).tasks[0]?.task.state).toBe('completed')
    expect(restarted.active).toBe(false)
  })
  it('全部所选步骤在独立目录执行，保留 UC 与字幕后发布，公共工具输出目录为空', async () => {
    const f = await fixture(),
      id = await f.enqueue(['subtitle-mux', 'video', 'scrape', 'archive'])
    const task = await f.tasks.wait(id)
    expect(task?.state, task?.message).toBe('completed')
    const paths = task!.files[0]!.publications.map((value) => value.target)
    expect(paths.some((path) => path.endsWith('CLUB-494-UC.mkv'))).toBe(true)
    expect(paths.some((path) => path.endsWith('.srt'))).toBe(true)
    for (const key of ['whisperOutput', 'videoOutput', 'mdcOutput'] as const)
      expect(await readdir(f.settings.paths[key])).toEqual([])
  })
  it('同名发布冲突保留任务来源，不覆盖目标；重启只展示残留', async () => {
    const f = await fixture(),
      target = join(f.settings.paths.nas, 'CLUB-494')
    await mkdir(target)
    await writeFile(join(target, 'CLUB-494.mp4'), '已有媒体')
    const id = await f.enqueue()
    expect((await f.tasks.wait(id))?.state).toBe('failed')
    expect(await readFile(join(target, 'CLUB-494.mp4'), 'utf8')).toBe('已有媒体')
    const restarted = new WorkspaceTasks(f.data, [], async () => f.settings, f.tools)
    const views = (await restarted.list()).tasks
    expect(views[0]?.recoverable).toBe(true)
    expect(restarted.active).toBe(false)
    expect(
      await exists(join(views[0]!.directory, views[0]!.task.files[0]!.sources[0]!.target)),
    ).toBe(true)
  })
  it('处理失败后确认恢复只重跑未完成步骤，成功后清理旧步骤残留', async () => {
    const f = await fixture()
    f.fail(true)
    const id = await f.enqueue(['video', 'archive'])
    expect((await f.tasks.wait(id))?.state).toBe('failed')
    f.fail(false)
    const preview = await f.tasks.previewAction(id, 'resume')
    await f.tasks.confirmAction(preview.planId, preview.revision)
    const task = await f.tasks.wait(id)
    expect(task?.state, task?.message).toBe('completed')
    expect(task!.files[0]!.steps[0]!.attempt).toBe(1)
  }, 15000)
  it('恢复确认拒绝过期修订和新增未知文件，不改变唯一副本', async () => {
    const f = await fixture()
    f.fail(true)
    const id = await f.enqueue(['video'])
    await f.tasks.wait(id)
    const plan = await f.tasks.previewAction(id, 'delete')
    await writeFile(join(plan.directory, '未知文件.txt'), '不能删除')
    await expect(f.tasks.confirmAction(plan.planId, plan.revision)).rejects.toThrow('内容已变化')
    await expect(f.tasks.previewAction(id, 'delete')).rejects.toThrow('未知文件')
    expect(await readFile(join(plan.directory, '未知文件.txt'), 'utf8')).toBe('不能删除')
  }, 15000)
  it('结束并保留唯一输入，清空历史不隐藏其他待处理任务', async () => {
    const f = await fixture()
    f.fail(true)
    const id = await f.enqueue(['video'])
    await f.tasks.wait(id)
    await f.tasks.clearHistory()
    expect((await f.tasks.list()).tasks).toHaveLength(1)
    const plan = await f.tasks.previewAction(id, 'keep')
    await f.tasks.confirmAction(plan.planId, plan.revision)
    expect((await f.tasks.list()).tasks[0]?.task.state).toBe('removed')
    expect(
      await readFile(join(plan.destination, 'CLUB-494_01', '输入', 'CLUB-494.mp4'), 'utf8'),
    ).toBe('隔离视频内容')
    expect(await exists(plan.directory)).toBe(false)
  }, 15000)
  it('永久删除只在确认后删除本任务内文件，外部未接管来源保留', async () => {
    const f = await fixture(),
      workspace = await f.tasks.workspaces.create(
        f.settings.paths.download,
        {
          origin: 'workbench',
          steps: ['archive'],
          files: [{ path: f.source }],
          destination: { kind: 'nas', root: f.settings.paths.nas },
        },
        [f.settings.paths.preprocess],
      )
    const restarted = new WorkspaceTasks(f.data, [], async () => f.settings, f.tools)
    await restarted.list()
    const plan = await restarted.previewAction(workspace.task.id, 'delete')
    expect(await exists(f.source)).toBe(true)
    await restarted.confirmAction(plan.planId, plan.revision)
    expect(await exists(f.source)).toBe(true)
    expect(await exists(workspace.directory)).toBe(false)
    expect((await restarted.list()).tasks[0]?.task.removalAction).toBe('delete')
    await expect(restarted.confirmAction(plan.planId, plan.revision)).rejects.toThrow('失效')
  }, 15000)
  it('配置变化阻止恢复，不静默把历史任务写入新目标', async () => {
    const f = await fixture()
    f.fail(true)
    const id = await f.enqueue(['video'])
    await f.tasks.wait(id)
    f.settings.subtitle.format = 'ass'
    await expect(f.tasks.previewAction(id, 'resume')).rejects.toThrow('配置')
  })
  it('删除单个未完成任务，预览、失败和成功均保留其他已完成历史及发布文件', async () => {
    const f = await fixture()
    const completedId = await f.enqueue()
    const completed = (await f.tasks.wait(completedId))!
    expect(completed.state).toBe('completed')
    const historyPath = join(f.data, 'workspace-tasks', completedId + '.json')
    const history = await readFile(historyPath, 'utf8')
    const publication = completed.files[0]!.publications[0]!
    const published = await fileStamp(publication.target)
    const pendingSource = join(f.settings.paths.preprocess, 'CLUB-495.mp4')
    await writeFile(pendingSource, '另一个隔离视频')
    f.fail(true)
    const pendingId = await f.enqueue(['video'], pendingSource)
    await f.tasks.wait(pendingId)
    const untouched = async () => {
      expect(await readFile(historyPath, 'utf8')).toBe(history)
      expect(await fileStamp(publication.target)).toEqual(published)
      expect((await f.tasks.list()).tasks.some((view) => view.task.id === completedId)).toBe(true)
    }
    const cancelled = await f.tasks.previewAction(pendingId, 'delete')
    await untouched() // 未确认的预览没有副作用。
    await expect(f.tasks.confirmAction(cancelled.planId, cancelled.revision + 1)).rejects.toThrow(
      '失效',
    )
    await untouched()
    const plan = await f.tasks.previewAction(pendingId, 'delete')
    await f.tasks.confirmAction(plan.planId, plan.revision)
    await untouched()
    expect(await exists(plan.directory)).toBe(false)
    const restarted = new WorkspaceTasks(f.data, [], async () => f.settings, f.tools)
    expect(
      (await restarted.list()).tasks.find((view) => view.task.id === pendingId)?.task.removalAction,
    ).toBe('delete')
    expect((await restarted.list()).tasks.map((view) => [view.task.id, view.task.state])).toEqual(
      expect.arrayContaining([
        [completedId, 'completed'],
        [pendingId, 'removed'],
      ]),
    )
  }, 15000)
  it('媒体回写后服务器待确认，仅重试同步，旧视频校验后删除，不重做处理', async () => {
    const f = await fixture()
    f.synchronize.mockRejectedValueOnce(new Error('The operation was aborted'))
    const userData = {
      identity: 'a'.repeat(64),
      itemId: 'old-id',
      capturedAt: new Date().toISOString(),
      data: {
        IsFavorite: true,
        PlayCount: 8,
        Played: true,
        PlaybackPositionTicks: 0,
        LastPlayedDate: null,
      },
    }
    const parent = join(f.settings.paths.nas, '原影片')
    await mkdir(parent)
    const original = join(parent, 'CLUB-494.mp4')
    await writeFile(original, '原视频')
    const reads = forbidNasReads(f.settings.paths.nas)
    const id = await f.tasks.enqueue(
      f.settings,
      {
        origin: 'media-library',
        steps: ['video'],
        files: [{ path: f.source }],
        destination: { kind: 'media-original', root: parent },
        context: {
          configuration: taskConfiguration(f.settings),
          replacements: [
            {
              path: original,
              stamp: await fileStamp(original),
              sha256: null,
              removed: false,
              removalPending: false,
            },
          ],
          sync: {
            server: taskServer(f.settings),
            serverIdentity: null,
            itemId: 'old-id',
            originalRemotePath: '/media/原影片/CLUB-494.mp4',
            userData,
            state: 'pending',
            message: '',
          },
        },
      },
      [f.settings.paths.preprocess, f.settings.paths.nas],
    )
    const pending = await f.tasks.wait(id)
    expect(pending?.state, pending?.message).toBe('finalizing')
    expect(pending?.message).toBe('媒体已回写；Emby 更新确认请求中断，可重试收尾。')
    expect(pending?.context?.sync?.message).toBe(pending?.message)
    expect(pending?.context?.sync?.userData).toEqual(userData)
    const restarted = new WorkspaceTasks(f.data, [], async () => f.settings, f.tools)
    expect(
      (await restarted.list()).tasks.find((view) => view.task.id === id)?.task.context?.sync
        ?.userData,
    ).toEqual(userData)
    expect((await f.tasks.list()).tasks.find((view) => view.task.id === id)?.diagnostic).toBe('')
    expect(await exists(original)).toBe(false)
    const calls = f.calls.length
    f.sync(true)
    const plan = await f.tasks.previewAction(id, 'resume')
    await f.tasks.confirmAction(plan.planId, plan.revision)
    const completed = await f.tasks.wait(id)
    expect(completed?.state).toBe('completed')
    expect(completed?.context?.sync?.message).toContain('收藏和观看记录')
    expect(f.calls).toHaveLength(calls)
    expect(f.synchronize).toHaveBeenCalledTimes(2)
    expect(reads).toEqual([])
  }, 15000)
  it('目标提交后记账故障可核对继续，不重复覆盖和删除', async () => {
    const f = await fixture()
    const reads = forbidNasReads(f.settings.paths.nas)
    const update = TaskJournal.prototype.update
    let injected = false
    vi.spyOn(TaskJournal.prototype, 'update').mockImplementation(function (
      this: TaskJournal,
      revision,
      patch,
    ) {
      if (!injected && patch.message === '目标内容已核对，等待本地清理。') {
        injected = true
        return Promise.reject(new Error('故障注入'))
      }
      return update.call(this, revision, patch)
    })
    const id = await f.enqueue()
    await f.tasks.wait(id)
    const target = join(f.settings.paths.nas, 'CLUB-494', 'CLUB-494.mp4'),
      stamp = await fileStamp(target)
    const plan = await f.tasks.previewAction(id, 'resume')
    await f.tasks.confirmAction(plan.planId, plan.revision)
    expect((await f.tasks.wait(id))?.state).toBe('completed')
    expect(await fileStamp(target)).toEqual(stamp)
    expect(reads).toEqual([])
  }, 15000)
  it('MDC 移走输入后校验失败，从任务内摘要匹配的产物恢复，不伪造标记', async () => {
    const f = await fixture()
    f.failMoved(true)
    const source = join(f.settings.paths.preprocess, 'CLUB-494-C.mp4')
    await writeFile(source, '隔离带字幕标记输入')
    const id = await f.enqueue(['scrape'], source)
    expect((await f.tasks.wait(id))?.state).toBe('failed')
    f.failMoved(false)
    const plan = await f.tasks.previewAction(id, 'resume')
    await f.tasks.confirmAction(plan.planId, plan.revision)
    expect((await f.tasks.wait(id))?.state).toBe('completed')
    expect(f.calls).toEqual(['scrape', 'scrape'])
  }, 15000)
  it('步骤移交已完成但结果事件写入失败，确认后核对预先登记的输入摘要', async () => {
    const f = await fixture()
    const update = TaskJournal.prototype.update
    let injected = false
    vi.spyOn(TaskJournal.prototype, 'update').mockImplementation(function (
      this: TaskJournal,
      revision,
      patch,
    ) {
      if (!injected && patch.message === '文件移交已核对。') {
        injected = true
        return Promise.reject(new Error('移交记账故障'))
      }
      return update.call(this, revision, patch)
    })
    const id = await f.enqueue(['scrape'])
    expect((await f.tasks.wait(id))?.state).toBe('failed')
    const plan = await f.tasks.previewAction(id, 'resume')
    await f.tasks.confirmAction(plan.planId, plan.revision)
    expect((await f.tasks.wait(id))?.state).toBe('completed')
    expect(f.calls).toEqual(['scrape'])
  }, 15000)
})

describe('资源调度与占用', () => {
  it('不同调度实例共享下载根时只允许一个 MDC 工具运行，取消等待不解除另一实例的资源', async () => {
    const f = await fixture()
    const parent = join(f.settings.paths.download, '.work')
    const firstDirectory = join(parent, 'first'),
      secondDirectory = join(parent, 'second')
    await mkdir(firstDirectory, { recursive: true })
    await mkdir(secondDirectory)
    let release!: () => void
    let firstWork!: Promise<void>
    const firstEntered = new Promise<void>((resolve) => {
      const first = new TaskScheduler().use(
        'mdc',
        signal(),
        async () => {
          resolve()
          await new Promise<void>((finish) => {
            release = finish
          })
        },
        firstDirectory,
      )
      firstWork = first
    })
    await firstEntered
    const controller = new AbortController()
    const unexpected = vi.fn()
    const second = new TaskScheduler()
      .use(
        'mdc',
        controller.signal,
        async () => {
          unexpected()
        },
        secondDirectory,
      )
      .catch((error) => error)
    await new Promise((resolve) => setTimeout(resolve, 250))
    controller.abort()
    await second
    expect(unexpected).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(parent, '资源占用', 'mdc.json'), 'utf8')).directory).toBe(
      firstDirectory,
    )
    release()
    await firstWork
    expect(await readdir(join(parent, '资源占用'))).toEqual([])
  })
  it('MDC 等待按进入顺序公平推进，取消等待不会中断其他任务，传输槽位独立', async () => {
    const scheduler = new TaskScheduler(),
      order: string[] = []
    let release!: () => void
    const first = scheduler.use('mdc', signal(), async () => {
      order.push('first')
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await Promise.resolve()
    const aborted = new AbortController()
    const second = scheduler
      .use('mdc', aborted.signal, async () => {
        order.push('cancelled')
      })
      .catch((error) => error.message)
    const third = scheduler.use('mdc', signal(), async () => {
      order.push('third')
    })
    await scheduler.use('transfer', signal(), async () => {
      order.push('transfer')
    })
    aborted.abort()
    release()
    await Promise.all([first, second, third])
    expect(order).toEqual(['first', 'transfer', 'third'])
  })
  it('来源、目标及父子目录占用拒绝竞争，释放后可再次提交', () => {
    const scheduler = new TaskScheduler(),
      path = join(tmpdir(), 'horse-claim')
    const release = scheduler.claim('first', [path])
    expect(() => scheduler.claim('second', [join(path, 'video.mp4')])).toThrow('占用')
    const targetRelease = scheduler.claim('first', [join(tmpdir(), 'target')], true)
    targetRelease()
    release()
    expect(() => scheduler.claim('second', [path])).not.toThrow()
  })
})
