import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, relative } from 'node:path'
import { mkdir, opendir, open, rename } from 'node:fs/promises'
import type { Settings } from '../../shared/contracts'
import type { MediaProcessPlan, MediaProcessState } from '../../shared/media-library'
import type { PipelineStep } from '../../shared/pipeline'
import { ExecutionLock } from './execution-lock'
import { EmbyClient } from './emby-client'
import { MediaDownloads } from './media-downloads'
import { PipelineService } from './pipeline'
import { PipelineTools } from './pipeline-tools'
import { mediaExtensions } from './media-inputs'
import { canonicalVideoName } from './video-name'
import {
  checkpoint,
  availablePath,
  copyChecked,
  exists,
  fileStamp,
  hashFile,
  inside,
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

type Plan = {
  public: MediaProcessPlan
  settings: Settings
  stamps: Map<string, FileStamp>
  expires: number
  generation: number
}
const configKey = (s: Settings) => JSON.stringify([s.paths, s.mediaServer, s.subtitle])
const videoFile = (path: string) => mediaExtensions.includes(extname(path).slice(1).toLowerCase())
/** 媒体复合任务在已配置目录处理选定文件，回写校验成功后清理旧文件。 */
export class MediaProcessService {
  private plans = new Map<string, Plan>()
  private records: MediaProcessState[] = []
  private queue: Plan[] = []
  private release?: () => void
  private work?: Promise<void>
  private controller?: AbortController
  private processor?: PipelineService
  private current?: MediaProcessState
  private previewing = false
  private previewController?: AbortController
  constructor(
    private dataDirectory: string,
    private protectedPaths: string[],
    private client: EmbyClient,
    private downloads: MediaDownloads,
    private settings: () => Promise<Settings>,
    private lock: ExecutionLock,
    private tools = new PipelineTools(),
  ) {}
  get active() {
    return !!this.work || this.previewing
  }
  snapshot() {
    if (this.current && this.processor) this.current.pipeline = this.processor.snapshot()
    return structuredClone(this.records)
  }
  queueSummary() {
    return {
      active: this.records.filter((record) => ['pending', 'running'].includes(record.status))
        .length,
      downloadIds: new Set(this.records.map((record) => record.downloadId).filter(Boolean)),
    }
  }
  clearFinished() {
    this.records = this.records.filter((record) => ['pending', 'running'].includes(record.status))
  }
  async preview(
    itemId: string,
    sourceId: string,
    kind: 'subtitle' | 'video',
  ): Promise<MediaProcessPlan> {
    if (this.previewing) throw new Error('媒体处理预览正在进行。')
    this.previewing = true
    this.previewController = new AbortController()
    try {
      const settings = await this.settings()
      const nas = await safeRoot(settings.paths.nas, this.protectedPaths)
      const detail = await this.client.detail(itemId)
      const source = detail.sources.find((v) => v.id === sourceId)
      if (!source || !detail.canDownload)
        throw new Error('没有可处理的媒体版本或账号没有下载权限。')
      const original = await this.resolveOriginal(nas, source.path || detail.path)
      const parent = await safeRoot(dirname(original), this.protectedPaths)
      if (!inside(nas, parent) || pathKey(nas) === pathKey(parent) || !videoFile(original))
        throw new Error('Emby 原视频不在 NAS 的独立影片子目录中，已停止处理。')
      const affected: string[] = []
      const stem = basename(original, extname(original)).toLowerCase()
      let videos = 0
      for await (const entry of await opendir(parent)) {
        if (entry.isFile() && videoFile(entry.name)) videos++
        const name = entry.name.toLowerCase()
        if (
          name === basename(original).toLowerCase() ||
          name.startsWith(stem + '.') ||
          ['-poster.', '-fanart.', '-thumb.'].some((suffix) => name.startsWith(stem + suffix)) ||
          /^(poster|fanart|thumb)\.(jpg|jpeg|png|webp)$/.test(name)
        )
          affected.push(join(parent, entry.name))
        if (affected.length > 1000) throw new Error('影片目录内容过多，请整理后重试。')
      }
      if (videos !== 1)
        throw new Error(
          '回写目录必须只包含一个视频，避免影响其他版本；可先下载后在工作台单独处理。',
        )
      const stamps = new Map<string, FileStamp>()
      for (const path of affected) stamps.set(path, await fileStamp(path))
      const originalStamp = stamps.get(original)
      if (
        !originalStamp ||
        !originalStamp.size ||
        (source.size !== null && source.size !== originalStamp.size)
      )
        throw new Error('NAS 原视频与服务器媒体版本大小不一致。')
      const roots: string[] = [parent]
      for (const key of [
        'preprocess',
        'mdcOutput',
        kind === 'subtitle' ? 'whisperOutput' : 'videoOutput',
        'download',
      ] as const) {
        const root = await safeRoot(
          key === 'download'
            ? settings.paths.download || settings.mediaServer.downloadDirectory
            : settings.paths[key],
          this.protectedPaths,
        )
        if (roots.some((previous) => overlap(root, previous)))
          throw new Error('下载、处理、输出和原媒体目录不能相同或互相包含。')
        roots.push(root)
      }
      const steps: PipelineStep[] = [kind === 'subtitle' ? 'subtitle-mux' : 'video', 'scrape']
      await this.tools.check(
        settings,
        steps,
        AbortSignal.any([this.previewController.signal, AbortSignal.timeout(60000)]),
      )
      checkpoint(this.previewController.signal)
      const plan: MediaProcessPlan = {
        id: randomUUID(),
        itemId,
        sourceId,
        name: detail.name,
        kind,
        original,
        affected,
        steps: [
          '下载并核对原文件',
          kind === 'subtitle' ? '提取中文字幕并封装' : '视频破解',
          'MDC 元数据刮削',
          '校验并回写原媒体目录',
          '刷新 Emby 项目',
        ],
      }
      for (const [id, entry] of this.plans) if (entry.expires < Date.now()) this.plans.delete(id)
      if (this.plans.size >= 20) this.plans.clear()
      this.plans.set(plan.id, {
        public: plan,
        settings,
        stamps,
        expires: Date.now() + 600000,
        generation: this.client.generation,
      })
      return structuredClone(plan)
    } finally {
      this.previewing = false
      this.previewController = undefined
    }
  }
  private async resolveOriginal(nas: string, serverPath: string): Promise<string> {
    if (!serverPath || serverPath.length > 4096)
      throw new Error('Emby 未返回有效文件路径，无法自动定位 NAS 原视频。')
    const rawParts = serverPath.replaceAll('\\', '/').split('/').filter(Boolean)
    const parts = /^[a-zA-Z]:$/.test(rawParts[0] ?? '') ? rawParts.slice(1) : rawParts
    if (
      parts.length < 2 ||
      parts.length > 64 ||
      parts.some((part) => part === '.' || part === '..' || /[\0\r\n:]/.test(part))
    )
      throw new Error('Emby 文件路径格式无效，无法自动定位 NAS 原视频。')
    const matches = new Map<string, string>()
    for (let start = 0; start < parts.length - 1; start++) {
      const candidate = join(nas, ...parts.slice(start))
      if (!inside(nas, candidate) || !videoFile(candidate) || !(await exists(candidate))) continue
      await fileStamp(candidate)
      matches.set(pathKey(candidate), candidate)
    }
    if (matches.size === 0)
      throw new Error('未在已配置的 NAS 目录找到 Emby 原视频，请核对媒体路径和 NAS 配置。')
    if (matches.size > 1) throw new Error('Emby 路径在 NAS 中对应多个文件，无法安全自动回写。')
    return [...matches.values()][0]!
  }
  async start(id: string) {
    const plan = this.plans.get(id)
    if (!plan || plan.expires < Date.now()) throw new Error('处理预览已失效，请重新预览。')
    if (
      this.records.some(
        (v) => v.itemId === plan.public.itemId && ['pending', 'running'].includes(v.status),
      )
    )
      throw new Error('此媒体已有待处理或运行中的复合任务。')
    if (this.queue.length >= 20) throw new Error('待处理任务已达上限。')
    if (!this.release) this.release = this.lock.acquire('媒体库复合任务')
    this.plans.delete(id)
    this.queue.push(plan)
    this.records.push({
      ...plan.public,
      status: 'pending',
      message: '等待串行处理。',
      pipeline: null,
      downloadId: '',
      journal: join(this.dataDirectory, 'media-process', `${id}.jsonl`),
    })
    if (!this.work)
      this.work = this.drain().finally(() => {
        this.work = undefined
        this.release?.()
        this.release = undefined
      })
  }
  cancel(id: string) {
    const record = this.records.find((v) => v.id === id)
    if (!record) return
    if (record.status === 'pending') {
      this.queue = this.queue.filter((v) => v.public.id !== id)
      record.status = 'cancelled'
      record.message = '排队任务已取消。'
    }
    if (record.status === 'running') {
      this.controller?.abort()
      this.processor?.cancel()
      if (record.downloadId) this.downloads.cancel(record.downloadId)
    }
  }
  async stop() {
    this.previewController?.abort()
    for (const record of this.records) this.cancel(record.id)
    await this.work
    while (this.previewing) await new Promise((resolve) => setTimeout(resolve, 25))
  }
  private async drain() {
    while (this.queue.length) {
      const plan = this.queue.shift()!
      const record = this.records.find((v) => v.id === plan.public.id)!
      this.current = record
      this.controller = new AbortController()
      await this.execute(plan, record, this.controller.signal)
      this.processor = undefined
      this.current = undefined
      this.controller = undefined
    }
  }
  private async execute(plan: Plan, record: MediaProcessState, signal: AbortSignal) {
    let journal: Awaited<ReturnType<typeof open>> | undefined
    const write = async (value: unknown) => {
      if (journal) {
        await journal.writeFile(JSON.stringify(value) + '\n')
        await journal.sync()
      }
    }
    record.status = 'running'
    try {
      await mkdir(dirname(record.journal), { recursive: true })
      journal = await open(record.journal, 'wx')
      await write({ type: '计划', plan: plan.public })
      if (
        configKey(await this.settings()) !== configKey(plan.settings) ||
        plan.generation !== this.client.generation
      )
        throw new Error('服务器连接或处理配置已变化，请重新预览。')
      for (const [path, stamp] of plan.stamps) await unchanged(path, stamp)
      checkpoint(signal)
      record.message = '正在下载并校验所选媒体版本。'
      const download = await this.downloads.start(record.itemId, record.sourceId)
      record.downloadId = download.id
      while (true) {
        if (signal.aborted) this.downloads.cancel(download.id)
        const job = (await this.downloads.snapshot()).find((v) => v.id === download.id)!
        if (!['running', 'cancelling'].includes(job.status)) {
          checkpoint(signal)
          if (job.status !== 'completed') throw new Error(job.message)
          download.path = job.path
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      if ((await hashFile(download.path, signal)) !== (await hashFile(record.original, signal)))
        throw new Error('下载内容与所选 NAS 文件不一致，已停止回写。')
      const settings = structuredClone(plan.settings)
      const name =
        canonicalVideoName(basename(download.path, extname(download.path))) ||
        basename(download.path, extname(download.path))
      const input = await availablePath(
        join(settings.paths.preprocess, name + extname(download.path)),
      )
      await moveChecked(download.path, input, signal)
      // 媒体库复合任务会从 MDC 输出目录回写原 NAS 文件，不回搬到工作台预处理目录。
      this.processor = new PipelineService(
        this.dataDirectory,
        this.protectedPaths,
        this.tools,
        undefined,
        false,
      )
      const steps: PipelineStep[] = [
        record.kind === 'subtitle' ? 'subtitle-mux' : 'video',
        'scrape',
      ]
      const pipelinePlan = await this.processor.preview(
        settings,
        {
          steps,
          source: 'preprocess',
          recursive: false,
          selection: { mode: 'selected', relativePaths: [basename(input)] },
        },
        settings.paths.preprocess,
      )
      checkpoint(signal)
      record.message = '正在处理本次下载的文件。'
      await this.processor.start(pipelinePlan.id, settings, settings.paths.preprocess)
      await this.processor.wait()
      checkpoint(signal)
      record.pipeline = this.processor.snapshot()
      if (record.pipeline?.status !== 'succeeded')
        throw new Error(record.pipeline?.message || '媒体处理失败。')
      const outputs = record.pipeline.resultFiles
      if (!outputs.some(videoFile)) throw new Error('本次刮削没有生成可回写的视频。')
      const video = outputs.find(videoFile)!
      const packageRoot = dirname(video)
      if (
        outputs.some((path) => !inside(packageRoot, path)) ||
        outputs.filter(videoFile).length !== 1
      )
        throw new Error('刮削产物存在多个媒体范围，已停止回写。')
      if (
        configKey(await this.settings()) !== configKey(plan.settings) ||
        plan.generation !== this.client.generation
      )
        throw new Error('处理期间配置或连接已变化，产物已保留，未回写。')
      record.message = '正在校验并回写媒体，完成后清理旧文件。'
      await this.replace(plan, record, outputs, packageRoot, signal, write)
      for (const path of outputs)
        await removeChecked(path, settings.paths.mdcOutput, await fileStamp(path), signal)
      for (const path of outputs) await removeEmptyParents(dirname(path), settings.paths.mdcOutput)
      record.message = '媒体回写完成，正在刷新 Emby。'
      checkpoint(signal)
      await this.client.refresh(record.itemId, plan.generation)
      record.status = 'completed'
      record.message = '媒体处理与回写完成，旧文件和本次本地产物已清理，已提交 Emby 刷新。'
    } catch (error) {
      record.status = signal.aborted ? 'cancelled' : 'failed'
      record.message = signal.aborted
        ? '任务已取消，已完成操作保留，请按执行记录核对文件。'
        : error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
          ? error.message
          : '媒体任务失败，请按执行记录核对源目录和输出目录。'
    } finally {
      await write({ type: '结果', record }).catch(() => {})
      await journal?.close().catch(() => {})
    }
  }
  private async replace(
    plan: Plan,
    record: MediaProcessState,
    outputs: string[],
    packageRoot: string,
    signal: AbortSignal,
    write: (value: unknown) => Promise<void>,
  ) {
    const parent = await safeRoot(dirname(record.original), this.protectedPaths)
    const targets = outputs.map((path) => {
      if (!inside(packageRoot, path)) throw new Error('回写文件超出本次产物范围。')
      const target = join(parent, relative(packageRoot, path))
      if (!inside(parent, target)) throw new Error('回写目标超出原媒体目录。')
      return {
        source: path,
        target,
        staged: join(dirname(target), '.horse-' + randomUUID() + '.partial'),
      }
    })
    const prepared: string[] = []
    const published: string[] = []
    try {
      for (const entry of targets) {
        if ((await exists(entry.target)) && !plan.stamps.has(entry.target))
          throw new Error('回写将覆盖未预览的文件，已停止。')
        await makeDirectory(parent, dirname(entry.target))
        await copyChecked(entry.source, entry.staged, signal)
        prepared.push(entry.staged)
      }
      for (const [path, stamp] of plan.stamps) await unchanged(path, stamp)
      for (const entry of targets) {
        checkpoint(signal)
        await write({ type: '准备发布', target: entry.target })
        const previous = plan.stamps.get(entry.target)
        if (previous) {
          await unchanged(entry.target, previous)
          // 同目录原子替换，只在新文件已完整校验后覆盖清单内的旧文件。
          await rename(entry.staged, entry.target)
        } else await moveChecked(entry.staged, entry.target, signal)
        published.push(entry.target)
      }
      for (const [path, stamp] of plan.stamps) {
        if (published.some((target) => pathKey(target) === pathKey(path))) continue
        await write({ type: '删除旧文件', path })
        await removeChecked(path, parent, stamp, signal)
      }
      await write({ type: '回写完成', published })
    } finally {
      for (const path of prepared)
        if (await exists(path))
          await removeChecked(path, parent, await fileStamp(path), new AbortController().signal)
    }
  }
}
