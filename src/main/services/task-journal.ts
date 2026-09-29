import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  taskFileSchema,
  taskManifestSchema,
  taskStateSchema,
  type TaskManifest,
} from '../../shared/task-workspace'
import { checkDirectory, pathKey } from './safe-files'
import { taskWorkDirectoryName } from '../../shared/media-files'

const snapshotName = '任务状态.json'
const journalName = '执行事件.jsonl'
const maximumSnapshotBytes = 8 * 1024 * 1024
const maximumJournalBytes = 32 * 1024 * 1024
const patchSchema = z
  .object({
    state: taskStateSchema.optional(),
    message: z.string().max(2000).optional(),
    files: z.array(taskFileSchema).max(5000).optional(),
  })
  .strict()
const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), task: taskManifestSchema }).strict(),
  z
    .object({
      kind: z.literal('updated'),
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      at: z.string().datetime(),
      patch: patchSchema,
    })
    .strict(),
])
type TaskPatch = z.infer<typeof patchSchema>
type TaskEvent = z.infer<typeof eventSchema>
type DirectoryIdentity = { ino: number; dev: number }

function validateInitialTask(task: TaskManifest): void {
  if (
    task.revision !== 0 ||
    task.state !== 'queued' ||
    task.files.some(
      (file) =>
        file.artifacts.length ||
        file.sources.some((source) => source.state !== 'pending') ||
        file.steps.some((step) => step.state !== 'pending'),
    )
  )
    throw new Error('新任务的初始状态无效。')
}

async function regularFile(path: string, limit: number): Promise<number | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit)
    throw new Error('任务记录不是独立普通文件或超过大小限制，已保留原文件。')
  return info.size
}

/** 只用于应用自己的记录；临时文件独占创建，失败不覆盖原记录。 */
export async function writeTaskJson(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  if (!/^[\p{L}\p{N}-]+\.json$/u.test(name)) throw new Error('任务记录文件名无效。')
  const bytes = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(bytes) > maximumSnapshotBytes) throw new Error('任务记录超过大小限制。')
  await checkDirectory(directory)
  const identity = await lstat(directory)
  const target = join(directory, name)
  await regularFile(target, maximumSnapshotBytes)
  const temporary = join(directory, `.horse-${randomUUID()}.partial`)
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(bytes, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // 意外失败时留下可识别的临时记录，不能删除不明来源的文件来继续写入。
  await checkDirectory(directory)
  const current = await lstat(directory)
  if (current.ino !== identity.ino || current.dev !== identity.dev)
    throw new Error('任务记录目录已被替换，未继续提交。')
  await regularFile(target, maximumSnapshotBytes)
  await rename(temporary, target)
}

function applyPatch(
  task: TaskManifest,
  event: Extract<TaskEvent, { kind: 'updated' }>,
): TaskManifest {
  if (event.id !== task.id || event.revision !== task.revision + 1)
    throw new Error('任务事件标识或修订号不连续，未自动恢复。')
  const changes = new Map(event.patch.files?.map((file) => [file.id, file]))
  if (changes.size !== (event.patch.files?.length ?? 0)) throw new Error('任务变更包含重复文件。')
  const files = task.files.map((file) => {
    const next = changes.get(file.id)
    if (!next) return file
    changes.delete(file.id)
    const original = (value: typeof file) =>
      JSON.stringify({
        directory: value.directory,
        name: value.name,
        number: value.number,
        sources: value.sources.map(({ path, stamp, target }) => ({ path, stamp, target })),
      })
    if (original(file) !== original(next)) throw new Error('任务原始清单不能在执行中改写。')
    return next
  })
  if (changes.size) throw new Error('任务变更引用了清单之外的文件。')
  return taskManifestSchema.parse({
    ...task,
    ...event.patch,
    files,
    revision: event.revision,
    updatedAt: event.at,
  })
}

/** 日志先落盘，快照随后替换；差异只能显式修复，读取不会触发媒体操作。 */
export class TaskJournal {
  private identity?: DirectoryIdentity

  constructor(
    readonly directory: string,
    readonly id?: string,
  ) {}

  private checkLocation(task: TaskManifest): void {
    if (
      (this.id && task.id !== this.id) ||
      pathKey(join(task.downloadRoot, taskWorkDirectoryName, task.workspaceName)) !==
        pathKey(this.directory)
    )
      throw new Error('任务身份或目录位置与执行记录不一致。')
  }

