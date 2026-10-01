import { randomUUID } from 'node:crypto'
import { join, basename, extname } from 'node:path'
import { open, link, unlink, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import type { Settings } from '../../shared/contracts'
import type { MediaDownload } from '../../shared/media-library'
import { EmbyClient } from './emby-client'
import { availablePath, checkDirectory, safeRoot } from './safe-files'

function downloadError(error: unknown): string {
  // 只输出已知错误码的中文解释，不记录可能包含令牌、地址的底层异常文本。
  const messages: Record<string, string> = {
    ENOSPC: '下载目录所在磁盘空间不足。',
    EACCES: '没有写入下载目录的权限。',
    EPERM: '下载文件写入被系统拒绝，请检查权限或文件占用。',
    EIO: '下载文件写入发生磁盘读写错误。',
    ECONNRESET: '下载连接被服务器或中间网络设备重置。',
    ECONNREFUSED: '服务器拒绝下载连接。',
    ETIMEDOUT: '下载网络连接超时。',
    UND_ERR_SOCKET: '下载连接意外断开。',
    UND_ERR_CONNECT_TIMEOUT: '连接下载服务器超时。',
    UND_ERR_HEADERS_TIMEOUT: '等待下载服务器响应超时。',
    UND_ERR_BODY_TIMEOUT: '等待下载数据超时。',
  }
  let cause = error
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code && Object.hasOwn(messages, code)) return `${messages[code]}（${code}）`
    if (cause.name === 'TimeoutError') return '下载请求超时。'
    if (cause.name === 'AbortError') return '下载请求被中断。'
    cause = cause.cause
  }
  return error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
    ? error.message
    : '下载失败，未取得可识别的错误原因。'
}

