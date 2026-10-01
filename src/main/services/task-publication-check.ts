import type { TaskFile, TaskManifest } from '../../shared/task-workspace'
import { checkpoint, fileStamp, hashFile, inside, unchanged } from './safe-files'

export const isNasPublication = (task: TaskManifest) =>
  task.destination.kind === 'nas' || task.destination.kind === 'media-original'

/** 发布和收尾共用同一证据；NAS 只查元数据，禁止回读媒体内容。 */
export async function checkPublication(
  task: TaskManifest,
  publication: TaskFile['publications'][number],
  signal: AbortSignal,
): Promise<void> {
  checkpoint(signal)
  if (!inside(task.destination.root, publication.target)) throw new Error('发布目标超出任务范围。')
  if (isNasPublication(task)) {
    if (!publication.targetStamp || publication.targetStamp.size !== publication.size)
      throw new Error(
        'NAS 发布缺少完整写入快照，已保留文件，请人工核对；不会回读或仅按大小认领目标。',
      )
    await unchanged(publication.target, publication.targetStamp)
  } else if (
    (await fileStamp(publication.target)).size !== publication.size ||
    (await hashFile(publication.target, signal)) !== publication.sha256
  ) {
    throw new Error('发布结果已变化，未清理来源。')
  }
}
