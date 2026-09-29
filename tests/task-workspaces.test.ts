import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import {
  taskConfirmationSchema,
  taskManifestSchema,
  taskRelativePathSchema,
} from '../src/shared/task-workspace'
import { TaskJournal } from '../src/main/services/task-journal'
import { TaskWorkspaces, type WorkspaceDraft } from '../src/main/services/task-workspaces'
import { safeRoot } from '../src/main/services/safe-files'

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }))

const temporary: string[] = []
const signal = () => new AbortController().signal
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'horse-workspaces-')))
  temporary.push(root)
  const download = join(root, '下载')
  const preprocess = join(root, '预处理')
  const data = join(root, '应用数据')
  await fs.mkdir(download)
  await fs.mkdir(preprocess)
  const source = join(preprocess, 'CLUB-494-C_1.mkv')
  const subtitle = join(preprocess, 'CLUB-494-C_1.srt')
  await fs.writeFile(source, '隔离媒体内容')
  await fs.writeFile(subtitle, '隔离字幕内容')
  const service = new TaskWorkspaces(data)
  const draft: WorkspaceDraft = {
    origin: 'workbench',
    steps: ['video', 'scrape'],
    destination: { kind: 'preprocess', root: preprocess },
    files: [{ path: source, companions: [subtitle] }],
  }
  const create = () => service.create(download, draft, [preprocess])
  return { root, download, preprocess, data, source, subtitle, service, draft, create }
}

