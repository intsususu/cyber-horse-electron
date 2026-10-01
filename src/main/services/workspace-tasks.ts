import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, opendir, readFile, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { Settings } from '../../shared/contracts'
import {
  pipelineNames,
  type PipelineState,
  type PipelineStep,
  type PipelineProgress,
} from '../../shared/pipeline'
import {
  taskManifestSchema,
  type TaskAction,
  type TaskActionPlan,
  type TaskManifest,
  type TaskView,
} from '../../shared/task-workspace'
import { TaskWorkspaces, type WorkspaceDraft } from './task-workspaces'
import { writeTaskJson } from './task-journal'
import { TaskProcessing } from './task-processing'
import { TaskPublisher } from './task-publisher'
import { checkPublication } from './task-publication-check'
import { TaskRecovery } from './task-recovery'
import { TaskScheduler } from './task-scheduler'
import { PipelineTools } from './pipeline-tools'
import { redactToolLine } from './tool-process'
import {
  checkpoint,
  checkDirectory,
  copyChecked,
  exists,
  fileStamp,
  hashFile,
  inside,
  makeDirectory,
  pathKey,
  removeChecked,
  unchanged,
  type FileStamp,
} from './safe-files'

export const taskConfiguration = (settings: Settings) =>
  createHash('sha256')
    .update(JSON.stringify([settings.paths, settings.subtitle, settings.mediaServer]))
    .digest('hex')
export const taskServer = (settings: Settings) =>
  createHash('sha256')
    .update(JSON.stringify([settings.mediaServer.serverUrl, settings.mediaServer.username]))
    .digest('hex')
type Action = {
  public: TaskActionPlan
  inventory: { path: string; stamp: FileStamp }[]
  signature: string
}
type Entry = {
  view: TaskView
  logs: PipelineState['logs']
  work?: Promise<void>
  controller?: AbortController
  release?: () => void
  logWork?: Promise<void>
  logBytes?: number
  progress?: Partial<Record<PipelineStep, PipelineProgress>>
}

/** 统一任务入口；磁盘记录是事实来源，历史与残留分开，启动只发现不执行。 */
export class WorkspaceTasks {
  readonly scheduler = new TaskScheduler()
  readonly workspaces: TaskWorkspaces
  private processing: TaskProcessing
  private publisher: TaskPublisher
  private recovery: TaskRecovery
  private entries = new Map<string, Entry>()
  private plans = new Map<string, Action>()
  private diagnostics: { directory: string; message: string }[] = []
  private initialization?: Promise<void>
  private closing = false

  constructor(
    private dataDirectory: string,
    protectedPaths: string[],
    private settings: () => Promise<Settings>,
    tools = new PipelineTools(),
    private synchronize?: (task: TaskManifest, signal: AbortSignal) => Promise<boolean>,
  ) {
    this.workspaces = new TaskWorkspaces(dataDirectory, protectedPaths)
    this.processing = new TaskProcessing(this.workspaces, tools, this.scheduler)
    this.publisher = new TaskPublisher(this.workspaces, [dataDirectory, ...protectedPaths])
    this.recovery = new TaskRecovery(this.workspaces)
  }

