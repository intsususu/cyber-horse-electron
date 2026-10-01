import { basename, dirname, extname, join } from 'node:path'
import { rename } from 'node:fs/promises'
import type { TaskFile, TaskManifest } from '../../shared/task-workspace'
import { TaskWorkspaces } from './task-workspaces'
import { checkPublication, isNasPublication } from './task-publication-check'
import { publishNasFile } from './task-nas-publisher'
import {
  checkpoint,
  copyChecked,
  exists,
  fileStamp,
  hashFile,
  inside,
  makeDirectory,
  pathKey,
  removeChecked,
  safeRoot,
  unchanged,
} from './safe-files'

/** 每个文件单独记账；已提交但未清理可重复核对，不把整批发布描述为原子事务。 */
export class TaskPublisher {
  constructor(
    private workspaces: TaskWorkspaces,
    private protectedPaths: string[] = [],
  ) {}

  output(file: TaskFile): string[] {
    const last = [...file.steps]
      .reverse()
      .find((step) => step.id !== 'archive' && ['verified', 'skipped'].includes(step.state))
    return last?.outputFiles.length ? last.outputFiles : file.sources.map((source) => source.target)
  }

  targets(task: TaskManifest, file: TaskFile): { source: string; target: string }[] {
    const paths = this.output(file)
    const video = paths.find((path) =>
      /\.(mkv|mp4|avi|mov|wmv|flv|m4v|ts|mts|m2ts|webm|mpg|mpeg|vob)$/i.test(path),
    )
    if (!video) throw new Error('任务缺少可发布视频。')
    const scrape = file.steps.find((step) => step.id === 'scrape' && step.state === 'verified')
    const outputPrefix = `${file.directory}/元数据刮削${scrape?.attempt ? `-重试${scrape.attempt}` : ''}/输出/`
    let parent = task.destination.root
    if (task.destination.kind !== 'media-original' && scrape && video.startsWith(outputPrefix))
      parent = join(parent, dirname(video.slice(outputPrefix.length)))
    else if (task.destination.kind === 'nas')
      parent = join(parent, file.number ?? basename(video, extname(video)))
    return paths.map((source) => ({ source, target: join(parent, basename(source)) }))
  }