  private async checkIdentity(): Promise<void> {
    await checkDirectory(this.directory)
    const now = await lstat(this.directory)
    if (this.identity && (this.identity.ino !== now.ino || this.identity.dev !== now.dev))
      throw new Error('任务目录已被替换，已停止访问。')
    this.identity = { ino: now.ino, dev: now.dev }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await this.checkIdentity()
    const path = join(this.directory, '写入锁.json')
    const lock = await open(path, 'wx').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST')
        throw new Error('任务记录正在写入或存在中断写入锁，请先核对，未自动接管。')
      throw error
    })
    const owned = await lock.stat()
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      )
      await lock.sync()
      return await action()
    } finally {
      await lock.close()
      await this.checkIdentity()
      const current = await lstat(path)
      if (current.isSymbolicLink() || current.ino !== owned.ino || current.dev !== owned.dev)
        throw new Error('任务写入锁已变化，未移除未知文件。')
      await unlink(path)
    }
  }

  async create(value: TaskManifest): Promise<TaskManifest> {
    const task = taskManifestSchema.parse(value)
    this.checkLocation(task)
    validateInitialTask(task)
    return this.exclusive(async () => {
      if ((await regularFile(join(this.directory, snapshotName), maximumSnapshotBytes)) !== null)
        throw new Error('任务状态已经存在，未覆盖。')
      await this.appendEvent({ kind: 'created', task }, true)
      await writeTaskJson(this.directory, snapshotName, task)
      return structuredClone(task)
    })
  }

  async read(): Promise<{ task: TaskManifest; snapshotNeedsRepair: boolean }> {
    await this.checkIdentity()
    const journal = join(this.directory, journalName)
    const size = await regularFile(journal, maximumJournalBytes)
    if (!size) throw new Error('任务事件记录缺失或为空，未自动恢复。')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(journal))
    if (!text.endsWith('\n')) throw new Error('任务事件记录被截断，请先核对，未自动恢复。')
    const snapshot = join(this.directory, snapshotName)
    const snapshotSize = await regularFile(snapshot, maximumSnapshotBytes)
    let saved: TaskManifest | undefined
    if (snapshotSize !== null) {
      try {
        saved = taskManifestSchema.parse(JSON.parse(await readFile(snapshot, 'utf8')))
      } catch {
        throw new Error('任务快照损坏，已保留原文件，请先核对。')
      }
    }
    let task: TaskManifest | undefined
    let snapshotMatched = !saved
    for (const line of text.trimEnd().split('\n')) {
      const parsed = eventSchema.safeParse(JSON.parse(line))
      if (!parsed.success) throw new Error('任务事件版本或内容无效，已保留原文件。')
      const event = parsed.data
      if (event.kind === 'created') {
        if (task || event.task.revision !== 0) throw new Error('任务创建事件重复或无效。')
        validateInitialTask(event.task)
        task = event.task
      } else {
        if (!task) throw new Error('任务事件缺少初始清单。')
        task = applyPatch(task, event)
      }
      // 落后的快照也必须对应日志里的真实历史，不能把外部改写误认为正常中断。
      if (saved?.revision === task.revision) {
        if (JSON.stringify(saved) !== JSON.stringify(task))
          throw new Error('相同修订号的任务内容不一致，已停止访问。')
        snapshotMatched = true
      }
    }
    if (!task) throw new Error('任务身份与执行记录不一致。')
    this.checkLocation(task)
    if (!snapshotMatched) throw new Error('任务快照与执行记录冲突，已保留原文件。')
    await this.checkIdentity()
    return { task, snapshotNeedsRepair: saved?.revision !== task.revision }
  }

  async update(expectedRevision: number, value: TaskPatch): Promise<TaskManifest> {
    const patch = patchSchema.parse(value)
    return this.exclusive(async () => {
      const current = await this.read()
      if (current.snapshotNeedsRepair) throw new Error('任务快照尚未同步，请先确认修复记录。')
      if (current.task.revision !== expectedRevision)
        throw new Error('任务状态已变化，请重新读取。')
      const event: Extract<TaskEvent, { kind: 'updated' }> = {
        kind: 'updated',
        id: current.task.id,
        revision: expectedRevision + 1,
        at: new Date(Math.max(Date.now(), Date.parse(current.task.updatedAt))).toISOString(),
        patch,
      }
      const next = applyPatch(current.task, event)
      await this.appendEvent(event)
      await writeTaskJson(this.directory, snapshotName, next)
      return structuredClone(next)
    })
  }

  async repairSnapshot(expectedRevision: number): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.read()
      if (current.task.revision !== expectedRevision) throw new Error('任务状态已变化，未修复。')
      if (current.snapshotNeedsRepair)
        await writeTaskJson(this.directory, snapshotName, current.task)
    })
  }

  private async appendEvent(event: TaskEvent, create = false): Promise<void> {
    const bytes = JSON.stringify(event) + '\n'
    const path = join(this.directory, journalName)
    const size = (await regularFile(path, maximumJournalBytes)) ?? 0
    if (size + Buffer.byteLength(bytes) > maximumJournalBytes)
      throw new Error('任务事件记录达到上限，已停止写入。')
    await this.checkIdentity()
    const handle = await open(path, create ? 'wx' : 'a')
    try {
      await handle.writeFile(bytes, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}
