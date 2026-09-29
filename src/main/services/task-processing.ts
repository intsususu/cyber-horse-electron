import { mkdir, statfs } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { Settings } from '../../shared/contracts'
import type { PipelineStep } from '../../shared/pipeline'
import type { TaskFile, TaskManifest } from '../../shared/task-workspace'
import { TaskWorkspaces } from './task-workspaces'
import { TaskJournal } from './task-journal'
import { PipelineTools, type CheckedTools } from './pipeline-tools'
import { markedMediaName, taskMediaIdentity } from './media-identity'
import {
  checkDirectory,
  checkpoint,
  copyChecked,
  exists,
  fileStamp,
  hashFile,
  inside,
  listFiles,
  moveChecked,
  removeChecked,
  unchanged,
} from './safe-files'
import { mediaExtensions } from './media-inputs'

type ProcessingStep = 'subtitle-mux' | 'video' | 'scrape'
const labels: Record<ProcessingStep, string> = {
  'subtitle-mux': '字幕封装',
  video: '视频破解',
  scrape: '元数据刮削',
}
const isVideo = (path: string) => mediaExtensions.includes(extname(path).slice(1).toLowerCase())
const now = () => new Date().toISOString()

/** 新执行器的处理部分；发布及恢复入口未接通前不供桌面任务调用。 */
export class TaskProcessing {
  constructor(
    private readonly workspaces: TaskWorkspaces,
    private readonly tools = new PipelineTools(),
  ) {}

  async run(
    directory: string,
    taskId: string,
    settings: Settings,
    signal: AbortSignal,
    log: (line: string, warning?: boolean) => void = () => {},
  ): Promise<TaskManifest> {
    const journal = await this.workspaces.openJournal(directory, taskId)
    return journal.runExclusive(async () => {
      const initial = await journal.read()
      if (
        initial.snapshotNeedsRepair ||
        initial.task.state !== 'queued' ||
        initial.task.files.some((file) => file.sources.some((source) => source.state !== 'pending'))
      )
        throw new Error('任务不是可首次执行的状态，请通过恢复流程核对后处理。')
      if (
        initial.task.steps.some(
          (step) => !['subtitle-mux', 'video', 'scrape', 'archive'].includes(step),
        )
      )
        throw new Error('该入口尚未接入新任务处理器。')
      let task = initial.task
      try {
        checkpoint(signal)
        // 校验全部工具和空间后才接管来源，不能移动文件后才发现不支持目录参数。
        const steps = task.steps.filter((step): step is PipelineStep => step !== 'archive')
        const checked = await this.tools.check(settings, steps, signal, true)
        await this.preflight(task, directory)
        for (const file of task.files) {
          for (let index = 0; index < file.sources.length; index++)
            await this.workspaces.claimSource(directory, task.id, file.id, index, signal)
          task = (await journal.read()).task
          let current = task.files.find((entry) => entry.id === file.id)!
          let video = join(directory, current.sources[0]!.target)
          let files = current.sources.map((source) => join(directory, source.target))
          for (const step of steps) {
            if (!(step in labels)) continue
            const result = await this.process(
              journal,
              current,
              video,
              files,
              step as ProcessingStep,
              checked,
              settings,
              signal,
              log,
            )
            current = result.file
            video = result.video
            files = result.files
          }
        }
        task = (await journal.read()).task
        checkpoint(signal)
        return journal.update(task.revision, {
          state: 'finalizing',
          message: '所选媒体处理步骤已校验，等待发布与收尾。',
        })
      } catch (error) {
        // 写入失败或快照不一致时不继续清理；恢复服务会依据最后已落盘事件核对。
        const latest = await journal.read()
        if (!latest.snapshotNeedsRepair) {
          const message = signal.aborted
            ? '任务已取消，已保留可用文件和执行记录。'
            : error instanceof Error
              ? error.message
              : '任务处理失败，文件已保留待核对。'
          const files = latest.task.files.map((file) => ({
            ...file,
            steps: file.steps.map((step) =>
              ['running', 'validating'].includes(step.state)
                ? { ...step, state: 'failed' as const, endedAt: now(), message }
                : step,
            ),
          }))
          await journal.update(latest.task.revision, {
            state: signal.aborted ? 'cancelled' : 'failed',
            files,
            message,
          })
        }
        throw error
      }
    })
  }

  private async preflight(task: TaskManifest, directory: string): Promise<void> {
    let total = 0,
      largest = 0
    for (const file of task.files) {
      if (!isVideo(file.sources[0]!.path)) throw new Error('任务首项必须为受支持的视频。')
      for (const source of file.sources) {
        await unchanged(source.path, source.stamp)
        total += source.stamp.size
      }
      largest = Math.max(largest, file.sources[0]!.stamp.size)
      for (const step of file.steps.filter((entry) => entry.id in labels)) {
        const base = join(directory, file.directory, labels[step.id as ProcessingStep])
        if (await exists(base)) throw new Error('步骤目录已存在，不能覆盖残留或未知文件。')
        // 为工具内部后缀和临时名称保留余量，刮削生成的路径还需逐一复核。
        if (base.length + Math.max(file.name.length, 32) + 40 > 240)
          throw new Error('任务输出路径过长，请缩短下载目录或文件名称。')
      }
    }
    const space = await statfs(task.downloadRoot)
    const required = total + largest * 3 + 512 * 1024 * 1024
    if (!Number.isSafeInteger(required) || space.bavail * space.bsize < required)
      throw new Error(
        '任务工作目录可用空间不足；需容纳输入、处理输出和工具临时文件，尚未接管来源。',
      )
  }