  async run(
    directory: string,
    id: string,
    signal: AbortSignal,
    beforePublish: () => Promise<void> = async () => {},
    fileId?: string,
  ): Promise<TaskManifest> {
    const journal = await this.workspaces.openJournal(directory, id)
    let task = (await journal.read()).task
    const nas = isNasPublication(task)
    await safeRoot(task.destination.root, this.protectedPaths)
    await beforePublish()
    if (
      task.files
        .filter((file) => !fileId || file.id === fileId)
        .some(
          (file) =>
            !file.steps.some((step) => step.state === 'failed') &&
            file.steps.some(
              (step) => step.id !== 'archive' && !['verified', 'skipped'].includes(step.state),
            ),
        )
    )
      throw new Error('媒体步骤尚未全部校验，未发布。')
    for (const original of task.files) {
      if (fileId && original.id !== fileId) continue
      if (original.steps.some((step) => step.state === 'failed')) continue
      const file = structuredClone(original)
      const expectedTargets = this.targets(task, file)
      if (
        file.publications.some(
          (value) =>
            !expectedTargets.some(
              (expected) =>
                expected.source === value.source &&
                pathKey(expected.target) === pathKey(value.target),
            ),
        )
      )
        throw new Error('发布记录与所属文件产物不一致，未执行。')
      const save = async (message: string) => {
        task = await journal.update(task.revision, { state: 'finalizing', files: [file], message })
      }
      if (!file.publications.length) {
        for (const entry of this.targets(task, file)) {
          const source = join(directory, entry.source)
          const artifact = file.artifacts.find((value) => value.path === entry.source)
          if (!artifact?.stamp || artifact.state !== 'verified')
            throw new Error('发布输入缺少校验记录。')
          await unchanged(source, artifact.stamp)
          const previous = task.context?.replacements.find(
            (value) => pathKey(value.path) === pathKey(entry.target),
          )
          if (await exists(entry.target)) {
            if (!previous) throw new Error('发布目标已有同名文件，已保留任务，请先处理冲突。')
            await unchanged(entry.target, previous.stamp)
            if (!nas && (await hashFile(entry.target, signal)) !== previous.sha256)
              throw new Error('原媒体内容发生变化，未覆盖。')
          }
          file.publications.push({
            source: entry.source,
            target: entry.target,
            previous: previous?.stamp ?? null,
            sha256: await hashFile(source, signal),
            size: artifact.stamp.size,
            state: 'pending',
          })
        }
        await save('发布意图已保存，尚未修改目标。')
      }
      for (const [index, publication] of file.publications.entries()) {
        checkpoint(signal)
        if (!inside(task.destination.root, publication.target))
          throw new Error('发布目标超出任务冻结目录。')
        await beforePublish()
        const source = join(directory, publication.source)
        const matches = async (path: string) =>
          (await fileStamp(path)).size === publication.size &&
          (await hashFile(path, signal)) === publication.sha256
        if (publication.state === 'pending') {
          if (await exists(publication.target)) {
            if (!publication.previous) throw new Error('目标文件出现冲突，未覆盖。')
            await unchanged(publication.target, publication.previous)
          }
          publication.state = 'committing'
          await save('准备提交已校验文件。')
        }
        if (publication.state === 'committing') {
          if (nas) {
            if (publication.targetStamp) await checkPublication(task, publication, signal)
            else
              await publishNasFile(
                task.destination.root,
                source,
                join(dirname(publication.target), `.horse-${id}-${file.id}-${index}.partial`),
                publication,
                signal,
                save,
                beforePublish,
              )
          } else if (!(await exists(publication.target)) || !(await matches(publication.target))) {
            if (await exists(publication.target)) {
              if (!publication.previous) throw new Error('目标被其他文件占用，未覆盖。')
              await unchanged(publication.target, publication.previous)
            }
            if (!(await matches(source))) throw new Error('发布来源内容不一致，已停止。')
            await makeDirectory(task.destination.root, dirname(publication.target))
            const staged = join(
              dirname(publication.target),
              `.horse-${id}-${file.id}-${index}.partial`,
            )
            if (await exists(staged)) {
              if (!(await matches(staged)))
                throw new Error('发布暂存文件不完整或被修改，已保留待核对。')
            } else await copyChecked(source, staged, signal)
            await beforePublish()
            if (publication.previous) {
              await unchanged(publication.target, publication.previous)
              const previous = task.context?.replacements.find(
                (value) => pathKey(value.path) === pathKey(publication.target),
              )
              if (!previous || (await hashFile(publication.target, signal)) !== previous.sha256)
                throw new Error('原媒体内容发生变化，未覆盖。')
              await rename(staged, publication.target)
            } else {
              // 独占发布，不用可覆盖现有文件的 rename。
              await copyChecked(staged, publication.target, signal)
              await removeChecked(staged, task.destination.root, await fileStamp(staged), signal)
            }
            if (!(await matches(publication.target)))
              throw new Error('发布内容校验失败，任务来源已保留。')
          }
          publication.state = 'published'
          await save('目标内容已核对，等待本地清理。')
        }
        await checkPublication(task, publication, signal)
      }
      // 整个文件包确认后才清理旧 NAS 文件，部分发布时唯一输入仍留在任务内。
      for (const previous of task.context?.replacements ?? []) {
        if (
          previous.removed ||
          file.publications.some((value) => pathKey(value.target) === pathKey(previous.path))
        )
          continue
        if (!inside(task.destination.root, previous.path))
          throw new Error('旧媒体超出冻结回写范围。')
        for (const value of file.publications) await checkPublication(task, value, signal)
        if (await exists(previous.path)) {
          await unchanged(previous.path, previous.stamp)
          if (!nas && (await hashFile(previous.path, signal)) !== previous.sha256)
            throw new Error('旧媒体内容发生变化。')
          previous.removalPending = true
          task = await journal.update(task.revision, {
            context: task.context,
            message: '目标已校验，准备清理冻结清单中的旧媒体。',
          })
          await removeChecked(previous.path, task.destination.root, previous.stamp, signal)
        }
        previous.removed = true
        previous.removalPending = false
        task = await journal.update(task.revision, {
          context: task.context,
          message: '已校验回写并清理旧媒体。',
        })
      }
      for (const publication of file.publications) {
        if (publication.state === 'cleaned') continue
        const source = join(directory, publication.source)
        const artifact = file.artifacts.find((value) => value.path === publication.source)!
        if (await exists(source)) {
          await checkPublication(task, publication, signal)
          await unchanged(source, artifact.stamp!)
          artifact.state = 'removing'
          await save('准备清理已发布的任务文件。')
          await removeChecked(source, directory, artifact.stamp!, signal)
        }
        artifact.state = 'removed'
        publication.state = 'cleaned'
        await save('本地发布来源已清理。')
      }
      const archive = file.steps.find((step) => step.id === 'archive')
      if (archive)
        Object.assign(archive, {
          state: 'verified',
          startedAt: archive.startedAt ?? new Date().toISOString(),
          endedAt: new Date().toISOString(),
          message: '归档内容已核对。',
        })
      await save('文件发布与清理已完成。')
    }
    return task
  }
}
