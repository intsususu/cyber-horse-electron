import { lstat, readFile, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { TaskManifest } from '../../shared/task-workspace'
import { TaskWorkspaces } from './task-workspaces'
import { assertNoTaskProcess } from './task-process-inspection'
import { resourceLeases } from './task-resource-lease'
import {
  exists,
  fileStamp,
  hashFile,
  listFiles,
  unchanged,
  copyChecked,
  makeDirectory,
} from './safe-files'
import { dirname } from 'node:path'

const records = new Set(['任务状态.json', '执行事件.jsonl', '写入锁.json', '执行锁.json'])
export class TaskRecovery {
  constructor(private workspaces: TaskWorkspaces) {}

  async inventory(directory: string, task: TaskManifest, signal: AbortSignal) {
    const known = new Set(
      task.files.flatMap((file) =>
        file.artifacts.filter((value) => value.state !== 'removed').map((value) => value.path),
      ),
    )
    const files = []
    for (const path of await listFiles(directory, signal, false)) {
      const name = relative(directory, path).replace(/\\/g, '/')
      const stamp = await fileStamp(path)
      files.push({
        path,
        stamp,
        known: known.has(name) || records.has(name),
        record: records.has(name),
      })
    }
    return files
  }

  async checkLocks(directory: string) {
    const locks = []
    for (const name of ['写入锁.json', '执行锁.json']) {
      const path = join(directory, name)
      if (!(await exists(path))) continue
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096)
        throw new Error('任务锁格式无效，未接管。')
      const data = JSON.parse(await readFile(path, 'utf8')) as { pid?: number }
      if (!Number.isInteger(data.pid) || data.pid! <= 0) throw new Error('任务锁缺少有效进程身份。')
      try {
        process.kill(data.pid!, 0)
        throw new Error('任务锁对应进程仍存在，未接管。')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      locks.push({ path, stamp: await fileStamp(path) })
    }
    await assertNoTaskProcess(directory)
    locks.push(...(await resourceLeases(directory)))
    return locks
  }

  async resume(directory: string, task: TaskManifest, signal: AbortSignal) {
    for (const lock of await this.checkLocks(directory)) {
      await unchanged(lock.path, lock.stamp)
      await unlink(lock.path)
    }
    const journal = await this.workspaces.openJournal(directory, task.id)
    await journal.repairSnapshot(task.revision)
    task = (await journal.read()).task
    const files = structuredClone(task.files)
    for (const file of files) {
      // 用户确认后的快照只用于辨认遗留文件，不能把未校验输出当成成功产物。
      for (const artifact of file.artifacts)
        if (artifact.state === 'reserved' && (await exists(join(directory, artifact.path)))) {
          const hash = await hashFile(join(directory, artifact.path), signal)
          if (artifact.sha256 && hash !== artifact.sha256)
            throw new Error('遗留产物内容已变化，未恢复。')
          artifact.stamp = await fileStamp(join(directory, artifact.path))
          artifact.sha256 = hash
        }
      for (const source of file.sources) {
        const target = join(directory, source.target)
        if (source.state === 'claiming') {
          if (await exists(target)) {
            const stamp = await fileStamp(target)
            if (stamp.size !== source.stamp.size)
              throw new Error('中断接管的输入无法确认，未重跑。')
            const record = file.artifacts.find((value) => value.path === source.target)
            if (!record?.sha256 || (await hashFile(target, signal)) !== record.sha256)
              throw new Error('中断接管缺少可核对的内容摘要。')
            if ((await exists(source.path)) && !source.copy) {
              if ((await hashFile(target, signal)) !== (await hashFile(source.path, signal)))
                throw new Error('来源和任务输入不一致，已保留两端。')
              // 保留两端时不猜测删除来源，要求用户自行核对。
              throw new Error('输入两端同时存在，请先核对来源，未删除任何副本。')
            }
            source.state = 'claimed'
            const artifact = file.artifacts.find((value) => value.path === source.target)!
            Object.assign(artifact, { state: 'verified', stamp })
          } else {
            await unchanged(source.path, source.stamp)
            source.state = 'pending'
            file.artifacts = file.artifacts.filter((value) => value.path !== source.target)
          }
        } else if (source.state === 'pending') await unchanged(source.path, source.stamp)
      }
      const unfinished = file.steps.find(
        (step) => step.id !== 'archive' && !['verified', 'skipped'].includes(step.state),
      )
      if (unfinished?.state !== 'pending' && unfinished) {
        const inputs = unfinished.inputFiles.length
          ? unfinished.inputFiles
          : [unfinished.inputVideo]
        for (const inputPath of inputs) {
          const input = file.artifacts.find((value) => value.path === inputPath)
          if (input?.sha256 && !(await exists(join(directory, input.path)))) {
            const matches = []
            for (const candidate of file.artifacts.filter(
              (value) =>
                value.state !== 'removed' &&
                value.path !== input.path &&
                value.sha256 === input.sha256,
            ))
              if (
                (await exists(join(directory, candidate.path))) &&
                (await hashFile(join(directory, candidate.path), signal)) === input.sha256
              )
                matches.push(candidate)
            if (matches.length === 1) {
              const target = join(directory, input.path)
              input.state = 'reserved'
              task = await journal.update(task.revision, {
                files: [file],
                message: '用户确认恢复，准备从摘要匹配的任务产物核对并重建步骤输入。',
              })
              await makeDirectory(directory, dirname(target))
              await copyChecked(join(directory, matches[0]!.path), target, signal)
              input.stamp = await fileStamp(target)
              input.state = 'verified'
            }
          }
          if (!input?.stamp || !(await exists(join(directory, input.path))))
            throw new Error('中断步骤的有效输入缺失，请查看任务目录；未自动重跑或删除产物。')
          await unchanged(join(directory, input.path), input.stamp)
          if (
            !input.sha256 ||
            (await hashFile(join(directory, input.path), signal)) !== input.sha256
          )
            throw new Error('恢复输入的内容摘要不匹配，未重跑。')
          input.state = 'verified'
        }
        unfinished.state = 'pending'
        unfinished.attempt++
        unfinished.outputVideo = null
        unfinished.outputFiles = []
        unfinished.message = '用户确认恢复，将在新的步骤目录重跑未完成步骤。'
      }
      // 已完成步骤只核对仍需使用的最后输出；已被后续步骤消费的输入不要求重新存在。
      if (!unfinished && !file.publications.length) {
        const last = [...file.steps].reverse().find((step) => step.id !== 'archive')
        for (const path of last?.outputFiles ?? file.sources.map((source) => source.target)) {
          const artifact = file.artifacts.find((value) => value.path === path)
          if (!artifact?.stamp) throw new Error('恢复产物缺少有效记录。')
          await unchanged(join(directory, path), artifact.stamp)
        }
      }
    }
    return journal.update(task.revision, {
      files,
      state: 'queued',
      message: '恢复已由用户确认，等待资源调度。',
    })
  }
}
