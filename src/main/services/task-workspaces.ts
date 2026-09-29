import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import {
  taskManifestSchema,
  taskRootRegistrySchema,
  type TaskFile,
  type TaskManifest,
} from '../../shared/task-workspace'
import { isInternalMediaPath, taskWorkDirectoryName } from '../../shared/media-files'
import {
  checkDirectory,
  checkpoint,
  fileStamp,
  inside,
  moveChecked,
  pathKey,
  safeRoot,
  unchanged,
} from './safe-files'
import { canonicalVideoName } from './video-name'
import { mediaIdentity } from './media-identity'
import { TaskJournal, writeTaskJson } from './task-journal'

export type WorkspaceDraft = {
  origin: TaskManifest['origin']
  steps: TaskManifest['steps']
  destination: TaskManifest['destination']
  files: { path: string; companions?: string[] }[]
}
export type WorkspaceDiscovery =
  | { kind: 'task'; directory: string; task: TaskManifest; snapshotNeedsRepair: boolean }
  | { kind: 'unavailable' | 'unrecognized'; directory: string; message: string }

function displayName(files: TaskFile[]): string {
  const numbers = [...new Set(files.map((file) => file.number).filter(Boolean))]
  const first = numbers.slice(0, 2).join('、') || '未识别番号'
  return files.length > 2 ? `${first}等${files.length}个文件` : `${first}_${files.length}个文件`
}

function dateName(date: Date): string {
  const digits = (n: number, length = 2) => String(n).padStart(length, '0')
  return (
    `${date.getFullYear()}${digits(date.getMonth() + 1)}${digits(date.getDate())}-` +
    `${digits(date.getHours())}${digits(date.getMinutes())}${digits(date.getSeconds())}-` +
    digits(date.getMilliseconds(), 3)
  )
}

/** 目前供新执行器接入与隔离测试使用；不会在启动或读取配置时创建媒体目录。 */
export class TaskWorkspaces {
  private static pending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly dataDirectory: string,
    private readonly protectedPaths: string[] = [],
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const key = pathKey(this.dataDirectory)
    const next = (TaskWorkspaces.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    TaskWorkspaces.pending.set(key, next)
    const release = () => {
      if (TaskWorkspaces.pending.get(key) === next) TaskWorkspaces.pending.delete(key)
    }
    void next.then(release, release)
    return next
  }

  private async root(path: string): Promise<string> {
    return safeRoot(path, [this.dataDirectory, ...this.protectedPaths])
  }