export class MediaDownloads {
  private jobs: MediaDownload[] = []
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private starting = new Set<string>()
  private stopping = false
  private writes: Promise<void> = Promise.resolve()
  private readonly file: string
  private ready: Promise<void>
  constructor(
    private directory: string,
    private protectedPaths: string[],
    private client: EmbyClient,
    private settings: () => Promise<Settings>,
  ) {
    this.file = join(directory, 'media-downloads.json')
    this.ready = this.restore()
  }
  private async restore() {
    try {
      const records: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      // 磁盘记录只作历史展示，绝不据此恢复网络请求或文件操作。
      if (!Array.isArray(records)) return
      this.jobs = records
        .filter(
          (v): v is MediaDownload =>
            v &&
            typeof v.id === 'string' &&
            typeof v.name === 'string' &&
            typeof v.path === 'string' &&
            typeof v.temporary === 'string' &&
            typeof v.received === 'number' &&
            ['running', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'].includes(
              v.status,
            ),
        )
        .slice(-100)
        .map((v) => ({
          ...v,
          ...(['running', 'cancelling'].includes(v.status)
            ? {
                status: 'interrupted' as const,
                message: '应用退出导致下载中断，临时文件已保留；可从媒体详情重新下载。',
                ended: new Date().toISOString(),
              }
            : {}),
        }))
    } catch {
      /* 缺失或损坏历史不触发文件处理。 */
    }
  }
  private persist() {
    const content = JSON.stringify(this.jobs, null, 2)
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        await writeFile(`${this.file}.tmp`, content, 'utf8')
        await rename(`${this.file}.tmp`, this.file)
      })
    this.writes = operation
    return operation
  }
  async snapshot() {
    await this.ready
    return structuredClone(this.jobs)
  }
  async activeCountExcluding(downloadIds: ReadonlySet<string>) {
    await this.ready
    return this.jobs.filter(
      (job) => ['running', 'cancelling'].includes(job.status) && !downloadIds.has(job.id),
    ).length
  }
  async clearFinished() {
    await this.ready
    const removed = this.jobs.filter((job) => !['running', 'cancelling'].includes(job.status))
    if (!removed.length) return
    this.jobs = this.jobs.filter((job) => ['running', 'cancelling'].includes(job.status))
    try {
      await this.persist()
    } catch {
      this.jobs = [...removed, ...this.jobs]
      throw new Error('媒体库下载记录清除失败，请检查应用数据目录。')
    }
  }
  get running() {
    return this.active.size > 0 || this.starting.size > 0
  }
  get failedTaskIds() {
    return this.jobs.filter((job) => job.status === 'failed').map((job) => job.id)
  }
  cancel(id: string) {
    const active = this.active.get(id)
    if (!active) return
    const job = this.jobs.find((v) => v.id === id)!
    job.status = 'cancelling'
    job.message = '正在取消，保留临时文件。'
    active.controller.abort()
  }
  async stop() {
    this.stopping = true
    while (this.starting.size) await new Promise((resolve) => setTimeout(resolve, 25))
    for (const id of this.active.keys()) this.cancel(id)
    await Promise.allSettled([...this.active.values()].map((v) => v.promise))
    await this.writes.catch(() => {})
    this.stopping = false
  }
  async start(itemId: string, sourceId: string): Promise<MediaDownload> {
    await this.ready
    if (this.stopping) throw new Error('应用正在停止下载，请稍后重试。')
    const key = `${itemId}:${sourceId}`
    if (
      this.starting.has(key) ||
      this.jobs.some(
        (v) =>
          v.itemId === itemId &&
          v.sourceId === sourceId &&
          ['running', 'cancelling'].includes(v.status),
      )
    )
      throw new Error('此媒体版本已在下载，请到任务队列查看。')
    if (this.active.size + this.starting.size >= 3)
      throw new Error('最多同时下载三个文件，请等待或取消现有下载。')
    this.starting.add(key)
    try {
      const settings = await this.settings()
      // 保留参考项目的工作流下载目录优先级。
      const root = await safeRoot(
        settings.paths.download || settings.mediaServer.downloadDirectory,
        this.protectedPaths,
      )
      const detail = await this.client.detail(itemId)
      const generation = this.client.generation
      if (this.stopping) throw new Error('应用正在停止下载。')
      const source = detail.sources.find((v) => v.id === sourceId)
      if (!source || !detail.canDownload) throw new Error('该媒体版本不存在或账号没有下载权限。')
      const original = basename(source.path.replace(/\\/g, '/')) || source.name || detail.name
      const extension =
        extname(original)
          .replace(/[^.a-zA-Z0-9]/g, '')
          .slice(0, 12) || `.${source.container.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'mp4'}`
      let stem =
        basename(original, extname(original))
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .replace(/[. ]+$/g, '')
          .slice(0, 120) || '媒体视频'
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem)) stem = `媒体_${stem}`
      const id = randomUUID()
      const job: MediaDownload = {
        id,
        itemId,
        sourceId,
        name: detail.name,
        status: 'running',
        received: 0,
        total: source.size,
        path: await availablePath(join(root, stem + extension)),
        temporary: join(root, `${stem}.${id}.download`),
        message: '正在连接服务器。',
        started: new Date().toISOString(),
        ended: null,
      }
      this.jobs = [
        ...this.jobs.filter(
          (v) =>
            ['running', 'cancelling'].includes(v.status) ||
            this.jobs.indexOf(v) >= this.jobs.length - 96,
        ),
        job,
      ]
      try {
        await this.persist()
      } catch {
        job.status = 'failed'
        job.message = '下载记录无法保存，未开始下载。'
        throw new Error(job.message)
      }
      const controller = new AbortController()
      const promise = this.execute(job, root, controller, generation)
      this.active.set(id, { controller, promise })
      void promise.finally(() => this.active.delete(id))
      return structuredClone(job)
    } finally {
      this.starting.delete(key)
    }
  }
  private async execute(
    job: MediaDownload,
    root: string,
    controller: AbortController,
    generation: number,
  ) {
    let output: Awaited<ReturnType<typeof open>> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let temporaryCreated = false
    const resetTimeout = () => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('下载连接超过 60 秒没有数据。'))
      }, 60000)
    }
    try {
      resetTimeout()
      const response = await this.client.stream(
        job.itemId,
        job.sourceId,
        controller.signal,
        generation,
      )
      clearTimeout(idle)
      reader = response.body?.getReader()
      if (!reader) throw new Error('服务器没有返回下载内容。')
      if (/text\/|application\/(json|xml)/i.test(response.headers.get('content-type') ?? ''))
        throw new Error('服务器返回了非媒体内容，下载已停止。')
      const length = Number(response.headers.get('content-length')) || null
      if (length !== null && job.total !== null && length !== job.total)
        throw new Error('服务器文件大小与媒体版本不一致，已停止下载。')
      job.total ??= length
      await checkDirectory(root)
      output = await open(job.temporary, 'wx')
      temporaryCreated = true
      job.message = '正在下载。'
      while (true) {
        controller.signal.throwIfAborted()
        resetTimeout()
        const chunk = await reader.read()
        clearTimeout(idle)
        if (chunk.done) break
        let offset = 0
        while (offset < chunk.value.length) {
          const result = await output.write(chunk.value, offset, chunk.value.length - offset)
          if (!result.bytesWritten) throw new Error('下载文件写入中断。')
          offset += result.bytesWritten
        }
        job.received += chunk.value.length
        if (job.total !== null && job.received > job.total)
          throw new Error('下载大小超过预期，临时文件已保留。')
      }
      if (!job.received || (job.total !== null && job.total !== job.received))
        throw new Error('下载文件不完整，临时文件已保留。')
      await output.sync()
      await output.close()
      output = undefined
      controller.signal.throwIfAborted()
      await checkDirectory(root)
      // 同目录硬链接原子发布，目标存在时重选名称，绝不覆盖；不支持时保留完整临时文件。
      for (let attempt = 0; ; attempt++) {
        try {
          await link(job.temporary, job.path)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 100)
            throw new Error('无法安全发布下载文件，完整临时文件已保留。')
          job.path = await availablePath(job.path)
        }
      }
      await unlink(job.temporary).catch(() => {})
      job.status = 'completed'
      job.message = '下载完成，已校验文件大小。'
    } catch (error) {
      job.status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed'
      job.message =
        job.status === 'cancelled'
          ? '下载已取消。'
          : timedOut
            ? '下载连接超过 60 秒没有数据，已停止下载。'
            : generation !== this.client.generation
              ? '媒体服务器连接或认证已变化，已停止下载；请重新连接后重试。'
              : downloadError(error)
      if (temporaryCreated && !job.message.includes('临时文件')) job.message += ' 临时文件已保留。'
    } finally {
      clearTimeout(idle)
      await reader?.cancel().catch(() => {})
      await output?.close().catch(() => {})
      job.ended = new Date().toISOString()
      await this.persist().catch(() => {
        job.message += ' 下载记录保存失败。'
      })
    }
  }
}