  get active() {
    return [...this.entries.values()].some((entry) => !!entry.work)
  }
  get awaitingConfirmation() {
    return [...this.entries.values()].some((entry) => entry.view.task.state === 'finalizing')
  }
  isActive(id: string) {
    return !!this.entries.get(id)?.work
  }
  get failedTaskIds() {
    return [...this.entries.values()]
      .filter((entry) => entry.view.task.state === 'failed')
      .map((entry) => entry.view.task.id)
  }
  private historyRoot() {
    return join(this.dataDirectory, 'workspace-tasks')
  }
  private async initialize() {
    this.initialization ??= this.discover().catch((error) => {
      this.initialization = undefined
      throw error
    })
    return this.initialization
  }
  private async discover() {
    if (await exists(this.historyRoot())) {
      await checkDirectory(this.historyRoot())
      let count = 0
      for await (const entry of await opendir(this.historyRoot())) {
        if (++count > 5000) throw new Error('任务历史超过读取上限。')
        if (!/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue
        try {
          const path = join(this.historyRoot(), entry.name)
          const info = await lstat(path)
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.nlink !== 1 ||
            info.size > 8 * 1024 * 1024
          )
            throw new Error()
          const task = taskManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')))
          if (entry.name !== task.id + '.json' || !['completed', 'removed'].includes(task.state))
            throw new Error()
          this.entries.set(task.id, {
            view: { task, directory: '', active: false, recoverable: false, diagnostic: '' },
            logs: [],
          })
        } catch {
          this.diagnostics.push({
            directory: join(this.historyRoot(), entry.name),
            message: '历史记录损坏，已保留文件。',
          })
        }
      }
    }
    const settings = await this.settings()
    for (const found of await this.workspaces.discover(settings.paths.download)) {
      if (found.kind !== 'task') {
        this.diagnostics.push({ directory: found.directory, message: found.message })
        continue
      }
      this.entries.set(found.task.id, {
        view: {
          task: found.task,
          directory: found.directory,
          active: false,
          recoverable: true,
          diagnostic: found.snapshotNeedsRepair
            ? '执行事件领先快照，确认后修复；不会自动处理文件。'
            : '发现残留任务，请确认恢复、保留文件或移除。',
        },
        logs: [],
      })
    }
  }
  async list() {
    await this.initialize()
    return {
      tasks: [...this.entries.values()]
        .map((entry) => structuredClone(entry.view))
        .sort((a, b) => a.task.createdAt.localeCompare(b.task.createdAt)),
      diagnostics: this.diagnostics,
    }
  }
  directory(id: string) {
    const directory = this.entries.get(id)?.view.directory
    if (!directory) throw new Error('任务目录已清理或不可访问。')
    return directory
  }
  private async configCheck(task: TaskManifest, settings: Settings) {
    if (!task.context || task.context.configuration !== taskConfiguration(settings))
      throw new Error('任务配置与当前保存值不一致，请恢复原配置后重新预览；未改变历史目标。')
    const expected = await checkDirectory(
      task.destination.kind === 'nas' || task.destination.kind === 'media-original'
        ? settings.paths.nas
        : settings.paths.preprocess,
    )
    if (
      pathKey(task.downloadRoot) !== pathKey(await checkDirectory(settings.paths.download)) ||
      !inside(expected, task.destination.root) ||
      (task.destination.kind !== 'media-original' &&
        pathKey(expected) !== pathKey(task.destination.root))
    )
      throw new Error('任务根目录与已保存范围不符，未执行。')
    const roots = (
      await Promise.all(
        [
          settings.paths.download,
          settings.paths.preprocess,
          settings.paths.whisperOutput,
          settings.paths.videoOutput,
          settings.paths.mdcOutput,
          settings.paths.nas,
          settings.mediaServer.downloadDirectory,
        ]
          .filter(Boolean)
          .map((path) => checkDirectory(path).catch(() => '')),
      )
    ).filter(Boolean)
    if (
      task.files.some((file) =>
        file.sources.some((source) => !roots.some((root) => inside(root, source.path))),
      )
    )
      throw new Error('任务来源超出已保存范围。')
    if (
      task.context.replacements.some(
        (value) => pathKey(dirname(value.path)) !== pathKey(task.destination.root),
      )
    )
      throw new Error('原媒体清单超出冻结影片目录。')
  }
  async enqueue(
    settings: Settings,
    draft: WorkspaceDraft,
    allowedRoots: string[],
  ): Promise<string> {
    if (this.closing) throw new Error('应用正在退出，未新增任务。')
    await this.initialize()
    const provisional = randomUUID()
    const paths = [
      ...draft.files.flatMap((file) => [file.path, ...(file.companions ?? [])]),
      ...(draft.context?.replacements.map((value) => value.path) ?? []),
    ]
    const reserve = this.scheduler.claim(provisional, paths)
    try {
      const workspace = await this.workspaces.create(
        settings.paths.download,
        {
          ...draft,
          context: draft.context ?? {
            configuration: taskConfiguration(settings),
            replacements: [],
            sync: null,
          },
        },
        allowedRoots,
      )
      reserve()
      const release = this.scheduler.claim(workspace.task.id, paths)
      const entry: Entry = {
        view: {
          task: workspace.task,
          directory: workspace.directory,
          active: true,
          recoverable: false,
          diagnostic: '',
        },
        logs: [],
        release,
      }
      this.entries.set(workspace.task.id, entry)
      this.launch(entry, settings, false)
      return workspace.task.id
    } finally {
      reserve()
    }
  }
  async wait(id: string) {
    await this.entries.get(id)?.work
    return this.entries.get(id)?.view.task
  }
  cancel(id: string) {
    this.entries.get(id)?.controller?.abort()
  }
  async stop() {
    this.closing = true
    for (const entry of this.entries.values()) entry.controller?.abort()
    await Promise.all([...this.entries.values()].map((entry) => entry.work))
  }

