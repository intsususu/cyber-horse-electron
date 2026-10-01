import { link, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TaskFile } from '../../shared/task-workspace'
import {
  checkpoint,
  copySizeChecked,
  exists,
  fileStamp,
  hashFile,
  inside,
  makeDirectory,
  removeChecked,
  unchanged,
} from './safe-files'

/** 内容只从本地上传；暂存提交不支持硬链接时仍从本地重传，绝不读取 NAS。 */
export async function publishNasFile(
  root: string,
  source: string,
  staged: string,
  publication: TaskFile['publications'][number],
  signal: AbortSignal,
  save: (message: string) => Promise<void>,
  beforePublish: () => Promise<void>,
): Promise<void> {
  if (inside(root, source) || !inside(root, staged) || !inside(root, publication.target))
    throw new Error('NAS 发布只接受本地来源和范围内目标，禁止从 NAS 回读或二次复制。')
  const sourceStamp = await fileStamp(source)
  if (
    sourceStamp.size !== publication.size ||
    (await hashFile(source, signal)) !== publication.sha256
  )
    throw new Error('发布来源内容不一致，已停止。')
  await makeDirectory(root, dirname(publication.target))
  if (await exists(publication.target)) {
    if (!publication.previous)
      throw new Error('NAS 目标已存在但缺少完整写入快照，已保留两端，请人工核对。')
    await unchanged(publication.target, publication.previous)
  }
  if (await exists(staged)) {
    if (!publication.stagedStamp || publication.stagedStamp.size !== publication.size)
      throw new Error('NAS 暂存文件缺少完整写入快照，已保留两端，请人工核对。')
    await unchanged(staged, publication.stagedStamp)
  } else {
    if (publication.stagedStamp)
      throw new Error('NAS 暂存文件已消失但发布未确认，已保留本地来源，请人工核对。')
    await copySizeChecked(source, staged, signal)
    publication.stagedStamp = await fileStamp(staged)
    if (publication.stagedStamp.size !== publication.size)
      throw new Error('NAS 暂存文件大小不一致。')
    await save('NAS 暂存写入完成，快照已保存。')
  }
  await beforePublish()
  checkpoint(signal)
  await unchanged(source, sourceStamp)
  await unchanged(staged, publication.stagedStamp)
  if (publication.previous) {
    await unchanged(publication.target, publication.previous)
    await rename(staged, publication.target)
  } else {
    try {
      // 独占建立最终名称；不使用可能覆盖未知目标的 rename。
      await link(staged, publication.target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(code ?? ''))
        throw error
      await copySizeChecked(source, publication.target, signal)
    }
  }
  const committed = await fileStamp(publication.target)
  await unchanged(source, sourceStamp)
  if (committed.size !== publication.size) throw new Error('NAS 目标大小不一致，本地来源已保留。')
  if (await exists(staged)) {
    const stamp = await fileStamp(staged)
    // 本次建立硬链接会改变 ctime；其余身份必须仍属于已确认的暂存文件。
    if (
      ['size', 'mtimeMs', 'ino', 'dev'].some(
        (key) =>
          stamp[key as keyof typeof stamp] !== publication.stagedStamp![key as keyof typeof stamp],
      )
    )
      throw new Error('NAS 暂存身份发生变化，未清理。')
    await unchanged(publication.target, committed)
    await removeChecked(staged, root, stamp, signal)
  }
  const targetStamp = await fileStamp(publication.target)
  if (
    ['size', 'mtimeMs', 'ino', 'dev'].some(
      (key) =>
        targetStamp[key as keyof typeof targetStamp] !== committed[key as keyof typeof targetStamp],
    )
  )
    throw new Error('NAS 目标发生变化，本地来源已保留。')
  // 暂存硬链接移除也会改变 ctime，最终快照必须在提交全部完成之后保存。
  publication.targetStamp = targetStamp
  await save('目标写入已完成，发布快照已保存。')
}
