import { randomUUID } from 'node:crypto'
import { mkdir, open, opendir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Settings } from '../../shared/contracts'
import {
  pipelineNames,
  pipelineSteps,
  type PipelinePlan,
  type PipelineRequest,
  type PipelineState,
  type PipelineStep,
} from '../../shared/pipeline'
import { collectMediaInputs, mediaExtensions } from './media-inputs'
import { canonicalVideoName } from './video-name'
import { mediaIdentity } from './media-identity'
import { ExecutionLock } from './execution-lock'
import {
  PipelineTools,
  MdcItemFailure,
  requiredTools,
  verifyCheckedTool,
  type CheckedTools,
} from './pipeline-tools'
import {
  availablePath,
  checkpoint,
  checkDirectory,
  copyChecked,
  copySizeChecked,
  exists,
  fileStamp,
  inside,
  listFiles,
  makeDirectory,
  overlap,
  pathKey,
  moveChecked,
  removeChecked,
  removeEmptyParents,
  safeRoot,
  unchanged,
  type FileStamp,
} from './safe-files'
import { redactToolLine } from './tool-process'
import { WorkspaceTasks } from './workspace-tasks'

type MediaItem = { video: string; root: string; files: string[] }
type Plan = {
  public: PipelinePlan
  settingsKey: string
  tools: CheckedTools
  roots: Partial<Record<PipelineStep, string>>
  scrapeReturnRoot?: string
  items: MediaItem[]
  stamps: Map<string, FileStamp>
}
const timestamp = () => new Date().toISOString()
const settingsKey = (settings: Settings) =>
  JSON.stringify({ paths: settings.paths, subtitle: settings.subtitle })
const isVideo = (path: string) => mediaExtensions.includes(extname(path).slice(1).toLowerCase())
const isChinese = (path: string) => mediaIdentity(path).chinese
const isRestored = (path: string) => mediaIdentity(path).restored
const archiveNumber = (path: string) =>
  canonicalVideoName(basename(path, extname(path)))?.replace(/-(?:UC|U|C)$/i, '')
function namedOutput(path: string, step: 'subtitle-mux' | 'video'): string {
  const name = basename(path, extname(path))
  if (step === 'subtitle-mux')
    return (
      (/-(?:U|hack)(?:_\d+)?$/i.test(name)
        ? name.replace(/-(?:U|hack)(_\d+)?$/i, '-UC$1')
        : name + '-C') + '.mkv'
    )
  return (/-C(?:_\d+)?$/i.test(name) ? name.replace(/-C(_\d+)?$/i, '-UC$1') : name + '-U') + '.mkv'
}
function failureText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EEXIST') return '目标已存在，未覆盖文件。请重新预览。'
  if (code === 'ENOSPC') return '磁盘空间不足，已停止；请核对未完成文件和已提交输出。'
  if (code) return '文件访问失败，请检查目录权限、文件占用或磁盘连接，并按执行记录核对文件。'
  return error instanceof Error ? error.message : '处理失败，请检查日志。'
}