  async registeredRoots(): Promise<string[]> {
    const file = join(this.dataDirectory, '任务工作根.json')
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return []
    await checkDirectory(this.dataDirectory)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024)
      throw new Error('任务工作根索引无效，已保留原文件。')
    try {
      return taskRootRegistrySchema.parse(JSON.parse(await readFile(file, 'utf8'))).roots
    } catch {
      throw new Error('任务工作根索引版本或内容无效，已保留原文件。')
    }
  }

  private async register(root: string): Promise<void> {
    const roots = await this.registeredRoots()
    if (roots.some((old) => pathKey(old) === pathKey(root))) return
    const next = taskRootRegistrySchema.parse({ version: 1, roots: [...roots, root] })
    await mkdir(this.dataDirectory, { recursive: true })
    await writeTaskJson(this.dataDirectory, '任务工作根.json', next)
  }

  async create(
    savedDownloadRoot: string,
    draft: WorkspaceDraft,
    savedSourceRoots: string[],
  ): Promise<{ directory: string; task: TaskManifest }> {
    return this.serial(async () => {
      const downloadRoot = await this.root(savedDownloadRoot)
      const allowed = await Promise.all(savedSourceRoots.map((path) => this.root(path)))
      const destination = { ...draft.destination, root: await this.root(draft.destination.root) }
      const id = randomUUID()
      const now = new Date()
      const files: TaskFile[] = []
      for (const [index, entry] of draft.files.entries()) {
        const source = join(await checkDirectory(dirname(entry.path)), basename(entry.path))
        if (isInternalMediaPath(source) || !allowed.some((root) => inside(root, source)))
          throw new Error('任务来源超出已保存目录或位于内部工作目录。')
        const originalStem = basename(source, extname(source))
        const identity = mediaIdentity(source)
        const canonical = /(?:-CD\d+|-part\d+)/i.test(originalStem)
          ? null
          : canonicalVideoName(originalStem)
        const stem = canonical ?? originalStem
        const number = canonical?.replace(/-(?:UC|U|C)$/i, '') ?? null
        const directory = `${number ?? '未识别番号'}_${String(index + 1).padStart(2, '0')}`
        const sources: TaskFile['sources'] = []
        for (const path of [source, ...(entry.companions ?? [])]) {
          const parent = await checkDirectory(dirname(path))
          if (pathKey(parent) !== pathKey(dirname(source)))
            throw new Error('关联文件必须位于所选视频的同一目录。')
          const stamp = await fileStamp(path)
          if (!stamp.size) throw new Error('任务输入包含空文件，未接管来源。')
          const filename = basename(path)
          const suffix = filename.slice(originalStem.length)
          const companion =
            filename.toLowerCase().startsWith(originalStem.toLowerCase()) &&
            /^(?:\.|-(?:poster|thumb|fanart)\.)/i.test(suffix)
          if (path !== source && !companion && !/^(?:poster|thumb|fanart)\./i.test(filename))
            throw new Error('关联文件不属于所选视频，未接管来源。')
          sources.push({
            path: join(parent, filename),
            stamp,
            target: `${directory}/输入/${companion ? stem + suffix : filename}`,
            state: 'pending',
          })
        }
        const mark = (present: boolean) => ({
          present,
          evidence: present ? ('filename' as const) : ('none' as const),
        })
        files.push({
          id: randomUUID(),
          name: basename(source),
          number,
          directory,
          sources,
          marks: {
            chinese: mark(identity.chinese),
            restored: mark(identity.restored),
          },
          steps: draft.steps.map((step) => ({
            id: step,
            state: 'pending',
            startedAt: null,
            endedAt: null,
            message: '',
            inputVideo: null,
            outputVideo: null,
            outputFiles: [],
          })),
          artifacts: [],
        })
      }
      const name = displayName(files)
      const workspaceName = `${name}_${dateName(now)}_${id.slice(0, 8)}`
      const task = taskManifestSchema.parse({
        version: 1,
        id,
        revision: 0,
        name,
        origin: draft.origin,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        downloadRoot,
        workspaceName,
        destination,
        state: 'queued',
        steps: draft.steps,
        files,
        message: '等待执行；来源文件尚未移动。',
      })
      const root = join(downloadRoot, taskWorkDirectoryName)
      const directory = join(root, workspaceName)
      const longest = Math.max(
        ...files.flatMap((file) =>
          file.sources.map((source) => join(directory, source.target).length),
        ),
      )
      if (longest > 220) throw new Error('任务完整路径过长，请缩短下载目录或文件名称。')
      // 先登记历史根；即使创建任务时中断，下次仍能发现残留，不能在配置变更后遗忘。
      await this.register(downloadRoot)
      await mkdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      await checkDirectory(root)
      await mkdir(directory)
      const journal = new TaskJournal(directory, id)
      await journal.create(task)
      return { directory, task }
    })
  }

  async claimSource(
    directory: string,
    taskId: string,
    fileId: string,
    sourceIndex: number,
    signal: AbortSignal,
  ): Promise<TaskManifest> {
    return this.serial(async () => {
      checkpoint(signal)
      const journal = await this.openJournal(directory, taskId)
      const current = await journal.read()
      if (current.snapshotNeedsRepair) throw new Error('任务快照需要确认修复，未移动文件。')
      if (!['queued', 'running'].includes(current.task.state))
        throw new Error('当前任务不允许接管输入，请先确认恢复或重新创建任务。')
      const file = current.task.files.find((entry) => entry.id === fileId)
      const source = file?.sources[sourceIndex]
      if (!file || !source) throw new Error('任务来源标识无效。')
      if (source.state !== 'pending') throw new Error('来源已经接管或存在中断操作，请先核对。')
      await this.root(current.task.downloadRoot)
      await this.root(dirname(source.path))
      await unchanged(source.path, source.stamp)
      const target = join(directory, source.target)
      if (!inside(directory, target)) throw new Error('任务输入目标越界。')
      const nextFile = structuredClone(file)
      nextFile.sources[sourceIndex]!.state = 'claiming'
      nextFile.artifacts.push({
        path: source.target,
        role: 'input',
        state: 'reserved',
        stamp: null,
        sha256: null,
      })
      const prepared = await journal.update(current.task.revision, {
        state: 'running',
        files: [nextFile],
        message: '正在接管任务输入。',
      })
      await checkDirectory(directory)
      // 每层独占检查，拒绝已有联接目录，不能只对叶子目录做检查。
      let parent = directory
      for (const part of relative(directory, dirname(target)).split(/[\\/]/)) {
        parent = join(parent, part)
        await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
        await checkDirectory(parent)
      }
      checkpoint(signal)
      await unchanged(source.path, source.stamp)
      await moveChecked(source.path, target, signal)
      const stamp = await fileStamp(target)
      nextFile.sources[sourceIndex]!.state = 'claimed'
      const artifact = nextFile.artifacts.find((entry) => entry.path === source.target)!
      artifact.state = 'verified'
      artifact.stamp = stamp
      return journal.update(prepared.revision, {
        files: [nextFile],
        message: '任务输入已接管并核对。',
      })
    })
  }

  async openJournal(directory: string, id: string): Promise<TaskJournal> {
    const roots = await this.registeredRoots()
    const canonical = await checkDirectory(directory)
    if (
      !roots.some(
        (root) => pathKey(dirname(canonical)) === pathKey(join(root, taskWorkDirectoryName)),
      )
    )
      throw new Error('任务目录不属于已登记工作根。')
    return new TaskJournal(canonical, id)
  }

  /** 发现不等于恢复：不改写任务、不创建目录，也不执行或删除媒体。 */
  async discover(savedDownloadRoot?: string): Promise<WorkspaceDiscovery[]> {
    const roots = await this.registeredRoots()
    if (savedDownloadRoot && !roots.some((root) => pathKey(root) === pathKey(savedDownloadRoot)))
      roots.push(savedDownloadRoot)
    const results: WorkspaceDiscovery[] = []
    for (const saved of roots) {
      const root = join(saved, taskWorkDirectoryName)
      try {
        await this.root(saved)
        const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (!info) continue
        await checkDirectory(root)
        let count = 0
        for await (const entry of await opendir(root)) {
          if (++count > 5000) throw new Error('任务目录数量超过扫描上限。')
          const directory = join(root, entry.name)
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            results.push({
              kind: 'unrecognized',
              directory,
              message: '未知文件或链接，未自动处理。',
            })
            continue
          }
          try {
            const value = await new TaskJournal(directory).read()
            results.push({ kind: 'task', directory, ...value })
          } catch {
            results.push({
              kind: 'unrecognized',
              directory,
              message: '任务清单不完整、损坏或与目录不符，已保留原文件。',
            })
          }
        }
      } catch {
        results.push({
          kind: 'unavailable',
          directory: root,
          message: '任务工作根不可读取或不安全，未删除历史记录。',
        })
      }
    }
    return results
  }
}
