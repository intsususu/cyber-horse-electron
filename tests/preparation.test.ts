import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import { PreparationService, largeFileBytes } from '../src/main/services/preparation'
import { canonicalVideoName } from '../src/main/services/video-name'
import { preparationRequestSchema } from '../src/shared/preparation'
import { collectMediaInputs } from '../src/main/services/media-inputs'
import { emptyRun, runReducer } from '../src/renderer/src/lib/workflow'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}))

const temporary: string[] = []
async function fixture(threshold = 32) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'horse-preparation-')))
  temporary.push(root)
  const paths = { download: join(root, '下载'), preprocess: join(root, '预处理') }
  await fs.mkdir(paths.download)
  await fs.mkdir(paths.preprocess)
  const service = new PreparationService(join(root, '应用数据'), [], threshold)
  const source = join(paths.download, 'prefix@abc-123-uc_restored.mp4')
  await fs.writeFile(source, Buffer.alloc(128 * 1024, 73))
  await fs.writeFile(join(paths.download, '说明.txt'), '残留')
  return { root, paths, service, source }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of temporary.splice(0)) {
    if (
      !resolve(root).startsWith((await fs.realpath(tmpdir())) + sep) ||
      !parse(root).base.startsWith('horse-preparation-')
    )
      throw new Error('测试目录越界')
    await fs.rm(root, { recursive: true, force: true })
  }
})
describe('提取清理并重命名', () => {
  it.each([
    ['abc123_restored', 'ABC-123'],
    ['prefix@abp-001-u', 'ABP-001-U'],
    ['abp001.C', 'ABP-001-C'],
    ['abc-123-uc', 'ABC-123-UC'],
    ['hello', null],
  ])('沿用编号规则：%s', (source, expected) => expect(canonicalVideoName(source)).toBe(expected))

  it('默认门槛为 1 GiB，预览没有文件副作用且完整列出小视频和残留', async () => {
    const { paths, root, source } = await fixture()
    const service = new PreparationService(join(root, '应用数据'))
    expect(largeFileBytes).toBe(1024 ** 3)
    const plan = await service.preview(paths)
    expect(plan.items.every((item) => item.action === 'cleanup')).toBe(true)
    expect(await fs.stat(source)).toBeDefined()
    expect(await fs.readdir(paths.preprocess)).toEqual([])
    expect(await fs.readdir(paths.download)).toHaveLength(2)
  })

  it('同卷快速提取及重命名，直接删除残留；不覆盖已有同名且重跑稳定', async () => {
    const { paths, service, source } = await fixture()
    await fs.writeFile(join(paths.preprocess, 'ABC-123-UC.mp4'), '保留已有输出')
    await fs.writeFile(join(paths.preprocess, 'def456_restored.mkv'), '已有视频需要改名')
    await fs.mkdir(join(paths.download, '子目录'))
    await fs.writeFile(join(paths.download, '子目录', '附件.dat'), Buffer.alloc(64, 1))
    await fs.mkdir(join(paths.download, '空文件夹'))
    const plan = await service.preview(paths)
    expect(plan.cleanupDirectories).toHaveLength(2)
    expect(plan.cleanupDirectories).toEqual(
      expect.arrayContaining([join(paths.download, '子目录'), join(paths.download, '空文件夹')]),
    )
    const extracted = plan.items.find((item) => item.source === source)!
    expect(extracted.target).toBe(join(paths.preprocess, 'ABC-123-UC_1.mp4'))
    expect(plan.items.map((item) => item.action)).toEqual([
      'extract',
      'extract',
      'rename',
      'cleanup',
    ])
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()).toMatchObject({ status: 'succeeded', completed: 6, total: 6 })
    expect(await fs.readFile(extracted.target!)).toEqual(Buffer.alloc(128 * 1024, 73))
    expect(await fs.readFile(join(paths.preprocess, 'ABC-123-UC.mp4'), 'utf8')).toBe('保留已有输出')
    for (const item of plan.items) {
      if (item.action !== 'cleanup') expect((await fs.stat(item.target!)).size).toBe(item.size)
      await expect(fs.stat(item.source)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(fs.stat(join(paths.download, '子目录'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(join(paths.download, '空文件夹'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await fs.stat(paths.download)).toBeDefined()
    expect(await fs.readdir(paths.download)).toEqual([])
    const records = (await fs.readFile(service.snapshot()!.journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records.filter((record) => record.type === 'completed')).toHaveLength(4)
    expect((await collectMediaInputs([paths.preprocess], true, true)).files).toHaveLength(3)
    expect((await service.preview(paths)).items).toEqual([])
  })

  it('保留无法识别编号的文件名称，并在同批重名时分配独立目标', async () => {
    const { paths, service } = await fixture()
    await fs.writeFile(join(paths.download, '说明附件.bin'), Buffer.alloc(64))
    await fs.writeFile(join(paths.download, 'abc123uc.mp4'), Buffer.alloc(64))
    const plan = await service.preview(paths)
    const targets = plan.items.filter((item) => item.target).map((item) => item.target)
    expect(new Set(targets).size).toBe(targets.length)
    expect(targets).toContain(join(paths.preprocess, '说明附件.bin'))
  })

  it('拒绝空、相对、根、用户根、重叠及受保护目录', async () => {
    const { paths, root, service } = await fixture()
    for (const download of ['', 'relative', parse(root).root, homedir(), paths.preprocess, root]) {
      await expect(service.preview({ ...paths, download })).rejects.toThrow()
    }
    const protectedService = new PreparationService(join(root, '应用数据'), [paths.download])
    await expect(protectedService.preview(paths)).rejects.toThrow('系统或应用目录')
  })

  it('拒绝目录联接，包括配置路径的上级联接', async () => {
    const { paths, root, service } = await fixture()
    const alias = join(root, '链接')
    await fs.symlink(paths.download, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.preview({ ...paths, download: alias })).rejects.toThrow('链接')
    await fs.mkdir(join(paths.download, '子目录'))
    await expect(service.preview({ ...paths, download: join(alias, '子目录') })).rejects.toThrow(
      '链接',
    )
    await fs.symlink(
      paths.preprocess,
      join(paths.download, '链接'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(service.preview(paths)).rejects.toThrow('链接')
  })

  it('计划被替换、过期、配置变化或参数带路径时拒绝执行', async () => {
    const { paths, service } = await fixture()
    const old = await service.preview(paths)
    const plan = await service.preview(paths)
    await expect(service.start(old.id, paths)).rejects.toThrow('失效')
    expect(
      preparationRequestSchema.safeParse({ planId: plan.id, path: paths.download }).success,
    ).toBe(false)
    await expect(
      service.start(plan.id, { download: paths.preprocess, preprocess: paths.download }),
    ).rejects.toThrow('配置已经变化')
    const expiring = await service.preview(paths)
    vi.spyOn(Date, 'now').mockReturnValue(expiring.createdAt + 600001)
    await expect(service.start(expiring.id, paths)).rejects.toThrow('失效')
  })

  it('执行前源变化或目标出现时整批拒绝，无清理副作用', async () => {
    const { paths, service, source } = await fixture()
    const first = await service.preview(paths)
    await fs.appendFile(source, '下载仍在写入')
    await expect(service.start(first.id, paths)).rejects.toThrow('变化')
    const second = await service.preview(paths)
    await fs.writeFile(second.items[0]!.target!, '并发创建的目标')
    await expect(service.start(second.id, paths)).rejects.toThrow('目标文件已出现')
    expect(await fs.readFile(join(paths.download, '说明.txt'), 'utf8')).toBe('残留')
  })

  it('新文件不进入冻结的清理清单', async () => {
    const { paths, service } = await fixture()
    const plan = await service.preview(paths)
    const added = join(paths.download, '新增.txt')
    await fs.writeFile(added, '应保留')
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()?.status).toBe('succeeded')
    expect(await fs.readFile(added, 'utf8')).toBe('应保留')
  })

  it('只清理预览列出的空文件夹，保留运行前新出现的文件和文件夹', async () => {
    const { paths, service } = await fixture()
    const existing = join(paths.download, '原文件夹')
    const added = join(paths.download, '新文件夹')
    await fs.mkdir(existing)
    await fs.writeFile(join(existing, '附件.txt'), '应直接删除')
    const plan = await service.preview(paths)
    expect(plan.cleanupDirectories).toEqual([existing])
    await fs.writeFile(join(existing, '新增.txt'), '应保留')
    await fs.mkdir(added)
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()).toMatchObject({ status: 'succeeded' })
    expect(service.snapshot()?.message).toContain('1 个文件夹仍有内容')
    expect(await fs.readFile(join(existing, '新增.txt'), 'utf8')).toBe('应保留')
    expect(await fs.stat(added)).toBeDefined()
    expect(await fs.stat(paths.download)).toBeDefined()
  })

  it('只有遗留空文件夹时仍可执行清理，且不删除下载根目录', async () => {
    const { paths, service, source } = await fixture()
    await fs.unlink(source)
    await fs.unlink(join(paths.download, '说明.txt'))
    const parent = join(paths.download, '外层')
    const child = join(parent, '内层')
    await fs.mkdir(child, { recursive: true })
    const plan = await service.preview(paths)
    expect(plan.items).toEqual([])
    expect(plan.cleanupDirectories).toEqual([child, parent])
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()).toMatchObject({ status: 'succeeded', completed: 2, total: 2 })
    await expect(fs.stat(parent)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.stat(paths.download)).toBeDefined()
  })

  it('预览后的文件夹被替换时不删除新文件夹', async () => {
    const { paths, service } = await fixture()
    const path = join(paths.download, '待清理')
    await fs.mkdir(path)
    const plan = await service.preview(paths)
    await fs.rmdir(path)
    await fs.mkdir(path)
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()).toMatchObject({ status: 'succeeded' })
    expect(service.snapshot()?.message).toContain('1 个文件夹仍有内容或已变化')
    expect(await fs.stat(path)).toBeDefined()
  })

  it('取消和重复启动互斥，停止后源文件与残留保留', async () => {
    const { paths, service, source } = await fixture()
    const plan = await service.preview(paths)
    const starting = service.start(plan.id, paths)
    await expect(service.start(plan.id, paths)).rejects.toThrow('正在运行')
    await starting
    service.cancel()
    await service.wait()
    expect(service.snapshot()).toMatchObject({ status: 'cancelled', completed: 0 })
    expect((await fs.stat(source)).size).toBe(128 * 1024)
    expect(await fs.readFile(join(paths.download, '说明.txt'), 'utf8')).toBe('残留')
    expect(
      (await fs.readdir(paths.preprocess)).filter((name) => name.endsWith('.partial')),
    ).toEqual([])
  })

  it('提交失败保留源和全部残留，不留下未校验目标', async () => {
    const { paths, service, source } = await fixture()
    const empty = join(paths.download, '待清理空文件夹')
    await fs.mkdir(empty)
    const plan = await service.preview(paths)
    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('磁盘满'), { code: 'ENOSPC' }),
    )
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()).toMatchObject({ status: 'failed', completed: 0 })
    expect(service.snapshot()?.message).toContain('磁盘空间不足')
    expect((await fs.stat(source)).size).toBe(128 * 1024)
    expect(await fs.readFile(join(paths.download, '说明.txt'), 'utf8')).toBe('残留')
    expect(await fs.readdir(paths.preprocess)).toEqual([])
    expect(await fs.stat(empty)).toBeDefined()
  })

  it('目标在提交瞬间出现时不覆盖它', async () => {
    const { paths, service, source } = await fixture()
    const plan = await service.preview(paths)
    const realLink = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (from, target) => {
      if (target === plan.items[0]!.target) await fs.writeFile(target, '竞争写入')
      return realLink(from, target)
    })
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()?.status).toBe('failed')
    expect(await fs.readFile(plan.items[0]!.target!, 'utf8')).toBe('竞争写入')
    expect((await fs.stat(source)).size).toBe(128 * 1024)
  })

  it('快速移动的临时目录项身份不一致时不提交输出，源文件和残留保留', async () => {
    const { paths, service, source } = await fixture()
    const plan = await service.preview(paths)
    const realLstat = fs.lstat
    let spoofed = false
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const info = await realLstat(...args)
      if (String(args[0]).endsWith('.partial') && !spoofed) {
        spoofed = true
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
          size: Number(info.size) + 1,
        })
      }
      return info
    })
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()).toMatchObject({ status: 'failed', completed: 0 })
    expect(service.snapshot()?.message).toContain('身份校验失败')
    expect((await fs.stat(source)).size).toBe(128 * 1024)
    expect(await fs.readFile(join(paths.download, '说明.txt'), 'utf8')).toBe('残留')
    expect(await fs.readdir(paths.preprocess)).toEqual([])
  })

  it('大文件移动不读取媒体字节，成功后直接删除下载残留', async () => {
    const { paths, service, source } = await fixture()
    const plan = await service.preview(paths)
    const originalOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation((path, ...arguments_) => {
      if (path === source) throw new Error('快速移动不应读取源文件内容')
      return originalOpen(path, ...arguments_)
    })
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()?.status).toBe('succeeded')
    expect(await fs.readFile(plan.items[0]!.target!)).toEqual(Buffer.alloc(128 * 1024, 73))
    expect(await fs.readdir(paths.download)).toEqual([])
  })

  it('旧版本目录及中断的中间文件不重新进入删除或提取清单', async () => {
    const { paths, service } = await fixture()
    const old = join(paths.download, '.cyber-horse-recovery', '旧任务')
    await fs.mkdir(old, { recursive: true })
    await fs.writeFile(join(old, '旧文件.txt'), '历史文件')
    const partial = join(paths.download, '.horse-interrupted.partial')
    await fs.writeFile(partial, Buffer.alloc(100))
    const plan = await service.preview(paths)
    expect(plan.items.some((item) => item.source === partial || item.source.startsWith(old))).toBe(
      false,
    )
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()!.status).toBe('succeeded')
    expect(await fs.readFile(join(old, '旧文件.txt'), 'utf8')).toBe('历史文件')
    expect((await fs.stat(partial)).size).toBe(100)
  })
  it('整个 .work 排除提取和残留清理，不能把任务子目录配置为处理根', async () => {
    const { paths, service } = await fixture()
    const work = join(paths.download, '.work', '中断任务')
    await fs.mkdir(work, { recursive: true })
    await fs.writeFile(join(work, 'ABC-123-C.mkv'), Buffer.alloc(128))
    await fs.writeFile(join(work, '任务状态.json'), '{}')
    const plan = await service.preview(paths)
    expect(plan.items.some((item) => item.source.includes('.work'))).toBe(false)
    expect(plan.cleanupDirectories.some((path) => path.includes('.work'))).toBe(false)
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()?.status).toBe('succeeded')
    expect(await fs.readFile(join(work, 'ABC-123-C.mkv'))).toEqual(Buffer.alloc(128))
    expect(await fs.readFile(join(work, '任务状态.json'), 'utf8')).toBe('{}')
    await expect(service.preview({ ...paths, download: work })).rejects.toThrow('任务工作目录')
    await expect(service.preview({ ...paths, preprocess: work })).rejects.toThrow('任务工作目录')
  })

  it('快速移动提交前取消会清理自己的临时目录项并保留源文件', async () => {
    const { paths, service, source } = await fixture()
    const plan = await service.preview(paths)
    const realLink = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target)
      if (String(target).endsWith('.partial')) service.cancel()
    })
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()).toMatchObject({ status: 'cancelled', completed: 0 })
    expect((await fs.stat(source)).size).toBe(128 * 1024)
    expect(await fs.readdir(paths.preprocess)).toEqual([])
  })

  it('源路径移除失败时撤销本次目标且保留源文件，后续清理停止', async () => {
    const { paths, service, source } = await fixture()
    const plan = await service.preview(paths)
    const realUnlink = fs.unlink
    vi.spyOn(fs, 'unlink').mockImplementation((path) =>
      path === source
        ? Promise.reject(Object.assign(new Error('占用'), { code: 'EPERM' }))
        : realUnlink(path),
    )
    await service.start(plan.id, paths)
    await service.wait()
    expect(service.snapshot()?.status).toBe('failed')
    await expect(fs.stat(plan.items[0]!.target!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(source)).toEqual(Buffer.alloc(128 * 1024, 73))
    expect(await fs.readFile(join(paths.download, '说明.txt'), 'utf8')).toBe('残留')
  })

  it('真实进度不会被演示计时器或前端取消伪造，失败状态保留完成数', () => {
    const state = runReducer(emptyRun, {
      type: 'preparation',
      state: {
        id: '真实任务',
        status: 'running',
        completed: 1,
        total: 4,
        message: '校验中',
        startedAt: new Date().toISOString(),
        journal: '',
      },
    })
    expect(state.tasks[0]?.progress).toBe(25)
    expect(runReducer(state, { type: 'tick', now: '' })).toBe(state)
    expect(runReducer(state, { type: 'cancel', now: '' })).toBe(state)
    expect(runReducer(state, { type: 'clear' })).toBe(state)
    const failed = runReducer(state, {
      type: 'preparation',
      state: { ...state.preparation!, status: 'failed' },
    })
    expect(failed.tasks[0]).toMatchObject({ status: 'failed', progress: 25 })
  })
})