export class PipelineService {
  private plan: Plan | null = null
  private state: PipelineState | null = null
  private controller: AbortController | null = null
  private work: Promise<void> | null = null
  private busy = false
  private workspaceId: string | null = null
  constructor(
    private readonly dataDirectory: string,
    private readonly protectedPaths: string[],
    private readonly tools = new PipelineTools(),
    private readonly lock = new ExecutionLock(),
    private readonly returnScrapeToPreprocess = true,
    private readonly workspaceTasks?: WorkspaceTasks,
  ) {}
  get active(): boolean {
    return this.busy || !!(this.workspaceId && this.workspaceTasks?.isActive(this.workspaceId))
  }
  snapshot(): PipelineState | null {
    if (this.workspaceId) return this.workspaceTasks?.project(this.workspaceId) ?? null
    return this.state ? structuredClone(this.state) : null
  }
  async wait(): Promise<void> {
    if (this.workspaceId) await this.workspaceTasks?.wait(this.workspaceId)
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25))
    await this.work
  }
  cancel(): void {
    if (this.workspaceId) this.workspaceTasks?.cancel(this.workspaceId)
    this.controller?.abort()
    if (this.state?.status === 'running')
      this.state = { ...this.state, status: 'cancelling', message: '正在停止工具，已完成操作保留…' }
  }

  async preview(
    settings: Settings,
    request: PipelineRequest,
    source: string,
  ): Promise<PipelinePlan> {
    if (this.busy || this.active) throw new Error('工作台已有任务正在运行或预览。')
    const release = this.workspaceTasks ? () => {} : this.lock.acquire('处理任务')
    this.busy = true
    this.plan = null
    this.controller = new AbortController()
    const signal = this.controller.signal
    try {
      const root = await safeRoot(source, [this.dataDirectory, ...this.protectedPaths])
      const allowedRoots: string[] = []
      for (const path of [
        settings.paths.download,
        settings.paths.preprocess,
        settings.paths.whisperOutput,
        settings.paths.videoOutput,
        settings.paths.mdcOutput,
        settings.paths.nas,
        settings.mediaServer.downloadDirectory,
      ]) {
        if (!isAbsolute(path)) continue
        try {
          allowedRoots.push(await safeRoot(path, [this.dataDirectory, ...this.protectedPaths]))
        } catch {
          /* 无效的其他配置目录不能扩大本次范围。 */
        }
      }
      if (!allowedRoots.some((allowed) => inside(allowed, root)))
        throw new Error('当前目录不在已保存的工作目录内，请先在偏好配置中设置。')
      const steps = pipelineSteps.filter((step) => request.steps.includes(step))
      if (!steps.length) throw new Error('请至少选择一个步骤。')
      const scan = await collectMediaInputs([root], request.recursive, true)
      if (scan.skipped) throw new Error('范围中存在链接或不可读取项目，请修复后再预览。')
      const wanted =
        request.selection.mode === 'selected'
          ? new Set(request.selection.relativePaths.map((path) => pathKey(resolve(root, path))))
          : null
      if (wanted && [...wanted].some((path) => !inside(root, path)))
        throw new Error('所选文件超出工作目录。')
      const files = scan.files.filter((file) => !wanted || wanted.has(pathKey(file.path)))
      if (wanted && files.length !== wanted.size)
        throw new Error('部分选中文件已不在目录中，请刷新后重新选择。')
      if (!files.length) throw new Error('当前范围没有视频，未创建任务。')
      const roots: Plan['roots'] = {}
      const mapping = {
        'subtitle-mux': 'whisperOutput',
        video: 'videoOutput',
        scrape: 'mdcOutput',
        archive: 'nas',
      } as const
      for (const step of steps) {
        if (this.workspaceTasks && step !== 'archive') continue
        roots[step] = await safeRoot(settings.paths[mapping[step]], [
          this.dataDirectory,
          ...this.protectedPaths,
        ])
        if (overlap(root, roots[step]!))
          throw new Error(`${pipelineNames[step]}的工作/输出目录不能与当前工作目录相同或互相包含。`)
        if (
          Object.entries(roots).some(
            ([other, path]) => other !== step && overlap(path, roots[step]!),
          )
        )
          throw new Error('各步骤的工作和输出目录不能相同或互相包含。')
      }
      const scrapeReturnRoot =
        steps.includes('scrape') && this.returnScrapeToPreprocess
          ? await safeRoot(settings.paths.preprocess, [this.dataDirectory, ...this.protectedPaths])
          : undefined
      if (
        scrapeReturnRoot &&
        ((roots.scrape && overlap(scrapeReturnRoot, roots.scrape)) ||
          (roots.archive && overlap(scrapeReturnRoot, roots.archive)))
      )
        throw new Error('预处理目录不能与 MDC 输出目录或 NAS 目录相同或互相包含。')
      const items: MediaItem[] = [],
        stamps = new Map<string, FileStamp>()
      for (const file of files) {
        checkpoint(signal)
        const paths = [file.path],
          parent = dirname(file.path),
          stem = basename(file.path, extname(file.path))
        // 只收纳同名旁车文件；单视频目录另收纳通用封面，避免扩大到未选媒体。
        const entries = []
        for await (const entry of await opendir(parent)) {
          entries.push(entry)
          if (entries.length > 10000) throw new Error('文件所在目录过大，请缩小范围。')
        }
        const uniqueVideo =
          entries.filter((entry) => entry.isFile() && isVideo(entry.name)).length === 1
        for (const entry of entries) {
          const extension = extname(entry.name).toLowerCase(),
            lower = entry.name.toLowerCase(),
            base = stem.toLowerCase()
          const related =
            lower.startsWith(base + '.') ||
            ['-poster', '-fanart', '-thumb'].some((suffix) =>
              lower.startsWith(base + suffix + '.'),
            ) ||
            (uniqueVideo && /^(poster|fanart|thumb)\./i.test(entry.name))
          if (
            related &&
            ['.srt', '.ass', '.vtt', '.nfo', '.jpg', '.jpeg', '.png', '.webp'].includes(extension)
          )
            paths.push(join(parent, entry.name))
        }
        for (const path of paths) {
          const info = await fileStamp(path)
          if (!info.size) throw new Error('输入包含空文件，请先检查。')
          stamps.set(path, info)
        }
        items.push({ video: file.path, root: parent, files: paths })
      }
      if (this.workspaceTasks)
        await safeRoot(settings.paths.download, [this.dataDirectory, ...this.protectedPaths])
      const checked = await this.tools.check(settings, steps, signal, !!this.workspaceTasks)
      const view: PipelinePlan = {
        id: randomUUID(),
        createdAt: Date.now(),
        steps,
        source: root,
        mode: request.selection.mode,
        files,
        relatedFiles: items.map((item) => ({ video: item.video, files: item.files })),
        destinations: steps.map((step) => ({
          step,
          directory: this.workspaceTasks
            ? steps.includes('archive')
              ? roots.archive!
              : settings.paths.preprocess
            : step === 'scrape' && scrapeReturnRoot
              ? scrapeReturnRoot
              : step === 'subtitle-mux' || step === 'video'
                ? root
                : roots[step]!,
        })),
        tools: requiredTools(steps).map((name) =>
          name === 'mkvmerge'
            ? 'MKVToolNix（封装/校验）'
            : name === 'whisper'
              ? 'Whisper'
              : name === 'mdc'
                ? 'MDC'
                : name === 'ffprobe'
                  ? 'ffprobe（视频校验）'
                  : 'Jasna',
        ),
        warnings: this.workspaceTasks
          ? [
              '输入将接管到已保存下载目录下的独立 .work 任务目录，所有工具在任务内读写媒体。',
              '校验后发布到预处理目录或 NAS；重名目标停止处理，不覆盖未知文件。',
              '新产物校验后淘汰被替换输入，不保留整套恢复副本；失败或取消保留最近有效文件，重启后由你确认恢复。',
            ]
          : [
              '直接处理清单内的视频及相关文件。新产物校验成功后删除被替换的旧文件，不保留恢复副本。',
              ...(steps.includes('scrape')
                ? [
                    scrapeReturnRoot
                      ? 'MDC 按单文件写入配置的输出目录；产物校验通过后，将本次媒体文件夹搬回预处理目录。失败时请核对源目录、MDC 输出目录和预处理目录。'
                      : 'MDC 按单文件调用，直接写入配置的输出目录，并按自身配置移动或整理所选视频；失败时请核对源目录与输出目录。',
                  ]
                : []),
              ...(steps.includes('archive')
                ? [
                    'NAS 归档按识别到的番号命名目标文件夹，-C、-U、-UC 指向同一番号目录；同名番号目录先改名为 _tmp，新目录复制并校验后删除 _tmp。演员目录及其他番号目录保留。整批目标文件大小与本地一致后，直接删除对应本地文件。',
                  ]
                : []),
              ...(steps.includes('archive') && !steps.includes('scrape')
                ? ['本次没有选择刮削，只归档当前视频及已有的相关文件，不补跑 MDC。']
                : []),
            ],
      }
      this.plan = {
        public: view,
        settingsKey: settingsKey(settings),
        tools: checked,
        roots,
        scrapeReturnRoot,
        items,
        stamps,
      }
      return structuredClone(view)
    } catch (error) {
      throw new Error(failureText(error))
    } finally {
      this.busy = false
      this.controller = null
      release()
    }
  }

  async start(id: string, settings: Settings, source: string): Promise<PipelineState> {
    if (this.busy || this.active) throw new Error('工作台已有任务正在运行或预览。')
    const release = this.workspaceTasks ? () => {} : this.lock.acquire('处理任务')
    this.busy = true
    const plan = this.plan
    this.plan = null
    this.controller = new AbortController()
    const signal = this.controller.signal
    try {
      if (!plan || plan.public.id !== id || Date.now() - plan.public.createdAt > 600000)
        throw new Error('执行清单已失效，请重新预览。')
      if (
        settingsKey(settings) !== plan.settingsKey ||
        pathKey(await checkDirectory(source)) !== pathKey(plan.public.source)
      )
        throw new Error('配置或工作目录已变化，请重新预览。')
      for (const [path, stamp] of plan.stamps) {
        checkpoint(signal)
        await unchanged(path, stamp)
      }
      for (const tool of Object.values(plan.tools)) await verifyCheckedTool(tool)
      if (this.workspaceTasks) {
        this.workspaceId = await this.workspaceTasks.enqueue(
          settings,
          {
            origin: 'workbench',
            steps: plan.public.steps,
            destination: {
              kind: plan.public.steps.includes('archive') ? 'nas' : 'preprocess',
              root: plan.public.steps.includes('archive')
                ? settings.paths.nas
                : settings.paths.preprocess,
            },
            files: plan.items.map((item) => ({
              path: item.video,
              companions: item.files.filter((path) => path !== item.video),
            })),
          },
          [plan.public.source],
        )
        this.busy = false
        this.controller = null
        release()
        return this.snapshot()!
      }
      const journal = join(this.dataDirectory, 'pipeline', `${id}.jsonl`)
      await mkdir(dirname(journal), { recursive: true })
      const file = await open(journal, 'wx')
      try {
        await file.writeFile(
          JSON.stringify({ type: 'plan', plan: plan.public, items: plan.items }) + '\n',
        )
        await file.sync()
      } catch (error) {
        await file.close()
        throw error
      }
      this.state = {
        id,
        status: 'running',
        startedAt: timestamp(),
        tasks: plan.public.steps.map((step) => ({
          id: step,
          title: pipelineNames[step],
          status: 'pending',
          completed: 0,
          skipped: 0,
          total: plan.items.length,
          progress: 0,
          message: '等待执行',
        })),
        files: plan.public.files,
        source: plan.public.source,
        mode: plan.public.mode,
        logs: [],
        message: '正在准备处理',
        journal,
        outputs: [],
        resultFiles: [],
        failures: [],
      }
      this.work = this.execute(plan, settings, file, signal).finally(() => {
        this.busy = false
        this.controller = null
        release()
      })
      return this.snapshot()!
    } catch (error) {
      this.busy = false
      this.controller = null
      release()
      throw new Error(failureText(error))
    }
  }

  private async execute(
    plan: Plan,
    settings: Settings,
    journal: Awaited<ReturnType<typeof open>>,
    signal: AbortSignal,
  ): Promise<void> {
    const items = structuredClone(plan.items)
    let active = this.state!.tasks[0]!,
      serial = 0,
      loggedBytes = 0,
      logsTruncated = false,
      logFailure = false
    let journalQueue = Promise.resolve()
    const record = (value: unknown) => {
      journalQueue = journalQueue.then(async () => {
        await journal.writeFile(JSON.stringify(value) + '\n')
        await journal.sync()
      })
      return journalQueue
    }
    const log = (text: string, warning = false) => {
      const entry = {
        id: ++serial,
        time: timestamp(),
        level: warning ? ('warning' as const) : ('info' as const),
        text: redactToolLine(text),
      }
      this.state!.logs = [...this.state!.logs.slice(-199), entry]
      if (loggedBytes + Buffer.byteLength(entry.text) <= 2 * 1024 * 1024 && !logsTruncated) {
        loggedBytes += Buffer.byteLength(entry.text)
        void record({ type: 'log', entry }).catch(() => {
          logFailure = true
          this.controller?.abort()
        })
      } else if (!logsTruncated) {
        logsTruncated = true
        void record({
          type: 'log-truncated',
          at: timestamp(),
          message: '工具文本日志达到 2 MiB 上限，后续文本未保存；步骤结果和文件操作事件继续记录。',
        }).catch(() => {
          logFailure = true
          this.controller?.abort()
        })
      }
    }
    const deleteSources = async (files: string[], root: string, stamps: Map<string, FileStamp>) => {
      for (const path of new Set(files)) {
        await record({ type: 'deleting', source: path, root })
        try {
          await removeChecked(path, root, stamps.get(path)!, signal)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          await record({ type: 'delete-failed', source: path, code: code ?? null })
          if (signal.aborted) throw error
          const detail =
            code === 'ENOENT'
              ? '原文件已不在预期位置'
              : code
                ? `系统错误 ${code}`
                : failureText(error)
          throw new Error(
            `清理原文件 ${basename(path)} 失败：${detail}；请核对执行记录与已发布产物。`,
          )
        }
        await record({ type: 'deleted', source: path })
      }
    }
    const removeEmptyChildren = async (root: string) => {
      const directories: string[] = []
      const pending = [root]
      while (pending.length) {
        const directory = pending.pop()!
        await checkDirectory(directory)
        for await (const entry of await opendir(directory)) {
          if (entry.isSymbolicLink()) throw new Error('目标目录包含链接，已停止清理。')
          if (!entry.isDirectory()) continue
          const child = join(directory, entry.name)
          await checkDirectory(child)
          directories.push(child)
          pending.push(child)
        }
      }
      for (const directory of directories.reverse()) await rmdir(directory)
    }
    const publishPackage = async (
      sourceRoot: string,
      paths: string[],
      targetRoot: string,
      name: string,
      sizeOnly = false,
      replaceExisting = false,
    ): Promise<MediaItem> => {
      let target = join(targetRoot, name)
      if (!inside(targetRoot, target) || pathKey(target) === pathKey(targetRoot))
        throw new Error('目标媒体目录越界。')
      const historical = `${target}_tmp`
      if (replaceExisting && (!inside(targetRoot, historical) || (await exists(historical))))
        throw new Error('历史临时目录已存在或超出 NAS 范围，请先核对，未覆盖任何文件。')
      const marker = join(target, '.cyber-horse-incomplete')
      const owned: string[] = []
      const sourceStamps = new Map<string, FileStamp>()
      const cleanupSignal = new AbortController().signal
      let historicalMarked = false
      let historicalRenamed = false
      let targetCreated = false
      let historicalCleanupStarted = false
      try {
        if (!replaceExisting) {
          while (true) {
            target = await availablePath(join(targetRoot, name), true)
            await checkDirectory(targetRoot)
            try {
              await mkdir(target)
              targetCreated = true
              break
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            }
          }
        } else {
          await checkDirectory(targetRoot)
          if (await exists(target)) {
            await checkDirectory(target)
            await listFiles(target, signal, false)
            await writeFile(marker, plan.public.id, { flag: 'wx' })
            historicalMarked = true
            checkpoint(signal)
            await checkDirectory(targetRoot)
            await checkDirectory(target)
            if (await exists(historical))
              throw new Error('历史临时目录已存在，请先核对，未覆盖任何文件。')
            await rename(target, historical)
            historicalRenamed = true
          }
          await mkdir(target)
          targetCreated = true
        }
        const newMarker = join(target, '.cyber-horse-incomplete')
        await writeFile(newMarker, plan.public.id, { flag: 'wx' })
        await record({
          type: 'publishing',
          target,
          historical: historicalRenamed ? historical : undefined,
          files: paths,
        })
        const published: string[] = []
        for (const path of paths) {
          if (!inside(sourceRoot, path)) throw new Error('工具产物超出本次目录。')
          const output = join(target, relative(sourceRoot, path))
          await makeDirectory(target, dirname(output))
          sourceStamps.set(path, await fileStamp(path))
          owned.push(output)
          if (sizeOnly) await copySizeChecked(path, output, signal)
          else await copyChecked(path, output, signal)
          published.push(output)
        }
        checkpoint(signal)
        for (let index = 0; index < paths.length; index++) {
          await unchanged(paths[index]!, sourceStamps.get(paths[index]!)!)
          if ((await fileStamp(published[index]!)).size !== sourceStamps.get(paths[index]!)!.size)
            throw new Error('目标文件大小与本地源文件不一致，源文件已保留。')
        }
        if (historicalRenamed) {
          await record({ type: 'replacing', target, historical })
          historicalCleanupStarted = true
          if (!inside(targetRoot, historical) || pathKey(historical) === pathKey(targetRoot))
            throw new Error('历史目录超出 NAS 范围，已停止清理。')
          await checkDirectory(historical)
          const historicalMarker = join(historical, '.cyber-horse-incomplete')
          const oldFiles = await listFiles(historical, cleanupSignal, false)
          for (const path of oldFiles.filter((path) => pathKey(path) !== pathKey(historicalMarker)))
            await removeChecked(path, historical, await fileStamp(path), cleanupSignal)
          await removeEmptyChildren(historical)
          await removeChecked(
            historicalMarker,
            historical,
            await fileStamp(historicalMarker),
            cleanupSignal,
          )
          await rmdir(historical)
        }
        await checkDirectory(target)
        await unlink(newMarker)
        await record({ type: 'published', target, files: published, replacing: historicalRenamed })
        this.state!.outputs.push(target)
        const video = published.find(isVideo)
        if (!video) throw new Error('产物目录缺少视频。')
        return { video, root: target, files: published }
      } catch (error) {
        if (historicalRenamed && !historicalCleanupStarted) {
          try {
            if (targetCreated) {
              await checkDirectory(target)
              for (const path of owned)
                if (await exists(path))
                  await removeChecked(path, target, await fileStamp(path), cleanupSignal)
              if (await exists(marker)) await unlink(marker)
              await removeEmptyChildren(target)
              await rmdir(target)
            }
            await checkDirectory(historical)
            if (await exists(target)) throw new Error('目标目录已被其他程序占用。')
            await rename(historical, target)
            await checkDirectory(target)
            await unlink(marker)
          } catch {
            throw new Error(
              '新目录复制失败且旧目录未能恢复，请核对同名目录与 _tmp；本地源文件已保留。',
            )
          }
        } else if (historicalMarked && !historicalRenamed) {
          await checkDirectory(target)
          await unlink(marker)
        }
        if (historicalCleanupStarted)
          throw new Error(
            '新目录已复制，但旧目录清理未完成；请核对同名目录与 _tmp，本地源文件已保留。',
          )
        throw error
      }
    }
    let finalStatus: PipelineState['status'] = 'succeeded',
      message = '所选步骤处理完成。'
    const failedScrapes = new Set<number>()
    try {
      for (const task of this.state!.tasks) {
        active = task
        checkpoint(signal)
        if (task.id !== 'scrape' && failedScrapes.size) task.total -= failedScrapes.size
        if (task.total === 0) {
          task.status = 'skipped'
          task.endedAt = timestamp()
          task.message = '没有通过 MDC 校验的文件，本步未执行'
          await record({ type: 'step-completed', task })
          continue
        }
        task.status = 'running'
        task.startedAt = timestamp()
        log(`开始${task.title}，共 ${task.total} 个文件。`)
        const archiveSources: MediaItem[] = []
        const archiveStamps = new Map<string, FileStamp>()
        const archiveTargets: { path: string; size: number }[] = []
        const publishedTargets = new Set<string>()
        for (let index = 0; index < items.length; index++) {
          if (failedScrapes.has(index)) continue
          checkpoint(signal)
          task.current = { phase: 'prepare', percent: null }
          const item = items[index]!
          task.message = `${index + 1}/${items.length} · ${basename(item.video)}`
          this.state!.message = `${task.title} · ${task.message}`
          const sourceStamps = new Map<string, FileStamp>()
          for (const path of item.files) {
            const expected = plan.stamps.get(path)
            if (expected) await unchanged(path, expected)
            sourceStamps.set(path, await fileStamp(path))
          }
          if (
            (task.id === 'subtitle-mux' && isChinese(item.video)) ||
            (task.id === 'video' && isRestored(item.video))
          ) {
            task.skipped++
            task.completed++
            task.progress = Math.floor((task.completed / task.total) * 100)
            task.current = undefined
            log(`${basename(item.video)} 已有对应命名标记，跳过${task.title}。`)
            continue
          }
          await record({ type: 'begin', step: task.id, index, source: item.video })
          if (task.id === 'archive') {
            task.current = { phase: 'archive', percent: null }
            const layoutRoot = [
              plan.scrapeReturnRoot,
              settings.paths.preprocess,
              plan.roots.scrape,
              settings.paths.mdcOutput,
            ].find(
              (path) =>
                path &&
                isAbsolute(path) &&
                inside(path, item.root) &&
                pathKey(path) !== pathKey(item.root),
            )
            const preserveLayout = !!layoutRoot
            const targetRoot = preserveLayout
              ? join(plan.roots.archive!, dirname(relative(layoutRoot, item.root)))
              : plan.roots.archive!
            if (preserveLayout) await makeDirectory(plan.roots.archive!, targetRoot)
            const originalNumber = archiveNumber(plan.items[index]!.video)
            const outputNumber = archiveNumber(item.video)
            if (originalNumber && outputNumber && originalNumber !== outputNumber)
              throw new Error('处理产物番号与原视频不一致，已停止归档以免替换错误目录。')
            const packageName =
              originalNumber ??
              (preserveLayout ? basename(item.root) : basename(item.video, extname(item.video)))
            const destinationKey = pathKey(join(targetRoot, packageName))
            if (publishedTargets.has(destinationKey))
              throw new Error('本批多个视频对应同一归档目录，已停止以免互相覆盖。')
            publishedTargets.add(destinationKey)
            const published = await publishPackage(
              item.root,
              item.files,
              targetRoot,
              packageName,
              true,
              true,
            )
            for (const [path, stamp] of sourceStamps) await unchanged(path, stamp)
            for (const [path, stamp] of sourceStamps) {
              archiveStamps.set(path, stamp)
              archiveTargets.push({
                path: join(published.root, relative(item.root, path)),
                size: stamp.size,
              })
            }
            archiveSources.push(item)
            items[index] = published
          } else {
            if (task.id === 'scrape') {
              task.current = { phase: 'scrape', percent: null }
              let produced: string[]
              try {
                produced = await this.tools.scrape(
                  plan.tools,
                  item.video,
                  plan.roots.scrape!,
                  signal,
                  (line, warning) => {
                    log(line, warning)
                    if (warning) console.warn(redactToolLine(line))
                    else console.log(redactToolLine(line))
                  },
                  undefined,
                  item.files.filter((path) => path !== item.video),
                )
              } catch (error) {
                if (signal.aborted || logFailure || !(error instanceof MdcItemFailure)) throw error
                const reason = failureText(error)
                failedScrapes.add(index)
                task.failed = (task.failed ?? 0) + 1
                task.progress = Math.floor(((task.completed + task.failed) / task.total) * 100)
                task.current = undefined
                this.state!.failures!.push({ step: 'scrape', file: item.video, reason })
                await record({
                  type: 'file-failed',
                  step: 'scrape',
                  index,
                  source: item.video,
                  reason,
                })
                log(
                  `${basename(item.video)} 刮削失败，跳过后续步骤：${reason}；请核对源目录与 MDC 输出目录。`,
                  true,
                )
                continue
              }
              const video = produced.find(isVideo)!
              if (!video || produced.some((path) => !inside(plan.roots.scrape!, path)))
                throw new Error('MDC 产物超出已配置的输出目录。')
              const mediaRoot = dirname(video)
              if (produced.some((path) => !inside(mediaRoot, path)))
                throw new Error('MDC 产物分散在多个目录，请核对输出。')
              this.state!.outputs.push(mediaRoot)
              await record({ type: 'published', target: mediaRoot, files: produced })
              const remaining: string[] = []
              for (const [path, stamp] of sourceStamps) {
                if (!(await exists(path))) continue
                const current = await fileStamp(path)
                if (
                  current.ino !== stamp.ino ||
                  current.dev !== stamp.dev ||
                  current.size !== stamp.size ||
                  current.mtimeMs !== stamp.mtimeMs
                )
                  throw new Error('MDC 处理期间源文件发生变化，请核对源目录和输出目录。')
                sourceStamps.set(path, current)
                if (!produced.some((output) => pathKey(output) === pathKey(path)))
                  remaining.push(path)
              }
              if (plan.scrapeReturnRoot) {
                task.current = { phase: 'publish', percent: null }
                const subdirectory = relative(plan.roots.scrape!, mediaRoot)
                const parent = subdirectory
                  ? join(plan.scrapeReturnRoot, dirname(subdirectory))
                  : plan.scrapeReturnRoot
                await makeDirectory(plan.scrapeReturnRoot, parent)
                const packageName = subdirectory
                  ? basename(mediaRoot)
                  : basename(video, extname(video))
                items[index] = await publishPackage(mediaRoot, produced, parent, packageName)
              } else items[index] = { video, root: mediaRoot, files: produced }
              await deleteSources(remaining, item.root, sourceStamps)
              await removeEmptyParents(item.root, plan.public.source)
              if (plan.scrapeReturnRoot) {
                const outputStamps = new Map<string, FileStamp>()
                for (const path of produced) outputStamps.set(path, await fileStamp(path))
                await deleteSources(produced, plan.roots.scrape!, outputStamps)
                await removeEmptyParents(mediaRoot, plan.roots.scrape!)
              }
            } else {
              const outputRoot = plan.roots[task.id]!
              const target = await availablePath(
                join(dirname(item.video), namedOutput(item.video, task.id)),
              )
              const output = join(
                outputRoot,
                '.horse-' + randomUUID() + '-' + basename(target) + '.partial',
              )
              const reserved = await open(output, 'wx')
              await reserved.close()
              const srt = join(
                dirname(item.video),
                basename(item.video, extname(item.video)) + '.srt',
              )
              const hadSrt = await exists(srt)
              const transient = new Set<string>([output, output + '.jasna.mkv'])
              let subtitle: string | undefined
              try {
                const report: import('./tool-progress').ProgressReporter = (progress) => {
                  if (!signal.aborted && task.status === 'running') task.current = progress
                }
                if (task.id === 'subtitle-mux') {
                  subtitle = await this.tools.subtitle(
                    plan.tools,
                    item.video,
                    output,
                    settings.subtitle.format,
                    signal,
                    log,
                    report,
                    undefined,
                    settings.subtitle,
                  )
                  if (!item.files.includes(subtitle)) transient.add(subtitle)
                  if (!hadSrt) transient.add(srt)
                } else await this.tools.video(plan.tools, item.video, output, signal, log, report)
                task.current = { phase: 'publish', percent: null }
                for (const [path, stamp] of sourceStamps) await unchanged(path, stamp)
                await moveChecked(output, target, signal)
                const companions: string[] = []
                const oldStem = basename(item.video, extname(item.video))
                const newStem = basename(target, extname(target))
                for (const path of item.files.filter((path) => path !== item.video)) {
                  const name = basename(path)
                  if (!name.toLowerCase().startsWith(oldStem.toLowerCase())) {
                    companions.push(path)
                    continue
                  }
                  const companion = await availablePath(
                    join(dirname(target), newStem + name.slice(oldStem.length)),
                  )
                  await copyChecked(path, companion, signal)
                  companions.push(companion)
                }
                if (
                  subtitle &&
                  extname(subtitle).toLowerCase() !== '.ass' &&
                  !item.files.includes(subtitle)
                ) {
                  const subtitleTarget = await availablePath(
                    join(dirname(target), newStem + extname(subtitle)),
                  )
                  await copyChecked(subtitle, subtitleTarget, signal)
                  companions.push(subtitleTarget)
                }
                items[index] = {
                  video: target,
                  root: dirname(target),
                  files: [target, ...companions],
                }
                this.state!.outputs.push(target)
                await record({ type: 'published', target, files: items[index]!.files })
                await deleteSources(
                  item.files.filter((path) => !companions.includes(path)),
                  item.root,
                  sourceStamps,
                )
              } finally {
                // 中间文件仅在已配置目录内短暂存在，不创建任务目录或保存完整输入副本。
                if (task.id === 'subtitle-mux' && !hadSrt) transient.add(srt)
                for (const path of transient) {
                  if (!inside(outputRoot, path) && !inside(item.root, path))
                    throw new Error('中间文件超出本次目录。')
                  if (await exists(path))
                    await removeChecked(
                      path,
                      dirname(path),
                      await fileStamp(path),
                      new AbortController().signal,
                    )
                }
              }
            }
          }
          await record({ type: 'completed', step: task.id, index, output: items[index] })
          task.completed++
          task.progress = Math.floor(((task.completed + (task.failed ?? 0)) / task.total) * 100)
          task.current = undefined
          log(`${task.title}已校验 ${task.completed}/${task.total} 个文件。`)
        }
        // NAS 必须整批复制成功后再清理对应本地内容；失败时保留所有本地输入。
        if (task.id === 'archive') {
          task.current = { phase: 'publish', percent: null }
          for (const [path, stamp] of archiveStamps) await unchanged(path, stamp)
          for (const target of archiveTargets)
            if ((await fileStamp(target.path)).size !== target.size)
              throw new Error('NAS 文件大小与本地源文件不一致，源文件已保留。')
          const deleted = new Set<string>()
          for (const item of archiveSources) {
            const pending = item.files.filter((path) => !deleted.has(pathKey(path)))
            for (const path of pending) await unchanged(path, archiveStamps.get(path)!)
            await deleteSources(pending, item.root, archiveStamps)
            pending.forEach((path) => deleted.add(pathKey(path)))
            await removeEmptyParents(
              item.root,
              plan.roots.scrape && inside(plan.roots.scrape, item.root)
                ? plan.roots.scrape
                : plan.public.source,
            )
          }
        }
        task.status = task.failed ? 'failed' : task.skipped === task.total ? 'skipped' : 'succeeded'
        task.current = undefined
        task.endedAt = timestamp()
        task.message = task.failed
          ? `完成 ${task.completed}/${task.total} 项，失败 ${task.failed} 项；失败文件未进入后续步骤`
          : task.status === 'skipped'
            ? '全部文件已有对应标记，未调用处理工具'
            : `完成 ${task.completed} 项，其中跳过 ${task.skipped} 项`
        await record({ type: 'step-completed', task })
      }
      if (failedScrapes.size) {
        finalStatus = 'failed'
        const failures = this.state!.failures!
        message =
          failures.length === 1 && items.length === 1
            ? failures[0]!.reason
            : failedScrapes.size === items.length
              ? `MDC 刮削全部 ${items.length} 项失败，后续步骤未执行；请查看失败文件记录。`
              : `MDC 刮削成功 ${items.length - failedScrapes.size}/${items.length} 项，失败 ${failedScrapes.size} 项；成功文件已继续执行所选后续步骤。`
      }
    } catch (error) {
      finalStatus = signal.aborted && !logFailure ? 'cancelled' : 'failed'
      message = logFailure
        ? '执行记录保存失败，任务已停止；请核对原文件和产物目录。'
        : failureText(error)
      active.status = finalStatus
      active.message = message
      active.endedAt = timestamp()
      for (const task of this.state!.tasks)
        if (task.status === 'pending') {
          task.status = finalStatus === 'cancelled' ? 'cancelled' : 'skipped'
          task.message = '前置步骤未完成，本步没有执行'
          task.endedAt = timestamp()
        }
      log(message, true)
    } finally {
      try {
        await record({
          type: 'finished',
          status: finalStatus,
          message,
          tasks: this.state!.tasks,
          outputs: this.state!.outputs,
          resultFiles: items.flatMap((item) => item.files),
          failures: this.state!.failures,
        })
        await journalQueue
      } catch {
        finalStatus = 'failed'
        message = '执行记录保存失败，请核对原文件和输出。'
      }
      await journal.close().catch(() => {})
      this.state = {
        ...this.state!,
        status: finalStatus,
        message,
        resultFiles: items.flatMap((item) => item.files),
        endedAt: timestamp(),
      }
    }
  }
}
