import { randomUUID } from 'node:crypto'
import type { MediaDeletionConfirmation } from '../../shared/media-library'
import type { EmbyClient } from './emby-client'
import type { MediaDownloads } from './media-downloads'
import type { MediaProcessService } from './media-process'

export class MediaDeletion {
  private pending: (MediaDeletionConfirmation & { generation: number; expires: number }) | null =
    null
  private busy = false

  constructor(
    private readonly client: Pick<EmbyClient, 'detail' | 'generation' | 'delete'>,
    private readonly downloads: Pick<MediaDownloads, 'snapshot'>,
    private readonly processes: Pick<MediaProcessService, 'snapshot'>,
  ) {}

  private async checkTasks(id: string) {
    if (
      (await this.downloads.snapshot()).some(
        (job) => job.itemId === id && ['running', 'cancelling'].includes(job.status),
      )
    )
      throw new Error('此媒体正在下载，请先取消下载再删除。')
    if (
      this.processes
        .snapshot()
        .some((job) => job.itemId === id && ['pending', 'running'].includes(job.status))
    )
      throw new Error('此媒体正在排队处理，请先取消任务。')
  }

  async prepare(id: string): Promise<MediaDeletionConfirmation> {
    if (this.busy) throw new Error('请先处理当前删除操作。')
    this.busy = true
    this.pending = null
    try {
      const detail = await this.client.detail(id)
      const generation = this.client.generation
      if (!detail.canDelete) throw new Error('当前 Emby 账号未获得删除媒体权限。')
      await this.checkTasks(id)
      const confirmation = { id, name: detail.name, token: randomUUID() }
      this.pending = { ...confirmation, generation, expires: Date.now() + 5 * 60 * 1000 }
      return confirmation
    } finally {
      this.busy = false
    }
  }

  async confirm(token: string): Promise<boolean> {
    if (this.busy) throw new Error('请先处理当前删除操作。')
    const pending = this.pending
    if (!pending || pending.token !== token || pending.expires <= Date.now())
      throw new Error('删除确认已失效，请重新打开确认弹窗。')
    // 确认只使用一次；失败也必须由用户重新确认。
    this.pending = null
    this.busy = true
    try {
      if (pending.generation !== this.client.generation)
        throw new Error('媒体服务器连接已变化，请重新确认删除。')
      await this.checkTasks(pending.id)
      await this.client.delete(pending.id, pending.generation)
      return true
    } finally {
      this.busy = false
    }
  }
}
