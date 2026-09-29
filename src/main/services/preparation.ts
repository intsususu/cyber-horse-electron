import { randomUUID } from 'node:crypto'
import {
  lstat,
  realpath,
  opendir,
  mkdir,
  open,
  link,
  unlink,
  rmdir,
  type FileHandle,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { homedir } from 'node:os'
import type { PreparationItem, PreparationPlan, PreparationState } from '../../shared/preparation'
import { isInternalMediaEntry } from '../../shared/media-files'
import { mediaExtensions } from './media-inputs'
import { canonicalVideoName } from './video-name'
import { ExecutionLock } from './execution-lock'

export const largeFileBytes = 1024 ** 3
type Fingerprint = { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
type SavedPlan = {
  view: PreparationPlan
  fingerprints: Map<string, Fingerprint>
  directoryIds: Map<string, { ino: number; dev: number }>
}
type Directories = { download: string; preprocess: string }
const key = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const within = (root: string, path: string) =>
  key(path) === key(root) || key(path).startsWith(key(root) + sep)
const overlaps = (a: string, b: string) => within(a, b) || within(b, a)
const sameFile = (a: Fingerprint, b: Fingerprint) =>
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.ino === b.ino &&
  a.dev === b.dev
// 创建硬链接会更新 Windows 的 ctime；核对移动中的同一文件时只比较内容身份字段。
const sameContentIdentity = (a: Fingerprint, b: Fingerprint) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev
const stamp = (): string => new Date().toISOString()

/** 检查每一级目录，拒绝符号链接、联接和非普通目录。 */
async function directory(path: string): Promise<void> {
  const root = parse(path).root
  let current = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('目录中包含链接或非普通目录，请重新配置。')
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function message(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC') return '磁盘空间不足，未完成项的源文件已保留。'
  if (code === 'EEXIST') return '目标已存在，已停止且没有覆盖文件。请重新预览。'
  if (code) return '文件操作失败，请检查目录权限、文件占用及磁盘连接。未完成项的源文件已保留。'
  return error instanceof Error ? error.message : '预处理失败，未完成项的源文件已保留。'
}

export class PreparationService {
  private plan: SavedPlan | null = null
  private busy = false
  private abort = false
  private state: PreparationState | null = null
  private work: Promise<void> | null = null

  constructor(
    private readonly dataDirectory: string,
    private readonly protectedDirectories: string[] = [],
    // 只允许服务测试注入阈值；桌面接口不接受阈值或任意路径。
    private readonly threshold = largeFileBytes,
    private readonly lock = new ExecutionLock(),
  ) {}

  snapshot(): PreparationState | null {
    return this.state ? structuredClone(this.state) : null
  }
  get active(): boolean {
    return this.busy
  }
  async wait(): Promise<void> {
    await this.work
  }
  cancel(): void {
    if (this.state?.status === 'running') {
      this.abort = true
      this.state = {
        ...this.state,
        status: 'cancelling',
        message: '正在停止；已完成操作保留，尚未处理的文件留在原处。',
      }
    }
  }
  private checkpoint(): void {
    if (this.abort) throw new Error('预处理已取消，尚未处理的文件留在原处。')
  }

  private async validate(paths: Directories): Promise<Directories> {
    const canonical: string[] = []
    for (const path of [paths.download, paths.preprocess]) {
      if (
        !path ||
        !isAbsolute(path) ||
        path.includes('\0') ||
        path.startsWith('\\\\?\\') ||
        path.startsWith('\\\\.\\')
      )
        throw new Error('请配置普通绝对路径，不支持设备路径。')
      await directory(resolve(path))
      const resolved = await realpath(resolve(path))
      const protectedTrees = [
        this.dataDirectory,
        ...this.protectedDirectories,
        process.env.SystemRoot,
        process.env.ProgramFiles,
        process.env['ProgramFiles(x86)'],
      ].filter((value): value is string => !!value)
      if (
        key(resolved) === key(parse(resolved).root) ||
        within(resolved, homedir()) ||
        protectedTrees.some((value) => overlaps(resolved, value))
      )
        throw new Error('不能使用磁盘根目录、用户根目录、系统或应用目录进行预处理。')
      await directory(resolved)
      canonical.push(resolved)
    }
    const result = { download: canonical[0]!, preprocess: canonical[1]! }
    if (overlaps(result.download, result.preprocess))
      throw new Error('下载目录和预处理目录不能相同或互相包含。')
    if ((await lstat(result.download)).dev !== (await lstat(result.preprocess)).dev)
      throw new Error('下载目录和预处理目录不在同一卷，无法快速移动。')
    return result
  }

  async preview(paths: Directories): Promise<PreparationPlan> {
    if (this.busy) throw new Error('预处理正在读取或执行，请稍候。')
    const release = this.lock.acquire('预处理')
    this.busy = true
    this.plan = null
    try {
      const roots = await this.validate(paths)
      const id = randomUUID()
      const view: PreparationPlan = {
        id,
        createdAt: Date.now(),
        ...roots,
        items: [],
        cleanupDirectories: [],
        warnings: [],
      }
      const fingerprints = new Map<string, Fingerprint>()
      const directoryIds = new Map<string, { ino: number; dev: number }>()
      const downloads: string[] = []
      const existingVideos: string[] = []
      const downloadDirectories: string[] = []
      let visited = 0
      const started = Date.now()
      const scan = async (root: string, recursive: boolean, files: string[]) => {
        const pending = [root]
        while (pending.length) {
          const current = pending.pop()!
          await directory(current)
          for await (const entry of await opendir(current)) {
            if (++visited > 100000 || Date.now() - started > 20000)
              throw new Error('目录范围过大或扫描超时，请缩小范围后重试。')
            if (isInternalMediaEntry(entry.name)) continue
            const path = join(current, entry.name)
            const info = await lstat(path)
            if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
              throw new Error(
                '扫描范围包含链接或特殊文件；为避免误清理，请移出这些项目后重新预览。',
              )
            }
            if (info.isDirectory()) {
              if (recursive) {
                pending.push(path)
                downloadDirectories.push(path)
                directoryIds.set(path, { ino: info.ino, dev: info.dev })
              }
              continue
            }
            if (!recursive && !mediaExtensions.includes(extname(path).slice(1).toLowerCase()))
              continue
            if (files.length >= 5000) throw new Error('文件超过 5000 个，请缩小目录范围。')
            files.push(path)
            fingerprints.set(path, {
              size: info.size,
              mtimeMs: info.mtimeMs,
              ctimeMs: info.ctimeMs,
              ino: info.ino,
              dev: info.dev,
            })
          }
        }
        files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
      }
      await scan(roots.download, true, downloads)
      await scan(roots.preprocess, false, existingVideos)
      view.cleanupDirectories = downloadDirectories.sort(
        (a, b) => b.split(sep).length - a.split(sep).length || a.localeCompare(b, 'zh-CN'),
      )
      const reserved = new Set<string>()
      const add = async (source: string, action: PreparationItem['action']) => {
        const size = fingerprints.get(source)!.size
        const extension = extname(source)
        const base = basename(source, extension)
        const video = mediaExtensions.includes(extension.slice(1).toLowerCase())
        const normalized = video ? canonicalVideoName(base) : null
        if (
          action === 'rename' &&
          (!normalized || normalized === base || new RegExp(`^${normalized}_\\d+$`).test(base))
        )
          return
        let target: string | null = null
        if (action !== 'cleanup') {
          let count = 0
          do {
            target = join(
              roots.preprocess,
              `${normalized ?? base}${count ? `_${count}` : ''}${extension}`,
            )
            count++
          } while (reserved.has(key(target)) || (await exists(target)))
          reserved.add(key(target))
        }
        view.items.push({
          id: view.items.length + 1,
          action,
          source,
          target,
          size,
          note:
            action === 'cleanup'
              ? '小于 1 GiB'
              : video && !normalized
                ? '未识别编号，保留原名'
                : '',
        })
      }
      // 先处理大文件和已有视频；全部成功后才整理下载残留。
      for (const path of downloads)
        if (fingerprints.get(path)!.size >= this.threshold) await add(path, 'extract')
      for (const path of existingVideos) await add(path, 'rename')
      for (const path of downloads)
        if (fingerprints.get(path)!.size < this.threshold) await add(path, 'cleanup')
      if (!view.items.some((item) => item.action === 'extract'))
        view.warnings.push(
          '下载目录没有达到 1 GiB 的文件。清单内的小视频、字幕及其他残留将直接删除。',
        )
      if (view.items.some((item) => item.note === '未识别编号，保留原名'))
        view.warnings.push('部分视频无法识别编号，将保留原名。')
      if (view.items.some((item) => item.target))
        view.warnings.push(
          '大文件提取与视频重命名使用同卷快速移动；全部移动成功后，直接删除清单内的下载残留。',
        )
      this.plan = { view, fingerprints, directoryIds }
      return structuredClone(view)
    } catch (error) {
      throw new Error(message(error))
    } finally {
      this.busy = false
      release()
    }
  }

  async start(id: string, paths: Directories): Promise<PreparationState> {
    if (this.busy) throw new Error('已有预处理正在运行，请等待完成或取消。')
    const plan = this.plan
    if (!plan || id !== plan.view.id || Date.now() - plan.view.createdAt > 10 * 60_000)
      throw new Error('预览已失效，请重新生成清单。')
    if (!plan.view.items.length && !plan.view.cleanupDirectories.length)
      throw new Error('清单为空，没有可执行的操作。')
    const release = this.lock.acquire('预处理')
    this.busy = true
    this.abort = false
    this.plan = null
    try {
      const roots = await this.validate(paths)
      if (
        key(roots.download) !== key(plan.view.download) ||
        key(roots.preprocess) !== key(plan.view.preprocess)
      )
        throw new Error('目录配置已经变化，请重新预览。')
      // 在首个写操作前复核整个计划；新增文件不进入此次清理。
      for (const item of plan.view.items) await this.checkItem(item, plan)
      const journal = join(this.dataDirectory, 'preparation', `${id}.jsonl`)
      await mkdir(dirname(journal), { recursive: true })
      const log = await open(journal, 'wx')
      try {
        await log.writeFile(JSON.stringify({ type: 'plan', plan: plan.view }) + '\n')
        await log.sync()
      } catch (error) {
        await log.close()
        throw error
      }
      this.state = {
        id,
        status: 'running',
        completed: 0,
        total: plan.view.items.length + plan.view.cleanupDirectories.length,
        message: '正在准备文件',
        startedAt: stamp(),
        journal,
      }
      this.work = this.execute(plan, log).finally(release)
      return this.snapshot()!
    } catch (error) {
      this.busy = false
      release()
      throw new Error(message(error))
    }
  }

  private async checkItem(item: PreparationItem, plan: SavedPlan): Promise<void> {
    const sourceRoot = item.action === 'rename' ? plan.view.preprocess : plan.view.download
    if (
      !within(sourceRoot, item.source) ||
      (item.target &&
        (!within(plan.view.preprocess, item.target) ||
          dirname(item.target) !== plan.view.preprocess))
    )
      throw new Error('文件超出计划目录边界，已停止。')
    await directory(dirname(item.source))
    await directory(plan.view.preprocess)
    const info = await lstat(item.source)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !sameFile(info, plan.fingerprints.get(item.source)!)
    )
      throw new Error('源文件已变化，请等待下载完成后重新预览。')
    if (item.target && (await exists(item.target)))
      throw new Error('目标文件已出现，已停止以避免覆盖。请重新预览。')
  }

  private async moveVerified(
    item: PreparationItem,
    plan: SavedPlan,
    record: (value: unknown) => Promise<void>,
  ): Promise<void> {
    const target = item.target!
    const targetRoot = plan.view.preprocess
    if (!within(targetRoot, target)) throw new Error('目标文件超出计划目录边界，已停止。')
    const expected = plan.fingerprints.get(item.source)!
    const temporary = join(dirname(target), `.cyber-horse-${randomUUID()}.partial`)
    let temporaryOwned = false
    let targetOwned = false
    try {
      await directory(dirname(item.source))
      await directory(dirname(target))
      const before = await lstat(item.source)
      if (!before.isFile() || before.isSymbolicLink() || !sameFile(before, expected))
        throw new Error('源文件已变化，请重新预览。')
      if (before.dev !== (await lstat(dirname(target))).dev)
        throw new Error('源目录和目标目录不在同一卷，无法快速移动；源文件已保留。')
      // 独占创建临时目录项。硬链接与源文件指向相同内容，不读取或复制大文件。
      await link(item.source, temporary)
      temporaryOwned = true
      const provisional = await lstat(temporary)
      if (!provisional.isFile() || !sameContentIdentity(provisional, expected))
        throw new Error('快速移动的文件身份校验失败，源文件已保留。')
      this.checkpoint()
      // link 不会覆盖已有名称；在移走原路径前，先提交并核对完整输出。
      await link(temporary, target)
      targetOwned = true
      const submitted = await lstat(target)
      const original = await lstat(item.source)
      if (
        !submitted.isFile() ||
        !sameContentIdentity(submitted, expected) ||
        !sameContentIdentity(original, expected)
      )
        throw new Error('快速移动的输出校验失败，源文件已保留。')
      this.checkpoint()
      await record({ type: 'linked', item: item.id, at: stamp() })
      await unlink(item.source)
      targetOwned = false
    } catch (error) {
      // 原路径仍存在时只撤销本次独占创建、且仍指向同一文件的目标。
      if (targetOwned && (await exists(item.source)) && (await exists(target))) {
        const current = await lstat(target)
        if (sameContentIdentity(current, expected)) await unlink(target)
      }
      throw error
    } finally {
      if (temporaryOwned && (await exists(temporary))) {
        await directory(dirname(temporary))
        const current = await lstat(temporary)
        if (sameContentIdentity(current, expected)) await unlink(temporary)
      }
    }
  }

  private async removeEmptyDirectories(
    plan: SavedPlan,
    record: (value: unknown) => Promise<void>,
  ): Promise<{ removed: number; kept: number }> {
    let removed = 0
    let kept = 0
    const root = plan.view.download
    for (const path of plan.view.cleanupDirectories) {
      this.checkpoint()
      if (path === root || !within(root, path))
        throw new Error('待清理文件夹超出下载目录边界，已停止。')
      try {
        await directory(path)
        const current = await lstat(path)
        const expected = plan.directoryIds.get(path)
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          !expected ||
          current.ino !== expected.ino ||
          current.dev !== expected.dev
        ) {
          kept++
          await record({ type: 'directoryKept', path, reason: 'changed', at: stamp() })
          this.state!.completed++
          continue
        }
        await rmdir(path)
        removed++
        await record({ type: 'directoryRemoved', path, at: stamp() })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw error
        kept++
        await record({ type: 'directoryKept', path, reason: code, at: stamp() })
      }
      this.state!.completed++
    }
    return { removed, kept }
  }

  private async execute(plan: SavedPlan, log: FileHandle): Promise<void> {
    let finalState: PreparationState
    const record = async (value: unknown) => {
      await log.writeFile(JSON.stringify(value) + '\n')
      await log.sync()
    }
    try {
      for (const item of plan.view.items) {
        this.checkpoint()
        await this.checkItem(item, plan)
        this.checkpoint()
        await record({ type: 'begin', item: item.id, at: stamp() })
        this.state!.message = `${item.action === 'cleanup' ? '删除残留' : '快速移动'}：${basename(item.source)}`
        if (item.action === 'cleanup') {
          await this.checkItem(item, plan)
          this.checkpoint()
          await unlink(item.source)
        } else await this.moveVerified(item, plan, record)
        await record({ type: 'completed', item: item.id, at: stamp() })
        this.state!.completed++
      }
      this.state!.message = '正在清理空文件夹'
      const directories = await this.removeEmptyDirectories(plan, record)
      finalState = {
        ...this.state!,
        status: 'succeeded',
        endedAt: stamp(),
        message: `预处理完成，已移除 ${directories.removed} 个空文件夹${directories.kept ? `，${directories.kept} 个文件夹仍有内容或已变化，予以保留` : ''}。`,
      }
    } catch (error) {
      finalState = {
        ...this.state!,
        status: this.abort ? 'cancelled' : 'failed',
        endedAt: stamp(),
        message: this.abort ? '预处理已取消，已完成项保留，其余源文件未清理。' : message(error),
      }
    } finally {
      try {
        await record({ type: 'finished', state: finalState! })
      } catch {
        finalState = {
          ...this.state!,
          status: 'failed',
          message: '执行记录保存失败，请按已有清单核对原目录和输出。',
          endedAt: stamp(),
        }
      }
      await log.close().catch(() => {})
      this.state = finalState!
      this.busy = false
    }
  }
}