afterEach(async () => {
  vi.restoreAllMocks()
  const base = await fs.realpath(tmpdir())
  for (const root of temporary.splice(0)) {
    if (!resolve(root).startsWith(base + sep) || !basename(root).startsWith('horse-workspaces-'))
      throw new Error('测试清理目录越界。')
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('任务工作目录基础', () => {
  it('发现和读取不创建目录；创建批次只登记清单，不提前移动媒体', async () => {
    const f = await fixture()
    expect(await f.service.discover(f.download)).toEqual([])
    expect(await fs.readdir(f.download)).toEqual([])
    await expect(fs.stat(f.data)).rejects.toMatchObject({ code: 'ENOENT' })
    const first = await f.create()
    expect(first.task.state).toBe('queued')
    expect(first.task.files[0]?.sources[0]?.target).toMatch(/输入\/CLUB-494-C\.mkv$/)
    expect(first.task.files[0]?.sources[1]?.target).toMatch(/输入\/CLUB-494-C\.srt$/)
    expect(first.task.files[0]?.marks.chinese).toEqual({ present: true, evidence: 'filename' })
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离媒体内容')
    expect(await fs.readdir(first.directory)).toEqual(['任务状态.json', '执行事件.jsonl'])
    expect(await f.service.registeredRoots()).toEqual([f.download])
  })

  it('同番号不同文件独立保存；任务内规范名称不追加重名编号', async () => {
    const f = await fixture()
    const secondSource = join(f.preprocess, 'CLUB-494-C_2.mkv')
    await fs.writeFile(secondSource, '另一版本')
    f.draft.files.push({ path: secondSource })
    const first = await f.create()
    const second = await f.create()
    expect(first.directory).not.toBe(second.directory)
    const targets = first.task.files.map((file) => file.sources[0]!.target)
    expect(new Set(targets).size).toBe(2)
    expect(targets.every((path) => path.endsWith('/CLUB-494-C.mkv'))).toBe(true)
    expect(await f.service.registeredRoots()).toEqual([f.download])
  })

  it('接管来源前记录意图，视频和字幕移动到规范名称；重复接管被拒绝', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const file = workspace.task.files[0]!
    await f.service.claimSource(workspace.directory, workspace.task.id, file.id, 0, signal())
    const task = await f.service.claimSource(
      workspace.directory,
      workspace.task.id,
      file.id,
      1,
      signal(),
    )
    expect(task.revision).toBe(4)
    expect(task.files[0]!.sources.every((source) => source.state === 'claimed')).toBe(true)
    expect(await fs.readFile(join(workspace.directory, file.sources[0]!.target), 'utf8')).toBe(
      '隔离媒体内容',
    )
    expect(await fs.readFile(join(workspace.directory, file.sources[1]!.target), 'utf8')).toBe(
      '隔离字幕内容',
    )
    await expect(fs.stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(f.subtitle)).rejects.toMatchObject({ code: 'ENOENT' })
    const log = await fs.readFile(join(workspace.directory, '执行事件.jsonl'), 'utf8')
    expect(log.indexOf('"state":"claiming"')).toBeLessThan(log.indexOf('"state":"claimed"'))
    await expect(
      f.service.claimSource(workspace.directory, workspace.task.id, file.id, 0, signal()),
    ).rejects.toThrow('已经接管')
  })

  it('输入被外部修改或目标被占用时不删除来源', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const file = workspace.task.files[0]!
    await fs.appendFile(f.source, '变化')
    await expect(
      f.service.claimSource(workspace.directory, workspace.task.id, file.id, 0, signal()),
    ).rejects.toThrow('文件已变化')
    const target = join(workspace.directory, file.sources[1]!.target)
    await fs.mkdir(join(workspace.directory, file.directory, '输入'), { recursive: true })
    await fs.writeFile(target, '先到的未知文件')
    await expect(
      f.service.claimSource(workspace.directory, workspace.task.id, file.id, 1, signal()),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(f.subtitle, 'utf8')).toBe('隔离字幕内容')
    expect(await fs.readFile(target, 'utf8')).toBe('先到的未知文件')
  })

  it('跨卷接管复制失败时保持原文件和中断意图，不伪报接管成功', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const file = workspace.task.files[0]!
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('模拟跨卷'), { code: 'EXDEV' }))
    vi.spyOn(fs, 'copyFile').mockRejectedValue(
      Object.assign(new Error('模拟磁盘空间不足'), { code: 'ENOSPC' }),
    )
    await expect(
      f.service.claimSource(workspace.directory, workspace.task.id, file.id, 0, signal()),
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离媒体内容')
    const { task } = await new TaskJournal(workspace.directory, workspace.task.id).read()
    expect(task.files[0]?.sources[0]?.state).toBe('claiming')
    expect(task.files[0]?.artifacts[0]?.state).toBe('reserved')
  })

  it('跨卷复制完成并核对内容后才删除来源；任务取消后不接管剩余文件', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const file = workspace.task.files[0]!
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('模拟跨卷'), { code: 'EXDEV' }))
    const task = await f.service.claimSource(
      workspace.directory,
      workspace.task.id,
      file.id,
      0,
      signal(),
    )
    expect(await fs.readFile(join(workspace.directory, file.sources[0]!.target), 'utf8')).toBe(
      '隔离媒体内容',
    )
    await expect(fs.stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
    await new TaskJournal(workspace.directory).update(task.revision, { state: 'cancelled' })
    await expect(
      f.service.claimSource(workspace.directory, workspace.task.id, file.id, 1, signal()),
    ).rejects.toThrow('当前任务不允许接管')
    expect(await fs.readFile(f.subtitle, 'utf8')).toBe('隔离字幕内容')
  })

  it('来源已移动但完成事件未写入时可发现意图和有效文件，不自动重跑', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const file = workspace.task.files[0]!
    const original = TaskJournal.prototype.update
    vi.spyOn(TaskJournal.prototype, 'update').mockImplementation(function (
      this: TaskJournal,
      revision,
      patch,
    ) {
      if (revision === 1) throw new Error('模拟完成事件写入前退出')
      return original.call(this, revision, patch)
    })
    await expect(
      f.service.claimSource(workspace.directory, workspace.task.id, file.id, 0, signal()),
    ).rejects.toThrow('模拟完成事件')
    const discovered = await new TaskWorkspaces(f.data).discover()
    expect(discovered).toHaveLength(1)
    expect(discovered[0]).toMatchObject({ kind: 'task', task: { revision: 1, state: 'running' } })
    expect(await fs.readFile(join(workspace.directory, file.sources[0]!.target), 'utf8')).toBe(
      '隔离媒体内容',
    )
    await expect(fs.stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('历史工作根继续发现；离线和损坏索引不静默覆盖或遗忘', async () => {
    const f = await fixture()
    await f.create()
    const next = join(f.root, '新下载')
    await fs.mkdir(next)
    expect((await new TaskWorkspaces(f.data).discover(next))[0]?.kind).toBe('task')
    await fs.rename(f.download, join(f.root, '离线下载'))
    expect((await f.service.discover(next))[0]?.kind).toBe('unavailable')
    expect(await f.service.registeredRoots()).toEqual([f.download])
    const registry = join(f.data, '任务工作根.json')
    await fs.writeFile(registry, '{损坏内容')
    await expect(f.service.create(next, f.draft, [f.preprocess])).rejects.toThrow(
      '索引版本或内容无效',
    )
    expect(await fs.readFile(registry, 'utf8')).toBe('{损坏内容')
    expect(await fs.readdir(next)).toEqual([])
  })

  it('不跟随任务根或输入目录中的联接，未知目录只报告不清理', async () => {
    const f = await fixture()
    const external = join(f.root, '其他文件')
    await fs.mkdir(external)
    await fs.symlink(
      external,
      join(f.download, '.work'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(f.create()).rejects.toThrow('链接')
    expect(await fs.readdir(external)).toEqual([])
    expect((await f.service.discover())[0]?.kind).toBe('unavailable')
    await fs.unlink(join(f.download, '.work'))
    const workspace = await f.create()
    await fs.mkdir(join(f.download, '.work', '未知目录'))
    const file = workspace.task.files[0]!
    await fs.symlink(
      external,
      join(workspace.directory, file.directory),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(
      f.service.claimSource(workspace.directory, workspace.task.id, file.id, 0, signal()),
    ).rejects.toThrow('链接')
    expect(await fs.readFile(f.source, 'utf8')).toBe('隔离媒体内容')
    expect((await f.service.discover()).some((entry) => entry.kind === 'unrecognized')).toBe(true)
    await expect(safeRoot(workspace.directory, [])).rejects.toThrow('任务工作目录')
  })
})

describe('任务清单与执行记录', () => {
  it.each([
    '../影片.mkv',
    '/影片.mkv',
    'C:/影片.mkv',
    'a\\影片.mkv',
    'a/../影片.mkv',
    'a//b',
    'a/NUL.mkv',
    'a/影片.',
  ])('拒绝内部路径：%s', (path) => {
    expect(taskRelativePathSchema.safeParse(path).success).toBe(false)
  })

  it('拒绝未知版本、任意命令、越界产物、重复来源及伪造完成', async () => {
    const f = await fixture()
    const { task } = await f.create()
    expect(taskManifestSchema.safeParse({ ...task, version: 2 }).success).toBe(false)
    expect(taskManifestSchema.safeParse({ ...task, command: '任意执行' }).success).toBe(false)
    expect(taskManifestSchema.safeParse({ ...task, state: 'completed' }).success).toBe(false)
    const duplicate = structuredClone(task)
    duplicate.files.push({
      ...duplicate.files[0]!,
      id: '22222222-2222-4222-8222-222222222222',
      directory: '第二个文件',
    })
    expect(taskManifestSchema.safeParse(duplicate).success).toBe(false)
    expect(
      taskConfirmationSchema.safeParse({ planId: task.id, revision: 0, directory: f.download })
        .success,
    ).toBe(false)
  })

  it('修订号冲突、并发写入和原始清单改写被拒绝，已提交状态保留', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const journal = new TaskJournal(workspace.directory, workspace.task.id)
    const results = await Promise.allSettled([
      journal.update(0, { message: '第一次' }),
      new TaskJournal(workspace.directory).update(0, { message: '第二次' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((await journal.read()).task.revision).toBe(1)
    await expect(journal.update(0, { message: '旧修订' })).rejects.toThrow('状态已变化')
    const file = structuredClone(workspace.task.files[0]!)
    file.sources[0]!.path = join(f.preprocess, '其他.mkv')
    await expect(journal.update(1, { files: [file] })).rejects.toThrow('原始清单不能')
  })

  it('事件已落盘但快照替换失败时，只读发现差异；显式修复后才允许继续', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const journal = new TaskJournal(workspace.directory, workspace.task.id)
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('模拟快照替换失败'))
    await expect(journal.update(0, { message: '事件已经完成' })).rejects.toThrow('模拟快照')
    rename.mockRestore()
    const before = await fs.readFile(join(workspace.directory, '任务状态.json'), 'utf8')
    expect(await journal.read()).toMatchObject({ snapshotNeedsRepair: true, task: { revision: 1 } })
    expect(await fs.readFile(join(workspace.directory, '任务状态.json'), 'utf8')).toBe(before)
    await expect(journal.update(1, { message: '不能直接继续' })).rejects.toThrow('快照尚未同步')
    await journal.repairSnapshot(1)
    expect((await journal.read()).snapshotNeedsRepair).toBe(false)
    expect((await journal.update(1, { message: '确认后继续' })).revision).toBe(2)
  })

  it('截断日志和中断写入锁保留原样，不擅自删除或截断后继续', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const journal = new TaskJournal(workspace.directory, workspace.task.id)
    const path = join(workspace.directory, '执行事件.jsonl')
    await fs.appendFile(path, '{"kind":"updated"')
    const original = await fs.readFile(path, 'utf8')
    await expect(journal.read()).rejects.toThrow('被截断')
    expect(await fs.readFile(path, 'utf8')).toBe(original)
    const lock = join(workspace.directory, '写入锁.json')
    await fs.writeFile(lock, '旧进程记录')
    await expect(journal.update(0, { message: '不应继续' })).rejects.toThrow('中断写入锁')
    expect(await fs.readFile(lock, 'utf8')).toBe('旧进程记录')
  })

  it('落后快照被改写时拒绝当作正常中断修复，保留原始记录', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const journal = new TaskJournal(workspace.directory)
    await journal.update(0, { message: '正常写入' })
    const path = join(workspace.directory, '任务状态.json')
    const changed = JSON.stringify({ ...workspace.task, message: '改写的旧修订' })
    await fs.writeFile(path, changed)
    await expect(journal.repairSnapshot(1)).rejects.toThrow('内容不一致')
    expect(await fs.readFile(path, 'utf8')).toBe(changed)
  })

  it('任务目录替换或快照同修订内容不同时拒绝继续', async () => {
    const f = await fixture()
    const workspace = await f.create()
    const journal = new TaskJournal(workspace.directory, workspace.task.id)
    await journal.read()
    const path = join(workspace.directory, '任务状态.json')
    await fs.writeFile(path, JSON.stringify({ ...workspace.task, message: '外部改写' }))
    await expect(journal.read()).rejects.toThrow('内容不一致')
    await fs.rename(workspace.directory, workspace.directory + '-保留')
    await fs.mkdir(workspace.directory)
    await expect(journal.read()).rejects.toThrow('目录已被替换')
  })
})
