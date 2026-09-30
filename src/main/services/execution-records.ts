import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { executionRecordSchema, type ExecutionRecordRequest } from '../../shared/execution-record'
import { checkDirectory, fileStamp } from './safe-files'
import { redactToolLine } from './tool-process'

const readLimit = 8 * 1024 * 1024
type Entry = Record<string, unknown>
const object = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const scrub = (value: unknown): unknown => {
  if (typeof value === 'string') return redactToolLine(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (!object(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, content]) => [
      key,
      /password|passwd|token|secret|api[_-]?key|authorization|密码|令牌/i.test(key)
        ? '[已隐藏]'
        : scrub(content),
    ]),
  )
}
type Journal = { path: string; entries: Entry[]; notes: string[] }

/** 只从应用数据目录读取固定种类与 UUID 对应的记录，生成独立的文本快照。 */
export class ExecutionRecords {
  private opening = new Map<string, Promise<void>>()
  constructor(
    private directory: string,
    private openText: (path: string) => Promise<string>,
  ) {}

  open(value: ExecutionRecordRequest): Promise<void> {
    const parsed = executionRecordSchema.safeParse(value)
    if (!parsed.success) return Promise.reject(new Error('执行记录标识无效。'))
    const key = `${parsed.data.kind}-${parsed.data.id}`
    const existing = this.opening.get(key)
    if (existing) return existing
    const work = this.exportAndOpen(parsed.data).finally(() => this.opening.delete(key))
    this.opening.set(key, work)
    return work
  }

  private async read(request: ExecutionRecordRequest): Promise<Journal> {
    const root = await checkDirectory(this.directory)
    const folder = await checkDirectory(join(root, request.kind))
    const path = join(folder, `${request.id}.jsonl`)
    const stamp = await fileStamp(path)
    const file = await open(path, 'r')
    let text = ''
    try {
      const current = await file.stat()
      if (!current.isFile() || current.ino !== stamp.ino || current.dev !== stamp.dev)
        throw new Error('执行记录已变化，请重新打开。')
      const buffer = Buffer.alloc(Math.min(current.size, readLimit))
      let offset = 0
      while (offset < buffer.length) {
        const result = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      text = buffer.subarray(0, offset).toString('utf8')
    } finally {
      await file.close()
    }
    const entries: Entry[] = []
    const notes: string[] = []
    if (stamp.size > readLimit)
      notes.push('此记录超过 8 MiB，文本快照仅包含前 8 MiB；原始文件未修改。')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const value: unknown = JSON.parse(line)
        if (!object(value)) throw new Error('无效记录行')
        entries.push(scrub(value) as Entry)
      } catch {
        if (!notes.includes('部分记录行损坏或尚未写完，已跳过；可稍后重新打开。'))
          notes.push('部分记录行损坏或尚未写完，已跳过；可稍后重新打开。')
      }
    }
    return { path, entries, notes }
  }

  private async exportAndOpen(request: ExecutionRecordRequest) {
    let primary: Journal
    try {
      primary = await this.read(request)
    } catch {
      throw new Error('无法读取执行记录：文件尚未生成、已移除，或不是允许的普通记录文件。')
    }
    const journals = [primary]
    const notes = [...primary.notes]
    const pipelineIds = new Set<string>()
    const savedLogs: unknown[] = []
    for (const event of primary.entries) {
      const pipeline =
        object(event.record) && object(event.record.pipeline) ? event.record.pipeline : null
      const id = event.type === '处理记录' ? event.pipelineId : pipeline?.id
      if (request.kind === 'media-process' && typeof id === 'string') {
        const parsed = executionRecordSchema.safeParse({ kind: 'pipeline', id })
        if (parsed.success) pipelineIds.add(parsed.data.id)
        else notes.push('关联处理标识无效，未读取该关联记录。')
      }
      if (pipeline && Array.isArray(pipeline.logs)) savedLogs.push(...pipeline.logs)
    }
    if (pipelineIds.size > 8) notes.push('关联记录过多，仅读取前 8 项。')
    for (const id of [...pipelineIds].slice(0, 8)) {
      try {
        const journal = await this.read({ kind: 'pipeline', id })
        journals.push(journal)
        notes.push(...journal.notes)
      } catch {
        notes.push(`关联处理记录 ${id} 无法读取，保留主记录中已有的日志。`)
      }
    }
    const logs = new Map<string, { time: string; level: string; text: string }>()
    const collect = (value: unknown) => {
      if (!object(value) || typeof value.text !== 'string') return
      const entry = {
        time: typeof value.time === 'string' ? value.time : '',
        level: typeof value.level === 'string' ? value.level : 'info',
        text: value.text,
      }
      logs.set(JSON.stringify(entry), entry)
    }
    for (const journal of journals)
      for (const event of journal.entries) {
        if (event.type === 'log' || event.type === '日志') collect(event.entry)
        if (event.type === 'log-truncated' && typeof event.message === 'string')
          notes.push(event.message)
      }
    savedLogs.forEach(collect)
    const lines = [
      'Cyber Horse 执行记录与日志',
      `任务标识：${request.id}`,
      `原始记录：${primary.path}`,
      `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      '本文件是打开时的文本快照；运行中的任务可再次点击更新。原始记录保持不变。',
      '历史任务仅包含当时已保存的日志；未保存的工具输出无法补回。',
      ...notes.map((note) => `提示：${note}`),
      '',
      '【执行日志】',
      ...[...logs.values()]
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((entry) => {
          const stamp = Date.parse(entry.time)
          const time = Number.isFinite(stamp)
            ? new Date(stamp).toLocaleString('zh-CN', { hour12: false })
            : entry.time || '时间未记录'
          return `[${time}] [${entry.level === 'warning' ? '提示' : entry.level === 'success' ? '完成' : '信息'}] ${entry.text}`
        }),
    ]
    if (!logs.size) lines.push('没有独立的文本日志，请查看下方执行事件。')
    for (const [index, journal] of journals.entries()) {
      lines.push(
        '',
        index === 0 ? '【主任务执行事件】' : '【关联处理执行事件】',
        `来源：${journal.path}`,
      )
      for (const event of journal.entries)
        if (event.type !== 'log' && event.type !== '日志')
          lines.push(JSON.stringify(event, null, 2))
    }
    const root = await checkDirectory(this.directory)
    const folder = join(root, 'execution-records')
    try {
      await mkdir(folder)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('无法创建执行记录文本目录。')
    }
    await checkDirectory(folder)
    const path = join(folder, `${request.kind}-${request.id}.txt`)
    try {
      await fileStamp(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('文本记录目标不是允许的普通文件。')
    }
    const temporary = join(folder, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, path)
    } catch {
      throw new Error('无法生成执行记录文本，请检查应用数据目录权限。')
    } finally {
      await unlink(temporary).catch(() => {})
    }
    let error: string
    try {
      error = await this.openText(path)
    } catch {
      error = '打开失败'
    }
    if (error) throw new Error('无法打开执行记录，请检查系统的 TXT 默认打开程序。')
  }
}