  private async process(
    journal: TaskJournal,
    original: TaskFile,
    video: string,
    files: string[],
    id: ProcessingStep,
    tools: CheckedTools,
    settings: Settings,
    signal: AbortSignal,
    log: (line: string, warning?: boolean) => void,
  ): Promise<{ file: TaskFile; video: string; files: string[] }> {
    checkpoint(signal)
    const file = structuredClone(original)
    const step = file.steps.find((entry) => entry.id === id)!
    const identity = taskMediaIdentity(file)
    const rel = (path: string) => {
      if (!inside(join(journal.directory, file.directory), path))
        throw new Error('步骤文件超出本文件任务目录。')
      return relative(journal.directory, path).replace(/\\/g, '/')
    }
    const save = async (message: string) => {
      const latest = await journal.read()
      if (latest.snapshotNeedsRepair) throw new Error('任务记录需要确认修复，未继续执行。')
      const task = await journal.update(latest.task.revision, { files: [file], message })
      // 持久化解析可能补齐默认字段，但保持当前步骤引用不变。
      return task
    }
    const verifyInputs = async () => {
      for (const path of files) {
        const artifact = file.artifacts.find((entry) => entry.path === rel(path))
        if (!artifact || artifact.state !== 'verified' || !artifact.stamp)
          throw new Error('步骤输入没有有效的归属和校验记录。')
        await unchanged(path, artifact.stamp)
      }
    }
    const relocate = async (source: string, target: string, role: 'input' | 'output') => {
      const old = file.artifacts.find((entry) => entry.path === rel(source))
      if (!old?.stamp || old.state !== 'verified') throw new Error('移交输入缺少校验记录。')
      if (file.artifacts.some((entry) => entry.path === rel(target)) || (await exists(target)))
        throw new Error('步骤目标存在冲突，未覆盖文件。')
      file.artifacts.push({ path: rel(target), role, state: 'reserved', stamp: null, sha256: null })
      await save('文件移交目标已登记。')
      await unchanged(source, old.stamp)
      await moveChecked(source, target, signal)
      old.state = 'removed'
      const next = file.artifacts.at(-1)!
      next.state = 'verified'
      next.stamp = await fileStamp(target)
      await save('文件移交已核对。')
      return target
    }
    await verifyInputs()
    step.inputVideo = rel(video)
    step.startedAt = now()
    if ((id === 'subtitle-mux' && identity.chinese) || (id === 'video' && identity.restored)) {
      step.state = 'skipped'
      step.endedAt = now()
      step.message = '已有对应命名标记，本次没有调用处理工具。'
      step.outputVideo = rel(video)
      step.outputFiles = files.map(rel)
      await save(step.message)
      return { file, video, files }
    }
    step.state = 'running'
    step.message = '已登记步骤，等待工具处理。'
    await save(step.message)
    const base = join(journal.directory, file.directory, labels[id])
    await checkDirectory(dirname(base))
    await mkdir(base) // 独占创建，恢复场景不能直接重新调用。
    const outputRoot = join(base, '输出')
    await mkdir(outputRoot)
    let outputs: string[]
    let outputVideo: string
    let nextMarks = file.marks
    const temporary: string[] = []
    if (id === 'scrape') {
      // MDC 可以移动输入；先逐项登记移交，再使用其认可的规范名称。
      const inputRoot = join(base, '输入')
      await mkdir(inputRoot)
      const stem = basename(video, extname(video))
      const mdcName = markedMediaName(video, identity, true)
      const mdcStem = basename(mdcName, extname(mdcName))
      const moved: string[] = []
      for (const source of files) {
        const name = basename(source)
        const target = join(
          inputRoot,
          source === video
            ? mdcName
            : name.toLowerCase().startsWith(stem.toLowerCase())
              ? mdcStem + name.slice(stem.length)
              : name,
        )
        moved.push(await relocate(source, target, 'input'))
      }
      video = moved[0]!
      files = moved
      step.inputVideo = rel(video)
      await save('MDC 使用独立输入和输出目录。')
      for (const path of files) {
        file.artifacts.find((entry) => entry.path === rel(path))!.sha256 = await hashFile(
          path,
          signal,
        )
      }
      await save('MDC 输入内容摘要已保存。')
      outputs = await this.tools.scrape(
        tools,
        video,
        outputRoot,
        signal,
        log,
        identity,
        files.slice(1),
      )
      outputVideo = outputs.find(isVideo)!
    } else {
      const nextIdentity = {
        ...identity,
        chinese: identity.chinese || id === 'subtitle-mux',
        restored: identity.restored || id === 'video',
      }
      outputVideo = join(
        outputRoot,
        markedMediaName(video, nextIdentity).replace(/\.[^.]+$/, '.mkv'),
      )
      file.artifacts.push({
        path: rel(outputVideo),
        role: 'output',
        state: 'reserved',
        stamp: null,
        sha256: null,
      })
      await save('步骤输出位置已登记。')
      let subtitle: string | undefined
      if (id === 'subtitle-mux') {
        const subtitles = join(base, '字幕')
        await mkdir(subtitles)
        const srt = join(subtitles, basename(video, extname(video)) + '.srt')
        const planned = [
          srt,
          ...(settings.subtitle.format === 'ass' ? [srt.slice(0, -4) + '.ass'] : []),
        ]
        temporary.push(...planned)
        for (const path of planned)
          file.artifacts.push({
            path: rel(path),
            role: 'subtitle',
            state: 'reserved',
            stamp: null,
            sha256: null,
          })
        await save('字幕生成位置已登记。')
        const existing = files.find(
          (path) => basename(path).toLowerCase() === basename(srt).toLowerCase(),
        )
        if (existing) await copyChecked(existing, srt, signal)
        subtitle = await this.tools.subtitle(
          tools,
          video,
          outputVideo,
          settings.subtitle.format,
          signal,
          log,
          undefined,
          subtitles,
        )
        for (const path of planned) {
          const record = file.artifacts.find((entry) => entry.path === rel(path))!
          record.stamp = await fileStamp(path)
          record.state = 'verified'
        }
        await save('字幕内容与封装输出已校验。')
      } else {
        const scratch = join(base, '临时')
        await mkdir(scratch)
        const restored = join(scratch, '恢复视频.mkv')
        temporary.push(restored)
        file.artifacts.push({
          path: rel(restored),
          role: 'temporary',
          state: 'reserved',
          stamp: null,
          sha256: null,
        })
        await save('视频处理临时位置已登记。')
        await this.tools.video(tools, video, outputVideo, signal, log, undefined, {
          restored,
          workingDirectory: scratch,
        })
        const artifact = file.artifacts.find((entry) => entry.path === rel(restored))!
        artifact.state = 'verified'
        artifact.stamp = await fileStamp(restored)
      }
      await verifyInputs()
      outputs = [outputVideo]
      const oldStem = basename(video, extname(video)),
        nextStem = basename(outputVideo, extname(outputVideo))
      for (const companion of files.filter((path) => path !== video)) {
        const name = basename(companion)
        const targetName = name.toLowerCase().startsWith(oldStem.toLowerCase())
          ? nextStem + name.slice(oldStem.length)
          : name
        // 本次验证的字幕替换同格式的旧字幕；旧文件仍等到所有产物登记后才删除。
        if (subtitle && targetName.toLowerCase() === (nextStem + extname(subtitle)).toLowerCase())
          continue
        outputs.push(await relocate(companion, join(outputRoot, targetName), 'output'))
      }
      if (subtitle)
        outputs.push(
          await relocate(subtitle, join(outputRoot, nextStem + extname(subtitle)), 'output'),
        )
      nextMarks = {
        chinese:
          id === 'subtitle-mux'
            ? { present: true, evidence: 'verified-output' }
            : file.marks.chinese,
        restored:
          id === 'video' ? { present: true, evidence: 'verified-output' } : file.marks.restored,
      }
    }
    step.state = 'validating'
    await save('工具已返回，正在登记已校验产物。')
    for (const path of outputs) {
      const record = file.artifacts.find((entry) => entry.path === rel(path))
      const verified = {
        path: rel(path),
        role: 'output' as const,
        state: 'verified' as const,
        stamp: await fileStamp(path),
        sha256: await hashFile(path, signal),
      }
      if (record) Object.assign(record, verified)
      else file.artifacts.push(verified)
    }
    step.outputVideo = rel(outputVideo)
    step.outputFiles = outputs.map(rel)
    file.marks = nextMarks
    step.state = 'verified'
    step.endedAt = now()
    step.message = '步骤产物已校验，尚未发布到最终目录。'
    await save(step.message)
    const consumed = [...files, ...temporary].filter(
      (path) => file.artifacts.find((entry) => entry.path === rel(path))?.state !== 'removed',
    )
    for (const source of consumed) {
      const old = file.artifacts.find((entry) => entry.path === rel(source))!
      if (await exists(source)) {
        // 先复核所有已记录输出，确认可用产物仍在，才删除当前输入。
        for (const path of outputs)
          await unchanged(path, file.artifacts.find((entry) => entry.path === rel(path))!.stamp!)
        await unchanged(source, old.stamp!)
        old.state = 'removing'
        await save('输出已确认，准备清理被替换输入。')
        await removeChecked(source, journal.directory, old.stamp!, signal)
      }
      old.state = 'removed'
      await save('被替换输入已清理，执行记录已更新。')
    }
    // 只枚举当前步骤目录作未知文件诊断，不把工具额外写出的媒体加入任务。
    for (const path of await listFiles(base, signal)) rel(path)
    return { file, video: outputVideo, files: outputs }
  }
}
