import { z } from 'zod'

export const mediaIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w-]+$/)
const namedSchema = z
  .object({ id: mediaIdSchema.or(z.literal('')), name: z.string().min(1).max(512) })
  .strict()
export const mediaQuerySchema = z
  .object({
    // 未指定媒体库时，查询当前账号可访问的全部媒体。
    libraryId: mediaIdSchema.optional(),
    start: z.number().int().min(0).max(10000000),
    limit: z.number().int().min(1).max(100),
    sort: z.enum(['DateCreated', 'DatePlayed', 'PlayCount']),
    favorites: z.boolean(),
    searchTerm: z.string().trim().min(1).max(200).optional(),
    filter: namedSchema.extend({ kind: z.enum(['genre', 'person']) }).optional(),
  })
  .strict()
export const mediaFavoriteSchema = z.object({ id: mediaIdSchema, favorite: z.boolean() }).strict()
export const mediaDownloadSchema = z.object({ id: mediaIdSchema, sourceId: mediaIdSchema }).strict()
export const mediaLinkSchema = z
  .object({ id: mediaIdSchema, target: z.enum(['emby', 'javbus']) })
  .strict()
export type MediaLinkTarget = z.infer<typeof mediaLinkSchema>['target']
export const mediaPlaybackSchema = mediaDownloadSchema.extend({
  startSeconds: z
    .number()
    .finite()
    .nonnegative()
    .max(24 * 60 * 60),
  transcode: z.boolean(),
})
export const mediaPlaybackErrorSchema = z
  .object({
    token: z.string().uuid(),
    code: z.number().int().min(0).max(4),
    readyState: z.number().int().min(0).max(4),
    networkState: z.number().int().min(0).max(3),
  })
  .strict()
export const mediaImageSchema = z
  .object({
    id: mediaIdSchema.optional(),
    kind: z.enum(['Primary', 'Thumb', 'Chapter', 'privacyPoster', 'privacyThumb']),
    index: z.number().int().min(0).max(999).optional(),
  })
  .strict()
  .refine((value) => value.kind.startsWith('privacy') || !!value.id)
  .refine((value) => (value.kind === 'Chapter') === (value.index !== undefined))
export type MediaQuery = z.infer<typeof mediaQuerySchema>
export type MediaImageRequest = z.infer<typeof mediaImageSchema>
export type MediaNamed = { id: string; name: string }
export type MediaDeletionConfirmation = MediaNamed & { token: string }
export type MediaLibrary = MediaNamed & { collectionType: string }
export type LibraryVideo = MediaNamed & {
  overview: string
  year: number | null
  minutes: number | null
  favorite: boolean
  favoriteDate: string | null
}
export type LibraryPage = {
  items: LibraryVideo[]
  total: number
  start: number
  next: number
  favoriteDateUnavailable: boolean
}
export type MediaSubtitle = {
  index: number
  name: string
  language: string
  codec: string
  isText: boolean
}
export type MediaSource = MediaNamed & {
  path: string
  container: string
  size: number | null
  subtitles: MediaSubtitle[]
  defaultSubtitleIndex: number | null
}
export type MediaChapter = { index: number; name: string; startSeconds: number; hasImage: boolean }
export type MediaPlaybackSession = {
  url: string
  token: string
  direct: boolean
  diagnosticId: string
  // 旧开发后台不会返回此字段，渲染端需保留原视频加载方式。
  supportsCrossOrigin?: boolean
  subtitles: MediaSubtitle[]
  defaultSubtitleIndex: number | null
}
export type MediaDetail = LibraryVideo & {
  created: string
  path: string
  genres: MediaNamed[]
  studios: MediaNamed[]
  people: (MediaNamed & { role: string; type: string })[]
  sources: MediaSource[]
  chapters: MediaChapter[]
  canDelete: boolean
  canDownload: boolean
}
export type MediaPublicationRequest = {
  itemId: string
  path: string
  size: number
  chinese: boolean
}
export type MediaPublicationCheck = {
  state: 'confirmed' | 'not-found' | 'ambiguous' | 'size-mismatch' | 'subtitle-missing'
  itemId: string | null
  message: string
}
export type MediaDownload = {
  id: string
  itemId: string
  sourceId: string
  name: string
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  received: number
  total: number | null
  path: string
  temporary: string
  message: string
  started: string
  ended: string | null
}
export type MediaQueueSummary = { active: number; unified?: boolean }
export const mediaEnqueueSchema = z
  .object({
    id: mediaIdSchema,
    sourceId: mediaIdSchema.optional(),
    kind: z.enum(['subtitle', 'video']),
    name: z.string().trim().min(1).max(512),
  })
  .strict()
export type MediaEnqueueResult = { id: string; alreadyQueued: boolean }
export interface MediaLibraryApi {
  openMediaLink(request: z.infer<typeof mediaLinkSchema>): Promise<void>
  openMediaPlayback(request: {
    id: string
    sourceId: string
    startSeconds: number
    transcode: boolean
  }): Promise<MediaPlaybackSession | null>
  closeMediaPlayback(token: string): Promise<void>
  reportMediaPlaybackError(request: z.infer<typeof mediaPlaybackErrorSchema>): Promise<void>
  enqueueMediaProcess(request: z.infer<typeof mediaEnqueueSchema>): Promise<MediaEnqueueResult>
  previewMediaProcess(request: {
    id: string
    sourceId: string
    kind: 'subtitle' | 'video'
  }): Promise<MediaProcessPlan>
  startMediaProcess(planId: string): Promise<void>
  getMediaProcesses(): Promise<MediaProcessState[]>
  getMediaQueueSummary(): Promise<MediaQueueSummary>
  cancelMediaProcess(id: string): Promise<void>
  clearMediaTasks(): Promise<void>
  getMediaLibraries(): Promise<MediaLibrary[]>
  getMediaPage(query: MediaQuery): Promise<LibraryPage>
  getMediaDetail(id: string): Promise<MediaDetail>
  getMediaSimilar(id: string): Promise<LibraryVideo[]>
  getMediaImage(request: MediaImageRequest): Promise<string | null>
  setMediaFavorite(request: { id: string; favorite: boolean }): Promise<boolean>
  refreshMediaItem(id: string): Promise<void>
  prepareMediaDeletion(id: string): Promise<MediaDeletionConfirmation>
  deleteMediaItem(token: string): Promise<boolean>
  startMediaDownload(request: { id: string; sourceId: string }): Promise<MediaDownload>
  getMediaDownloads(): Promise<MediaDownload[]>
  cancelMediaDownload(id: string): Promise<void>
}
export const mediaProcessSchema = mediaDownloadSchema.extend({
  kind: z.enum(['subtitle', 'video']),
})
export type MediaProcessPlan = {
  id: string
  itemId: string
  sourceId: string
  name: string
  kind: 'subtitle' | 'video'
  original: string
  affected: string[]
  steps: string[]
}
export type MediaProcessState = MediaProcessPlan & {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt?: string
  endedAt?: string
  message: string
  pipeline: import('./pipeline').PipelineState | null
  downloadId: string
  journal: string
  workspaceTaskId?: string
}
