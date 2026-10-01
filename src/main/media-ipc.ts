import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
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
import { MediaDeletion } from './services/media-deletion'
import type { WorkspaceTasks } from './services/workspace-tasks'
import type { MediaPopularService } from './services/media-popular'
import { popularPageSchema } from '../shared/media-popular'

export function registerMediaIpc(
  client: EmbyClient,
  downloads: MediaDownloads,
  processes: MediaProcessService,
  playback: MediaPlayback,
  validate: (event: IpcMainInvokeEvent) => void,
  workspaceTasks?: WorkspaceTasks,
  popular?: MediaPopularService,
  runTask: <T>(action: () => T | Promise<T>) => Promise<T> = async (action) => action(),
) {
  const bind = <T>(channel: string, schema: z.ZodType<T>, action: (value: T) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      validate(event)
      if (args.length > 1) throw new Error('媒体库参数无效。')
      const parsed = schema.safeParse(args[0])
      if (!parsed.success) throw new Error('媒体库参数无效。')
      if (
        [
          channels.startMediaDownload,
          channels.enqueueMediaProcess,
          channels.startMediaProcess,
        ].some((value) => value === channel)
      )
        return runTask(() => action(parsed.data))
      return action(parsed.data)
    })
  }
  bind(channels.getMediaLibraries, z.undefined(), () => client.libraries())
  if (popular) {
    bind(channels.getMediaPopular, z.undefined(), () => popular.state())
    bind(channels.refreshMediaPopular, z.undefined(), () => popular.refresh())
    bind(channels.cancelMediaPopular, z.undefined(), () => popular.cancel())
    bind(channels.getMediaPopularPage, popularPageSchema, (query) => popular.page(query))
  }
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
  const deletion = new MediaDeletion(client, downloads, processes)
  bind(channels.prepareMediaDeletion, mediaIdSchema, (id) => deletion.prepare(id))
  bind(channels.deleteMediaItem, z.string().uuid(), (token) => deletion.confirm(token))
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
    const tasks = workspaceTasks
      ? (await workspaceTasks.list()).tasks.filter((view) => view.active)
      : []
    return {
      active:
        summary.active +
        tasks.filter((view) => !summary.workspaceIds.has(view.task.id)).length +
        (await downloads.activeCountExcluding(summary.downloadIds)),
      ...(workspaceTasks ? { unified: true } : {}),
    }
  })
  bind(channels.cancelMediaProcess, z.string().uuid(), (id) => processes.cancel(id))
  bind(channels.clearMediaTasks, z.undefined(), async () => {
    await downloads.clearFinished()
    processes.clearFinished()
    await workspaceTasks?.clearHistory()
  })
}