  private launch(entry: Entry, settings: Settings, resume: boolean) {
    const controller = new AbortController()
    entry.controller = controller
    entry.view.active = true
    entry.view.recoverable = false
    entry.view.diagnostic = ''
    const changed = (task: TaskManifest) => {
      entry.view.task = task
      this.recordLog(entry, {
        type: '任务状态',
        state: task.state,
        revision: task.revision,
        message: task.message,
      })
    }
    entry.work = this.execute(entry, settings, controller.signal, resume, changed)
      .catch(async (error) => {
        entry.view.diagnostic =
          error instanceof Error ? error.message : '任务失败，文件与记录已保留。'
        try {
          const journal = await this.workspaces.openJournal(
            entry.view.directory,
            entry.view.task.id,
          )
          const latest = await journal.read()
          if (!latest.snapshotNeedsRepair)
            changed(
              await journal.update(latest.task.revision, {
                state: controller.signal.aborted ? 'cancelled' : 'failed',
                message: entry.view.diagnostic,
              }),
            )
        } catch {
          entry.view.diagnostic += ' 记录未能更新，请查看磁盘记录。'
        }
      })
      .finally(async () => {
        // 失败与取消也等待最后一条记录落盘，避免释放任务后仍有文件写入。
        await entry.logWork?.catch(() => {})
        entry.release?.()
        entry.release = undefined
        entry.view.active = false
        entry.view.recoverable = !!entry.view.directory
        entry.work = undefined
        entry.controller = undefined
      })
  }
  private recordLog(entry: Entry, value: Record<string, unknown>) {
    const bytes = JSON.stringify(value) + '\n'
    entry.logBytes = (entry.logBytes ?? 0) + Buffer.byteLength(bytes)
    if (entry.logBytes > 2 * 1024 * 1024) return
    entry.logWork = (entry.logWork ?? Promise.resolve()).then(async () => {
      await mkdir(this.historyRoot(), { recursive: true })
      const path = join(this.historyRoot(), entry.view.task.id + '.jsonl')
      if (await exists(path)) {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error('任务日志不是独立普通文件。')
        if (info.size + Buffer.byteLength(bytes) > 2 * 1024 * 1024) return
      }
      await checkDirectory(this.historyRoot())
      const file = await open(path, 'a')
      try {
        await file.writeFile(bytes, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
    })
    void entry.logWork.catch(() => {
      entry.controller?.abort()
    })
  }
  private async execute(
    entry: Entry,
    settings: Settings,
    signal: AbortSignal,
    resume: boolean,
    changed: (task: TaskManifest) => void,
  ) {
    const directory = entry.view.directory
    const id = entry.view.task.id
    await this.configCheck(entry.view.task, settings)
    if (
      entry.view.task.files.some((file) =>
        file.steps.some(
          (step) => step.id !== 'archive' && !['verified', 'skipped'].includes(step.state),
        ),
      )
    ) {
      changed(
        await this.processing.run(
          directory,
          id,
          settings,
          signal,
          (line, warning) => {
            const log = {
              id: (entry.logs.at(-1)?.id ?? 0) + 1,
              time: new Date().toISOString(),
              level: warning ? ('warning' as const) : ('info' as const),
              text: redactToolLine(line),
            }
            entry.logs.push(log)
            this.recordLog(entry, { type: '日志', entry: log })
            if (entry.logs.length > 200) entry.logs.shift()
          },
          resume,
          changed,
          (step, value) => {
            entry.progress ??= {}
            entry.progress[step] = value
            entry.view.progress = entry.progress
          },
          async (task, fileId) => {
            changed(task)
            if (task.origin === 'media-library') return
            await entry.logWork
            await this.scheduler.use(
              'transfer',
              signal,
              async () => {
                const file = task.files.find((value) => value.id === fileId)!
                const targets = this.publisher.targets(task, file).map((value) => value.target)
                const all = task.files
                  .filter((value) => !value.steps.some((step) => step.state === 'failed'))
                  .flatMap((value) =>
                    this.publisher.targets(task, value).map((value) => value.target),
                  )
                if (new Set(all.map(pathKey)).size !== all.length)
                  throw new Error('同批发布目标重复，请拆分任务。')
                const release = this.scheduler.claim(id, targets, true)
                try {
                  changed(
                    await this.publisher.run(
                      directory,
                      id,
                      signal,
                      async () => this.configCheck(entry.view.task, await this.settings()),
                      fileId,
                    ),
                  )
                } finally {
                  release()
                }
              },
              directory,
            )
          },
        ),
      )
    } else if (
      entry.view.task.files.some((file) =>
        file.sources.some((source) => source.state === 'pending'),
      )
    ) {
      changed(
        await this.processing.run(directory, id, settings, signal, undefined, resume, changed),
      )
    }
    await entry.logWork
    changed(
      await this.scheduler.use(
        'transfer',
        signal,
        async () => {
          // 实际发布路径在刮削后确定，再占用具体文件，阻止不同来源争抢同一目标。
          const targets = entry.view.task.files
            .filter((file) => !file.steps.some((step) => step.state === 'failed'))
            .flatMap((file) =>
              file.publications.length
                ? file.publications.map((value) => value.target)
                : this.publisher.targets(entry.view.task, file).map((value) => value.target),
            )
          if (new Set(targets.map(pathKey)).size !== targets.length)
            throw new Error('同批文件指向相同发布名称，请拆分任务或处理目标冲突。')
          const release = this.scheduler.claim(id, targets, true)
          try {
            return await this.publisher.run(directory, id, signal, async () =>
              this.configCheck(entry.view.task, await this.settings()),
            )
          } finally {
            release()
          }
        },
        directory,
      ),
    )
    if (entry.view.task.files.some((file) => file.steps.some((step) => step.state === 'failed'))) {
      const journal = await this.workspaces.openJournal(directory, id)
      const successful = entry.view.task.files.filter(
        (file) =>
          file.publications.length && file.publications.every((value) => value.state === 'cleaned'),
      ).length
      changed(
        await journal.update(entry.view.task.revision, {
          state: 'failed',
          message: `部分失败：已发布 ${successful}/${entry.view.task.files.length} 个文件；失败文件已保留，可确认恢复。`,
        }),
      )
      return
    }
    if (
      entry.view.task.context?.sync &&
      !['confirmed', 'waived'].includes(entry.view.task.context.sync.state)
    ) {
      let confirmed = false
      let confirmationIssue = ''
      try {
        confirmed = !!(await this.synchronize?.(entry.view.task, signal))
      } catch (error) {
        confirmationIssue =
          error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
            ? error.message
            : 'Emby 更新确认请求中断，可重试收尾。'
      }
      checkpoint(signal)
      const journal = await this.workspaces.openJournal(directory, id)
      const context = structuredClone(entry.view.task.context)
      context.sync!.state = confirmed ? 'confirmed' : 'pending'
      context.sync!.message = confirmed
        ? context.sync!.userData
          ? 'Emby 已核对发布视频，并保留当前账号的收藏和观看记录。'
          : 'Emby 已核对发布视频；此历史任务没有用户记录快照，未迁移收藏和观看记录。'
        : confirmationIssue
          ? `媒体已回写；${confirmationIssue}`
          : '媒体已回写，Emby 尚未确认；可仅重试同步或结束待收尾。'
      entry.view.diagnostic = ''
      changed(
        await journal.update(entry.view.task.revision, {
          context,
          state: 'finalizing',
          message: context.sync!.message,
        }),
      )
      if (!confirmed) return
    }
    const inventory = await this.recovery.inventory(directory, entry.view.task, signal)
    if (inventory.some((file) => !file.known))
      throw new Error('任务目录包含工具额外文件，已保留残留；请查看目录核对，未自动删除。')
    const journal = await this.workspaces.openJournal(directory, id)
    for (const original of entry.view.task.files) {
      const file = structuredClone(original)
      for (const artifact of file.artifacts.filter((value) => value.state !== 'removed')) {
        const path = join(directory, artifact.path)
        if (await exists(path)) {
          if (!artifact.stamp) throw new Error('遗留文件缺少确认快照，已保留待处理。')
          for (const publication of file.publications)
            await checkPublication(entry.view.task, publication, signal)
          await unchanged(path, artifact.stamp)
          artifact.state = 'removing'
          changed(
            await journal.update(entry.view.task.revision, {
              files: [file],
              message: '有效结果已发布，准备清理登记的遗留输入。',
            }),
          )
          await removeChecked(path, directory, artifact.stamp, signal)
        }
        artifact.state = 'removed'
        changed(await journal.update(entry.view.task.revision, { files: [file] }))
      }
    }
    changed(
      await journal.update(entry.view.task.revision, {
        state: 'completed',
        message: '所选步骤、发布与清理已完成。',
      }),
    )
    await this.archive(entry.view.task)
    await entry.logWork
    await this.cleanDirectory(entry, signal)
  }
  private async archive(task: TaskManifest) {
    await mkdir(this.historyRoot(), { recursive: true })
    await writeTaskJson(this.historyRoot(), task.id + '.json', task)
  }
  async clearHistory() {
    await this.initialize()
    for (const [id, entry] of this.entries) {
      if (
        entry.view.active ||
        entry.view.recoverable ||
        !['completed', 'removed'].includes(entry.view.task.state)
      )
        continue
      const path = join(this.historyRoot(), id + '.json')
      if (await exists(path))
        await removeChecked(
          path,
          this.historyRoot(),
          await fileStamp(path),
          new AbortController().signal,
        )
      this.entries.delete(id)
    }
  }
  private async cleanDirectory(entry: Entry, signal: AbortSignal) {
    const directory = entry.view.directory
    const inventory = await this.recovery.inventory(directory, entry.view.task, signal)
    if (inventory.some((file) => !file.known)) throw new Error('目录含未知内容，未清理。')
    if (inventory.some((file) => !file.record))
      throw new Error('目录仍有媒体或临时文件，请先确认保留或删除。')
    // 不使用递归删除；逐个复核记录，最后只移除已确认为空的子目录和本任务目录。
    const directories: string[] = []
    const pending = [directory]
    while (pending.length) {
      const current = pending.pop()!
      await checkDirectory(current)
      directories.push(current)
      for await (const child of await opendir(current))
        if (child.isDirectory() && !child.isSymbolicLink()) pending.push(join(current, child.name))
    }
    for (const file of inventory) {
      await unchanged(file.path, file.stamp)
      await unlink(file.path)
    }
    for (const path of directories.sort((a, b) => b.length - a.length)) {
      await checkDirectory(path)
      await rmdir(path)
    }
    entry.view.directory = ''
  }

  async previewAction(id: string, action: TaskAction): Promise<TaskActionPlan> {
    await this.initialize()
    const entry = this.entries.get(id)
    if (!entry || entry.view.active || !entry.view.directory)
      throw new Error('当前任务不能执行残留操作。')
    const journal = await this.workspaces.openJournal(entry.view.directory, id)
    const latest = await journal.read()
    entry.view.task = latest.task
    await this.recovery.checkLocks(entry.view.directory)
    const inventory = await this.recovery.inventory(
      entry.view.directory,
      latest.task,
      new AbortController().signal,
    )
    if (action === 'resume') await this.configCheck(latest.task, await this.settings())
    if (['keep', 'delete'].includes(action) && inventory.some((file) => !file.known))
      throw new Error('任务含未知文件，不能移除；请打开目录核对后重试。')
    if (
      action === 'finish' &&
      (latest.task.state !== 'finalizing' || latest.task.context?.sync?.state !== 'pending')
    )
      throw new Error('只有媒体已发布、Emby 待确认的任务可结束待收尾。')
    const plan: TaskActionPlan = {
      planId: randomUUID(),
      id,
      revision: latest.task.revision,
      action,
      name: latest.task.name,
      directory: entry.view.directory,
      destination:
        action === 'keep'
          ? join(latest.task.downloadRoot, '保留任务', latest.task.workspaceName)
          : latest.task.destination.root,
      files: inventory
        .filter((file) => !file.record)
        .map((file) => ({
          path: file.path,
          size: file.stamp.size,
          disposition:
            action === 'keep'
              ? '核对复制后移至保留目录'
              : action === 'delete'
                ? '永久删除；可能包含唯一副本'
                : '核对记录后继续，已完成步骤不重跑',
        })),
      summary: latest.task.files.map((file) => ({
        name: file.name,
        sources: file.sources.map((source) => source.path),
        steps: structuredClone(file.steps),
        published: file.publications
          .filter((value) => ['published', 'cleaned'].includes(value.state))
          .map((value) => value.target),
      })),
      warnings:
        action === 'delete'
          ? ['永久删除本任务内已识别文件，无法撤销；外部源文件和已发布结果不受影响。']
          : action === 'keep'
            ? ['保留所有已识别文件；同名目标不覆盖，未知内容阻断清理。']
            : action === 'finish'
              ? ['结束服务器待确认，不重新执行媒体处理。']
              : ['仅恢复未完成步骤；配置、文件身份和进程占用会再次核对。'],
      expiresAt: Date.now() + 300000,
    }
    this.plans.set(plan.planId, {
      public: plan,
      inventory: inventory.map(({ path, stamp }) => ({ path, stamp })),
      signature: JSON.stringify(latest.task),
    })
    return structuredClone(plan)
  }
  async confirmAction(planId: string, revision: number) {
    const plan = this.plans.get(planId)
    this.plans.delete(planId)
    if (!plan || plan.public.expiresAt < Date.now() || revision !== plan.public.revision)
      throw new Error('操作预览已失效，请重新预览。')
    const entry = this.entries.get(plan.public.id)!
    if (entry.view.active) throw new Error('任务正在执行，未重复操作。')
    const journal = await this.workspaces.openJournal(entry.view.directory, entry.view.task.id)
    const latest = await journal.read()
    if (JSON.stringify(latest.task) !== plan.signature)
      throw new Error('任务状态已变化，请重新预览。')
    const signal = new AbortController().signal
    const inventory = await this.recovery.inventory(entry.view.directory, latest.task, signal)
    if (
      inventory.length !== plan.inventory.length ||
      inventory.some(
        (file) => !plan.inventory.some((old) => pathKey(old.path) === pathKey(file.path)),
      )
    )
      throw new Error('目录内容已变化，请重新预览。')
    for (const file of plan.inventory) await unchanged(file.path, file.stamp)
    const settings = await this.settings()
    if (plan.public.action === 'resume') {
      await this.configCheck(latest.task, settings)
      const release = this.scheduler.claim(
        entry.view.task.id,
        entry.view.task.files.flatMap((file) => file.sources.map((source) => source.path)),
      )
      try {
        entry.view.task = await this.recovery.resume(entry.view.directory, latest.task, signal)
        entry.release = release
        this.launch(entry, settings, true)
      } catch (error) {
        release()
        throw error
      }
      return
    }
    for (const lock of await this.recovery.checkLocks(entry.view.directory)) {
      await unchanged(lock.path, lock.stamp)
      await unlink(lock.path)
    }
    await journal.repairSnapshot(latest.task.revision)
    entry.view.task = (await journal.read()).task
    if (plan.public.action === 'finish') {
      const context = structuredClone(entry.view.task.context)!
      context.sync!.state = 'waived'
      entry.view.task = await journal.update(entry.view.task.revision, {
        context,
        message: '用户已结束 Emby 待确认。',
      })
      this.launch(entry, settings, true)
      return
    }
    entry.view.active = true
    try {
      if (plan.public.action === 'keep') {
        await makeDirectory(entry.view.task.downloadRoot, plan.public.destination)
        // 全部复制并校验成功才移除任务内来源，中途失败保留唯一副本。
        for (const file of inventory.filter((value) => !value.record)) {
          const target = join(plan.public.destination, relative(entry.view.directory, file.path))
          await makeDirectory(plan.public.destination, dirname(target))
          if (await exists(target)) {
            if ((await hashFile(target, signal)) !== (await hashFile(file.path, signal)))
              throw new Error('保留目录存在不同的同名文件，来源已保留。')
          } else await copyChecked(file.path, target, signal)
        }
      }
      for (const file of inventory.filter((value) => !value.record)) {
        if (plan.public.action === 'keep') {
          const target = join(plan.public.destination, relative(entry.view.directory, file.path))
          if ((await hashFile(target, signal)) !== (await hashFile(file.path, signal)))
            throw new Error('保留目标校验失败，未删除来源。')
        }
        await unchanged(file.path, file.stamp)
        const relativePath = relative(entry.view.directory, file.path).replace(/\\/g, '/')
        const owner = entry.view.task.files.find((value) =>
          value.artifacts.some((artifact) => artifact.path === relativePath),
        )!
        const next = structuredClone(owner)
        next.artifacts.find((artifact) => artifact.path === relativePath)!.state = 'removing'
        entry.view.task = await journal.update(entry.view.task.revision, {
          files: [next],
          message: `用户确认${plan.public.action === 'keep' ? '保留后移除' : '永久删除'}：${basename(file.path)}`,
        })
        await removeChecked(file.path, entry.view.directory, file.stamp, signal)
        next.artifacts.find((artifact) => artifact.path === relativePath)!.state = 'removed'
        entry.view.task = await journal.update(entry.view.task.revision, { files: [next] })
      }
      entry.view.task = await journal.update(entry.view.task.revision, {
        state: 'removed',
        removalAction: plan.public.action,
        message:
          plan.public.action === 'keep'
            ? `任务已结束，文件保存在 ${plan.public.destination}`
            : '任务内已识别文件已按用户确认永久删除。',
      })
      await this.archive(entry.view.task)
      await this.cleanDirectory(entry, signal)
    } finally {
      entry.view.active = false
      entry.view.recoverable = !!entry.view.directory
    }
  }

  project(id: string): PipelineState | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const task = entry.view.task
    const steps = task.steps.filter((step): step is PipelineStep =>
      ['subtitle-mux', 'video', 'scrape', 'archive'].includes(step),
    )
    const status = entry.view.active
      ? entry.controller?.signal.aborted
        ? 'cancelling'
        : 'running'
      : task.state === 'completed' && !entry.view.directory
        ? 'succeeded'
        : task.state === 'cancelled' || task.state === 'removed'
          ? 'cancelled'
          : 'failed'
    return {
      id,
      status,
      startedAt: task.createdAt,
      ...(!entry.view.active ? { endedAt: task.updatedAt } : {}),
      tasks: steps
        .map<PipelineState['tasks'][number]>((id) => {
          const records = task.files
            .filter(
              (file) =>
                id !== 'archive' ||
                !file.steps.some((step) => step.id !== 'archive' && step.state === 'failed'),
            )
            .map((file) => file.steps.find((step) => step.id === id)!)
          const completed = records.filter((step) =>
            ['verified', 'skipped'].includes(step.state),
          ).length
          const running = records.some((step) => ['running', 'validating'].includes(step.state))
          return {
            id,
            title: pipelineNames[id],
            status: !records.length
              ? 'skipped'
              : completed === records.length
                ? 'succeeded'
                : records.some((step) => step.state === 'failed')
                  ? 'failed'
                  : running
                    ? 'running'
                    : 'pending',
            completed,
            total: records.length,
            failed: records.filter((step) => step.state === 'failed').length,
            skipped: records.filter((step) => step.state === 'skipped').length,
            progress: records.length ? Math.floor((completed / records.length) * 100) : 0,
            message:
              records.find((step) => ['running', 'failed', 'validating'].includes(step.state))
                ?.message ?? task.message,
            startedAt: records.find((step) => step.startedAt)?.startedAt ?? undefined,
            endedAt:
              completed === records.length ? (records.at(-1)?.endedAt ?? undefined) : undefined,
          }
        })
        .map((value) => ({
          ...value,
          current: value.status === 'running' ? entry.progress?.[value.id] : undefined,
        })),
      files: task.files.map((file) => ({
        path: file.sources[0]!.path,
        name: file.name,
        relativePath: file.name,
        size: file.sources[0]!.stamp.size,
        modifiedAt: file.sources[0]!.stamp.mtimeMs,
      })),
      source: dirname(task.files[0]!.sources[0]!.path),
      mode: 'selected',
      logs: entry.logs,
      message: entry.view.diagnostic || task.message,
      journal: join(this.historyRoot(), id + '.jsonl'),
      outputs: task.files.flatMap((file) => file.publications.map((value) => value.target)),
      resultFiles: task.files.flatMap((file) =>
        file.publications
          .filter((value) => ['published', 'cleaned'].includes(value.state))
          .map((value) => value.target),
      ),
      failures: task.files.flatMap((file) =>
        file.steps
          .filter((step) => step.state === 'failed')
          .map((step) => ({
            step: step.id as PipelineStep,
            file: file.sources[0]!.path,
            reason: step.message,
          })),
      ),
    }
  }
}
