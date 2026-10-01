import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { checkpoint, checkDirectory, exists, fileStamp, unchanged } from './safe-files'

const leaseSchema = z
  .object({
    pid: z.number().int().positive(),
    directory: z.string().min(1),
    resource: z.enum(['mdc', 'transfer']),
  })
  .strict()
export async function resourceLeases(directory: string) {
  const root = join(dirname(directory), '资源占用')
  if (!(await exists(root))) return []
  await checkDirectory(root)
  const leases = []
  // 旧版 GPU 记录不再参与调度或恢复检查，保留原文件。
  for (const resource of ['mdc', 'transfer']) {
    const path = join(root, resource + '.json')
    if (!(await exists(path))) continue
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192)
      throw new Error('共享工具占用记录无效，未接管。')
    const value = leaseSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    if (value.resource !== resource) throw new Error('工具占用记录身份不符。')
    if (value.directory !== directory) continue
    try {
      process.kill(value.pid, 0)
      throw new Error('任务仍持有共享工具资源，未接管。')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    leases.push({ path, stamp: await fileStamp(path) })
  }
  return leases
}
/** 同一下载根下的不同应用配置共享资源槽位，遗留记录只能由用户确认恢复时释放。 */
export async function acquireResource(
  directory: string,
  resource: 'mdc' | 'transfer',
  signal: AbortSignal,
) {
  const root = join(dirname(directory), '资源占用')
  await checkDirectory(dirname(directory))
  await mkdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  await checkDirectory(root)
  const path = join(root, resource + '.json')
  let incomplete = 0
  while (true) {
    checkpoint(signal)
    const file = await open(path, 'wx').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return null
      throw error
    })
    if (file) {
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, directory, resource }), 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      const stamp = await fileStamp(path)
      return async () => {
        await unchanged(path, stamp)
        await unlink(path)
      }
    }
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) continue
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192)
      throw new Error('共享资源记录不可确认，已停止等待。')
    let value: z.infer<typeof leaseSchema>
    try {
      value = leaseSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (++incomplete <= 5) {
        await delay(200, undefined, { signal })
        continue
      }
      throw new Error('共享资源记录损坏，请核对所属任务。')
    }
    incomplete = 0
    try {
      process.kill(value.pid, 0)
    } catch {
      throw new Error('共享工具占用记录发生中断，请先在任务队列确认恢复所属任务。')
    }
    await delay(200, undefined, { signal })
  }
}
