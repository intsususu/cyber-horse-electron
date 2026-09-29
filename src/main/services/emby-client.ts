import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type { Settings } from '../../shared/contracts'
import type {
  LibraryPage,
  LibraryVideo,
  MediaDetail,
  MediaImageRequest,
  MediaChapter,
  MediaQuery,
  MediaLinkTarget,
} from '../../shared/media-library'
import { mediaIdSchema } from '../../shared/media-library'
import { embyDetailUrl, javbusDetailUrl, mediaCatalogNumber } from '../../shared/media-links'
import { fileStamp } from './safe-files'

const text = z
  .string()
  .nullish()
  .transform((v) => v ?? '')
const id = z.union([z.string(), z.number()]).transform(String).pipe(mediaIdSchema)
const named = z.object({ Id: id.nullish(), Name: text })
const number = z
  .number()
  .finite()
  .nonnegative()
  .nullish()
  .transform((v) => v ?? null)
const itemSchema = z.object({
  Id: id,
  Name: text,
  Overview: text,
  ProductionYear: number,
  RunTimeTicks: number,
  CollectionType: text,
  DateCreated: text,
  Path: text,
  UserData: z.object({ IsFavorite: z.boolean().optional(), FavoriteDate: text }).nullish(),
  Genres: z.array(z.string()).nullish(),
  GenreItems: z.array(named).nullish(),
  Studios: z.array(named).nullish(),
  People: z.array(named.extend({ Role: text, Type: text })).nullish(),
  MediaSources: z
    .array(
      named.extend({
        Path: text,
        Container: text,
        Size: number,
        DefaultSubtitleStreamIndex: z.number().int().nonnegative().nullish(),
        MediaStreams: z
          .array(
            z.object({
              Type: text,
              Index: z.number().int().nonnegative(),
              DisplayTitle: text,
              Title: text,
              Language: text,
              Codec: text,
              IsTextSubtitleStream: z.boolean().nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
  Chapters: z
    .array(
      z.object({
        Name: text,
        StartPositionTicks: z.number().finite().nonnegative(),
        ImageTag: text,
      }),
    )
    .nullish(),
})
const pageSchema = z.object({
  Items: z.array(itemSchema),
  TotalRecordCount: z.number().int().nonnegative().optional(),
})
type Item = z.infer<typeof itemSchema>
type Session = {
  url: string
  userId: string
  serverId: string
  token: string
  canDelete: boolean
  canDownload: boolean
  signal: AbortSignal
}
const authHeader =
  'Emby Client="Cyber Horse", Device="Desktop", DeviceId="cyber-horse-electron", Version="0.1.0"'
const fields =
  'Overview,MediaSources,ProductionYear,RunTimeTicks,DateCreated,Path,Genres,Studios,People,Chapters'
const video = (item: Item): LibraryVideo => ({
  id: item.Id,
  name: item.Name || '未命名视频',
  overview: item.Overview,
  year: item.ProductionYear,
  minutes: item.RunTimeTicks === null ? null : Math.floor(item.RunTimeTicks / 600000000),
  favorite: item.UserData?.IsFavorite ?? false,
  favoriteDate: item.UserData?.FavoriteDate || null,
})

export class EmbyClient {
  private revision = 0
  private titleSearchCache?: { key: string; items: LibraryVideo[] }
  get generation() {
    return this.revision
  }
  private key = ''
  private session?: Promise<Session>
  private controller = new AbortController()
  constructor(
    private settings: () => Promise<Settings>,
    private password: () => Promise<string>,
  ) {}

  invalidate() {
    this.revision++
    this.titleSearchCache = undefined
    this.controller.abort()
    this.controller = new AbortController()
    this.session = undefined
  }
  syncSettings(settings: Settings) {
    const key = JSON.stringify([settings.mediaServer.serverUrl, settings.mediaServer.username])
    if (key !== this.key) {
      this.key = key
      this.invalidate()
    }
  }
  private async response(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      const response = await fetch(url, { ...init, redirect: 'error', signal })
      if (!response.ok) {
        void response.body?.cancel()
        if (response.status === 401) {
          this.invalidate()
          throw new Error('Emby 认证已失效，请检查账号密码后重试。')
        }
        if (response.status === 403) throw new Error('当前 Emby 账号没有此操作权限。')
        if (response.status === 404) throw new Error('媒体项目不存在或已被移除。')
        throw new Error(`Emby 请求失败（状态码 ${response.status}）。`)
      }
      return response
    } catch (error) {
      if (error instanceof Error && /^(Emby|当前 Emby|媒体项目)/.test(error.message)) throw error
      throw new Error(
        signal.aborted
          ? '请求已取消或超时，请重试。'
          : '无法连接 Emby，请检查服务器地址、网络和证书；不允许跨地址重定向。',
      )
    }
  }
  private async bounded(response: Response, maximum: number) {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('服务器返回空响应。')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.length
        if (size > maximum) throw new Error('服务器响应超过允许大小。')
        chunks.push(result.value)
      }
      return Buffer.concat(chunks)
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
  private async json(response: Response): Promise<unknown> {
    try {
      return JSON.parse((await this.bounded(response, 8 * 1024 * 1024)).toString('utf8'))
    } catch {
      throw new Error('无法解析 Emby 响应，请检查服务器版本与地址。')
    }
  }
  private async authenticate(): Promise<Session> {
    const settings = await this.settings()
    this.syncSettings(settings)
    if (!this.session) {
      const signal = this.controller.signal
      const operation = (async () => {
        const config = settings.mediaServer
        if (!config.serverUrl || !config.username)
          throw new Error('请先保存媒体服务器地址和用户名。')
        const url = new URL(config.serverUrl)
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('服务器地址必须是无凭据、查询参数和片段的 HTTP 或 HTTPS 地址。')
        url.pathname = url.pathname.replace(/\/+$/, '') + '/'
        const response = await this.response(
          new URL('Users/AuthenticateByName', url).href,
          {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ Username: config.username, Pw: await this.password() }),
          },
          AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        )
        const auth = z
          .object({
            AccessToken: z.string().min(1).max(4096),
            ServerId: text,
            User: z.object({
              Id: id,
              ServerId: text,
              Policy: z
                .object({
                  EnableContentDeletion: z.boolean().optional(),
                  EnableContentDownloading: z.boolean().optional(),
                })
                .optional(),
            }),
          })
          .safeParse(await this.json(response))
        if (!auth.success) throw new Error('Emby 认证响应格式无效。')
        signal.throwIfAborted()
        return {
          url: url.href,
          token: auth.data.AccessToken,
          userId: auth.data.User.Id,
          serverId: auth.data.ServerId || auth.data.User.ServerId,
          canDelete: auth.data.User.Policy?.EnableContentDeletion === true,
          canDownload: auth.data.User.Policy?.EnableContentDownloading !== false,
          signal,
        }
      })()
      this.session = operation
      void operation.catch(() => {
        if (this.session === operation) this.session = undefined
      })
    }
    return this.session
  }
  private async request(
    session: Session,
    path: string,
    query: Record<string, string> = {},
    method = 'GET',
    signal?: AbortSignal,
  ) {
    const url = new URL(path, session.url)
    url.search = new URLSearchParams(query).toString()
    return this.response(
      url.href,
      { method, headers: { Authorization: authHeader, 'X-Emby-Token': session.token } },
      AbortSignal.any([session.signal, signal ?? AbortSignal.timeout(20000)]),
    )
  }
  private parsePage(data: unknown) {
    const result = pageSchema.safeParse(data)
    if (!result.success) throw new Error('Emby 媒体列表格式无效。')
    return result.data
  }
  async libraries() {
    const s = await this.authenticate()
    const data = this.parsePage(await this.json(await this.request(s, `Users/${s.userId}/Views`)))
    return data.Items.map((item) => ({
      id: item.Id,
      name: item.Name || '未命名媒体库',
      collectionType: item.CollectionType,
    }))
  }
  async page(query: MediaQuery): Promise<LibraryPage> {
    const s = await this.authenticate()
    const params: Record<string, string> = {
      ParentId: query.libraryId,
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Video,Episode',
      Fields: fields,
      EnableUserData: 'true',
      SortBy: query.sort,
      SortOrder: 'Descending',
      StartIndex: String(query.start),
      Limit: String(query.limit),
    }
    if (query.favorites) params.IsFavorite = 'true'
    if (query.filter) {
      const { kind, id, name } = query.filter
      params[kind === 'genre' ? (id ? 'GenreIds' : 'Genres') : id ? 'PersonIds' : 'Person'] =
        id || name
    }
    if (query.searchTerm) return this.titleSearchPage(s, query, params)
    const data = this.parsePage(
      await this.json(await this.request(s, `Users/${s.userId}/Items`, params)),
    )
    const items = data.Items.map(video)
    return {
      items,
      total: data.TotalRecordCount ?? query.start + items.length,
      start: query.start,
      next: query.start + data.Items.length,
      favoriteDateUnavailable: query.favorites && items.some((item) => !item.favoriteDate),
    }
  }
  private async titleSearchPage(
    session: Session,
    query: MediaQuery,
    params: Record<string, string>,
  ): Promise<LibraryPage> {
    const key = JSON.stringify([
      this.revision,
      query.libraryId,
      query.searchTerm,
      query.sort,
      query.favorites,
      query.filter,
    ])
    let matches =
      query.start > 0 && this.titleSearchCache?.key === key
        ? this.titleSearchCache.items
        : undefined
    if (!matches) {
      matches = []
      const seen = new Set<string>()
      const term = query.searchTerm!.normalize('NFKC').toLocaleLowerCase()
      let start = 0
      while (true) {
        const data = this.parsePage(
          await this.json(
            await this.request(session, `Users/${session.userId}/Items`, {
              ...params,
              Fields: 'ProductionYear,RunTimeTicks,DateCreated',
              StartIndex: String(start),
              Limit: '100',
            }),
          ),
        )
        if (data.Items.length === 0) {
          if (data.TotalRecordCount !== undefined && start < data.TotalRecordCount)
            throw new Error('媒体库列表分页不完整，请重试搜索。')
          break
        }
        for (const item of data.Items) {
          if (
            !seen.has(item.Id) &&
            item.Name.normalize('NFKC').toLocaleLowerCase().includes(term)
          ) {
            seen.add(item.Id)
            matches.push(video(item))
          }
        }
        start += data.Items.length
        if (data.TotalRecordCount !== undefined && start >= data.TotalRecordCount) break
        if (data.TotalRecordCount === undefined && data.Items.length < 100) break
      }
      session.signal.throwIfAborted()
      this.titleSearchCache = { key, items: matches }
    }
    const items = matches.slice(query.start, query.start + query.limit)
    return {
      items,
      total: matches.length,
      start: query.start,
      next: query.start + items.length,
      favoriteDateUnavailable: query.favorites && items.some((item) => !item.favoriteDate),
    }
  }
  async detail(itemId: string): Promise<MediaDetail> {
    const s = await this.authenticate()
    const parsed = itemSchema.safeParse(
      await this.json(
        await this.request(s, `Users/${s.userId}/Items/${itemId}`, {
          Fields: fields,
          EnableUserData: 'true',
        }),
      ),
    )
    if (!parsed.success) throw new Error('Emby 媒体详情格式无效。')
    const item = parsed.data
    const namedItems = (items: z.infer<typeof named>[] | null | undefined) =>
      (items ?? []).filter((v) => v.Name).map((v) => ({ id: v.Id ?? '', name: v.Name }))
    return {
      ...video(item),
      created: item.DateCreated,
      path: item.Path,
      canDelete: s.canDelete,
      canDownload: s.canDownload,
      genres: item.GenreItems?.length
        ? namedItems(item.GenreItems)
        : (item.Genres ?? []).map((name) => ({ id: '', name })),
      studios: namedItems(item.Studios),
      people: (item.People ?? []).map((p) => ({
        id: p.Id ?? '',
        name: p.Name,
        role: p.Role,
        type: p.Type,
      })),
      sources: (item.MediaSources ?? []).map((source) => ({
        id: source.Id ?? item.Id,
        name: source.Name || item.Name,
        path: source.Path,
        container: source.Container,
        size: source.Size,
        subtitles: (source.MediaStreams ?? [])
          .filter((stream) => stream.Type.toLowerCase() === 'subtitle')
          .map((stream) => ({
            index: stream.Index,
            name: stream.DisplayTitle || stream.Title || stream.Language || `字幕 ${stream.Index}`,
            language: stream.Language,
            codec: stream.Codec,
            isText:
              stream.IsTextSubtitleStream === true ||
              (stream.IsTextSubtitleStream == null &&
                ['srt', 'subrip', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'tx3g'].includes(
                  stream.Codec.toLowerCase(),
                )),
          })),
        defaultSubtitleIndex: source.DefaultSubtitleStreamIndex ?? null,
      })),
      chapters: (item.Chapters ?? []).map((chapter, index): MediaChapter => ({
        index,
        name: chapter.Name || `第 ${index + 1} 章`,
        startSeconds: chapter.StartPositionTicks / 10000000,
        hasImage: !!chapter.ImageTag,
      })),
    }
  }
  async externalLink(itemId: string, target: MediaLinkTarget) {
    const session = await this.authenticate()
    if (target === 'emby') return embyDetailUrl(session.url, itemId, session.serverId)
    const settings = await this.settings()
    if (!settings.mediaServer.javbusUrl) throw new Error('请先配置 JavBus 地址。')
    const detail = await this.detail(itemId)
    if (session.signal.aborted) throw new Error('媒体服务器连接已变化，请重新打开详情。')
    return javbusDetailUrl(settings.mediaServer.javbusUrl, mediaCatalogNumber(detail))
  }
  async similar(itemId: string) {
    const s = await this.authenticate()
    return this.parsePage(
      await this.json(
        await this.request(s, `Items/${itemId}/Similar`, {
          UserId: s.userId,
          Limit: '12',
          Fields: fields,
          EnableUserData: 'true',
        }),
      ),
    )
      .Items.filter((item) => item.Id !== itemId)
      .map(video)
  }
  async favorite(itemId: string, favorite: boolean) {
    const s = await this.authenticate()
    const response = await this.request(
      s,
      `Users/${s.userId}/FavoriteItems/${itemId}`,
      {},
      favorite ? 'POST' : 'DELETE',
    )
    await response.body?.cancel()
    this.titleSearchCache = undefined
    return favorite
  }
  async refresh(itemId: string, expectedGeneration?: number) {
    const s = await this.authenticate()
    if (expectedGeneration !== undefined && expectedGeneration !== this.revision)
      throw new Error('媒体服务器连接已变化，未向新连接提交刷新。')
    const response = await this.request(
      s,
      `Items/${itemId}/Refresh`,
      {
        Recursive: 'true',
        ImageRefreshMode: 'Default',
        MetadataRefreshMode: 'Default',
        ReplaceAllImages: 'false',
        ReplaceAllMetadata: 'false',
      },
      'POST',
    )
    await response.body?.cancel()
    this.titleSearchCache = undefined
  }
  async delete(itemId: string, expectedGeneration?: number) {
    const s = await this.authenticate()
    if (expectedGeneration !== undefined && expectedGeneration !== this.revision)
      throw new Error('媒体服务器连接已变化，请重新确认删除。')
    if (!s.canDelete) throw new Error('当前 Emby 账号未获得删除媒体权限。')
    const response = await this.request(s, 'Items', { Ids: itemId }, 'DELETE')
    await response.body?.cancel()
    this.titleSearchCache = undefined
  }
  async stream(itemId: string, sourceId: string, signal: AbortSignal, expectedGeneration?: number) {
    const s = await this.authenticate()
    if (expectedGeneration !== undefined && expectedGeneration !== this.revision)
      throw new Error('服务器连接已变化，请重新下载。')
    if (!s.canDownload) throw new Error('当前 Emby 账号未获得下载权限。')
    return this.request(
      s,
      `Videos/${itemId}/stream`,
      { Static: 'true', MediaSourceId: sourceId },
      'GET',
      signal,
    )
  }
  async playback(
    itemId: string,
    sourceId: string,
    startSeconds: number,
    direct: boolean,
    container: string,
    range: string | null,
    signal: AbortSignal,
    expectedGeneration: number,
    playSessionId: string,
  ) {
    const s = await this.authenticate()
    if (expectedGeneration !== this.revision) throw new Error('媒体服务器连接已变化，请重新播放。')
    const query: Record<string, string> = {
      MediaSourceId: sourceId,
      PlaySessionId: playSessionId,
    }
    if (direct) query.Static = 'true'
    else {
      query.VideoCodec = 'h264'
      query.AudioCodec = 'aac'
      query.MaxAudioChannels = '2'
      query.StartTimeTicks = String(Math.floor(startSeconds * 10000000))
    }
    const url = new URL(`Videos/${itemId}/stream.${direct ? container : 'mp4'}`, s.url)
    url.search = new URLSearchParams(query).toString()
    return this.response(
      url.href,
      {
        headers: {
          Authorization: authHeader,
          'X-Emby-Token': s.token,
          ...(direct && range ? { Range: range } : {}),
        },
      },
      AbortSignal.any([s.signal, signal]),
    )
  }
  async subtitle(
    itemId: string,
    sourceId: string,
    index: number,
    startSeconds: number,
    signal: AbortSignal,
    expectedGeneration: number,
  ): Promise<Buffer> {
    const s = await this.authenticate()
    if (expectedGeneration !== this.revision) throw new Error('媒体服务器连接已变化，请重新播放。')
    const response = await this.request(
      s,
      `Videos/${itemId}/${sourceId}/Subtitles/${index}/Stream.vtt`,
      startSeconds > 0 ? { StartPositionTicks: String(Math.floor(startSeconds * 10000000)) } : {},
      'GET',
      signal,
    )
    const type = response.headers.get('content-type')?.split(';')[0]?.toLowerCase()
    if (type && !['text/vtt', 'text/plain', 'application/octet-stream'].includes(type)) {
      await response.body?.cancel()
      throw new Error('服务器返回的字幕格式无效。')
    }
    const data = await this.bounded(response, 8 * 1024 * 1024)
    if (
      !data
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .startsWith('WEBVTT')
    )
      throw new Error('服务器返回的字幕不是有效的 WebVTT。')
    return data
  }
  async image(request: MediaImageRequest): Promise<string | null> {
    let data: Buffer
    let mime: string
    if (request.kind.startsWith('privacy')) {
      const settings = await this.settings()
      const path =
        request.kind === 'privacyPoster'
          ? settings.privacyCover.posterPath
          : settings.privacyCover.thumbPath
      if (!path) return null
      if (!isAbsolute(path)) throw new Error('隐私封面需要绝对文件路径。')
      mime =
        (
          {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
          } as Record<string, string>
        )[extname(path).toLowerCase()] ?? ''
      if (!mime || (await fileStamp(path)).size > 8 * 1024 * 1024)
        throw new Error('隐私封面必须是 8 MiB 以内的 PNG、JPEG 或 WebP 图片。')
      data = await readFile(path)
    } else {
      const s = await this.authenticate()
      let response: Response
      try {
        response = await this.request(
          s,
          `Items/${request.id}/Images/${request.kind}${request.index === undefined ? '' : `/${request.index}`}`,
          {
            MaxWidth: request.kind === 'Chapter' ? '320' : '640',
            Quality: '85',
          },
        )
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('媒体项目')) return null
        throw error
      }
      mime = response.headers.get('content-type')?.split(';')[0] ?? ''
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
        await response.body?.cancel()
        return null
      }
      data = await this.bounded(response, 8 * 1024 * 1024)
    }
    if (data.length > 8 * 1024 * 1024) throw new Error('封面图片过大。')
    return `data:${mime};base64,${data.toString('base64')}`
  }
}
