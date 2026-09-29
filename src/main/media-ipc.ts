import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { channels } from '../shared/channels'
import {
  mediaIdSchema,
  mediaQuerySchema,
  mediaFavoriteSchema,
  mediaDownloadSchema,
  mediaImageSchema,
  mediaProcessSchema,
  mediaEnqueueSchema,
  mediaPlaybackSchema,
  mediaPlaybackErrorSchema,
  mediaLinkSchema,
} from '../shared/media-library'
import { MediaPlayback } from './services/media-playback'
import { MediaProcessService } from './services/media-process'
import { EmbyClient } from './services/emby-client'
import { MediaDownloads } from './services/media-downloads'

export function registerMediaIpc(
  client: EmbyClient,
  downloads: MediaDownloads,
  processes: MediaProcessService,
  playback: MediaPlayback,
  validate: (event: IpcMainInvokeEvent) => void,
  window: () => BrowserWindow | null,
) {
  const bind = <T>(channel: string, schema: z.ZodType<T>, action: (value: T) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      validate(event)
      if (args.length > 1) throw new Error('媒体库参数无效。')
      const parsed = schema.safeParse(args[0])
      if (!parsed.success) throw new Error('媒体库参数无效。')
      return action(parsed.data)
    })
  }
  bind(channels.getMediaLibraries, z.undefined(), () => client.libraries())
  bind(channels.openMediaLink, mediaLinkSchema, async ({ id, target }) => {
    const url = await client.externalLink(id, target)
    try {
      await shell.openExternal(url)
    } catch {
      throw new Error('无法打开浏览器，请检查系统默认浏览器设置。')
    }
  })
  bind(channels.openMediaPlayback, mediaPlaybackSchema, (request) =>
    playback.open(request.id, request.sourceId, request.startSeconds, request.transcode),
  )
  bind(channels.closeMediaPlayback, z.string().uuid(), (token) => playback.close(token))
  bind(channels.reportMediaPlaybackError, mediaPlaybackErrorSchema, (request) =>
    playback.reportError(request),
  )
  bind(channels.getMediaPage, mediaQuerySchema, (query) => client.page(query))
  bind(channels.getMediaDetail, mediaIdSchema, (id) => client.detail(id))
  bind(channels.getMediaSimilar, mediaIdSchema, (id) => client.similar(id))
  bind(channels.getMediaImage, mediaImageSchema, (request) => client.image(request))
  bind(channels.setMediaFavorite, mediaFavoriteSchema, (request) =>
    client.favorite(request.id, request.favorite),
  )
  bind(channels.refreshMediaItem, mediaIdSchema, (id) => client.refresh(id))
  let deleting = false
  bind(channels.deleteMediaItem, mediaIdSchema, async (id) => {
    if (deleting) throw new Error('请先处理当前删除确认。')
    deleting = true
    try {
      const detail = await client.detail(id)
      const generation = client.generation
      if (!detail.canDelete) throw new Error('当前 Emby 账号未获得删除媒体权限。')
      if (
        (await downloads.snapshot()).some(
          (job) => job.itemId === id && ['running', 'cancelling'].includes(job.status),
        )
      )
        throw new Error('此媒体正在下载，请先取消下载再删除。')
      if (
        processes
          .snapshot()
          .some((job) => job.itemId === id && ['pending', 'running'].includes(job.status))
      )
        throw new Error('此媒体正在排队处理，请先取消任务。')
      const parent = window()
      if (!parent) return false
      const result = await dialog.showMessageBox(parent, {
        type: 'warning',
        title: '删除服务器媒体',
        message: `确定从 Emby 删除“${detail.name}”？`,
        detail: '这可能永久删除服务器上的媒体文件，无法在本应用中恢复。',
        buttons: ['取消', '永久删除'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (result.response !== 1) return false
      if (
        (await downloads.snapshot()).some(
          (job) => job.itemId === id && ['running', 'cancelling'].includes(job.status),
        ) ||
        processes
          .snapshot()
          .some((job) => job.itemId === id && ['pending', 'running'].includes(job.status))
      )
        throw new Error('确认期间此媒体已启动下载或处理，删除已取消。')
      await client.delete(id, generation)
      return true
    } finally {
      deleting = false
    }
  })
  bind(channels.startMediaDownload, mediaDownloadSchema, (request) =>
    downloads.start(request.id, request.sourceId),
  )
  bind(channels.getMediaDownloads, z.undefined(), () => downloads.snapshot())
  bind(channels.cancelMediaDownload, z.string().uuid(), (id) => downloads.cancel(id))
  bind(channels.enqueueMediaProcess, mediaEnqueueSchema, (request) => processes.enqueue(request))
  bind(channels.previewMediaProcess, mediaProcessSchema, (request) =>
    processes.preview(request.id, request.sourceId, request.kind),
  )
  bind(channels.startMediaProcess, z.string().uuid(), (id) => processes.start(id))
  bind(channels.getMediaProcesses, z.undefined(), () => processes.snapshot())
  bind(channels.getMediaQueueSummary, z.undefined(), async () => {
    const summary = processes.queueSummary()
    return { active: summary.active + (await downloads.activeCountExcluding(summary.downloadIds)) }
  })
  bind(channels.cancelMediaProcess, z.string().uuid(), (id) => processes.cancel(id))
  bind(channels.clearMediaTasks, z.undefined(), async () => {
    await downloads.clearFinished()
    processes.clearFinished()
  })
}
