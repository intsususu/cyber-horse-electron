import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Settings } from '../../shared/contracts'
import type {
  LibraryPage,
  LibraryVideo,
  MediaDetail,
  MediaImageRequest,
  MediaChapter,
  MediaQuery,
  MediaLinkTarget,
  MediaPublicationRequest,
  MediaPublicationCheck,
  MediaSubtitleFormat,
} from '../../shared/media-library'
import { mediaIdSchema } from '../../shared/media-library'
import { embyDetailUrl, javbusDetailUrl, mediaCatalogNumber } from '../../shared/media-links'
import { fileStamp } from './safe-files'
import type { PopularScan, PopularLibraryVideo } from '../../shared/media-popular'
import {
  mediaUserDataSchema,
  mediaUserDataSnapshotSchema,
  mergeMediaUserData,
  containsMediaUserData,
  type MediaUserDataSnapshot,
} from '../../shared/media-user-data'

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
  UserData: z
    .object({
      IsFavorite: z.boolean().optional(),
      FavoriteDate: text,
      PlayCount: number,
      LastPlayedDate: text,
    })
    .nullish(),
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
class EmbyRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
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
        if (response.status === 404) throw new EmbyRequestError('媒体项目不存在或已被移除。', 404)
        throw new Error(`Emby 请求失败（状态码 ${response.status}）。`)
      }
      return response
    } catch (error) {
      if (error instanceof Error && /^(Emby|当前 Emby|媒体项目)/.test(error.message)) throw error
      throw new Error(
        signal.aborted
          ? '请求已取消或超时，请重试。'
          : '无法连接 Emby，请检查服务器地址、网络和证书；不允许跨地址重定向。',
        { cause: error },
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
    timeoutMs: number | null = 20000,
    body?: unknown,
  ) {
    const url = new URL(path, session.url)
    url.search = new URLSearchParams(query).toString()
    return this.response(
      url.href,
      {
        method,
        headers: {
          Authorization: authHeader,
          'X-Emby-Token': session.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      AbortSignal.any([
        session.signal,
        ...(timeoutMs === null ? [] : [AbortSignal.timeout(timeoutMs)]),
        ...(signal ? [signal] : []),
      ]),
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
  async popularIdentity() {
    const session = await this.authenticate()
    session.signal.throwIfAborted()
    return createHash('sha256')
      .update(JSON.stringify([session.url, session.serverId, session.userId]))
      .digest('hex')
  }
  async scanPopular(
    signal: AbortSignal,
    progress: (message: string) => void,
  ): Promise<PopularScan> {
    const session = await this.authenticate()
    const scanItem = z.object({
      Id: id,
      Name: text,
      UserData: z
        .object({
          PlayCount: z.number().int().nonnegative().optional(),
          IsFavorite: z.boolean().optional(),
        })
        .nullish(),
      People: z.array(named.extend({ Type: text })).nullish(),
    })
    const schema = z.object({
      Items: z.array(scanItem),
      TotalRecordCount: z.number().int().nonnegative().optional(),
    })
    const all = async (params: Record<string, string>, label: string) => {
      const result = new Map<string, z.infer<typeof scanItem>>()
      let start = 0
      let expected: number | undefined
      while (true) {
        signal.throwIfAborted()
        const response = await this.request(
          session,
          `Users/${session.userId}/Items`,
          {
            Recursive: 'true',
            GroupItemsIntoCollections: 'false',
            EnableUserData: 'true',
            Fields: 'People,UserDataPlayCount,UserDataLastPlayedDate',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            ...params,
            StartIndex: String(start),
            Limit: '500',
          },
          'GET',
          signal,
        )
        const parsed = schema.safeParse(await this.json(response))
        if (!parsed.success)
          throw new Error('热门扫描响应无效或未返回累计播放字段，请检查 Emby 版本。')
        const page = parsed.data
        if (
          expected !== undefined &&
          page.TotalRecordCount !== undefined &&
          expected !== page.TotalRecordCount
        )
          throw new Error('扫描期间媒体数量发生变化，请稍后重新更新。')
        expected = page.TotalRecordCount
        const before = result.size
        for (const item of page.Items) result.set(item.Id, item)
        start += page.Items.length
        progress(`${label}：已读取 ${result.size} 项`)
        if (start > 200000) throw new Error('媒体数量超过单次扫描上限。')
        if (page.Items.length && result.size === before)
          throw new Error('Emby 分页重复，已停止扫描以保留原榜单。')
        if (expected !== undefined && start >= expected) break
        if (page.Items.length === 0) {
          if (expected !== undefined && start < expected)
            throw new Error('Emby 分页不完整，请重试。')
          break
        }
        if (expected === undefined && page.Items.length < 500) break
      }
      if (expected !== undefined && result.size !== expected)
        throw new Error('Emby 分页存在重复或遗漏，请重试。')
      return [...result.values()]
    }
    const items = await all({ IncludeItemTypes: 'Movie,Video' }, '正在读取影片')
    if (
      items.some(
        (item) => item.UserData?.PlayCount === undefined || item.UserData.IsFavorite === undefined,
      )
    )
      throw new Error('Emby 未返回当前账号的播放与收藏数据，未替换原榜单。')
    const videos = items.map((item) => ({
      id: item.Id,
      plays: item.UserData!.PlayCount!,
      favorite: item.UserData!.IsFavorite!,
      people: (item.People ?? [])
        .filter((person) => person.Type.toLowerCase() === 'actor' && person.Id && person.Name)
        .map((person) => ({ id: person.Id!, name: person.Name })),
    }))
    const available = new Set(videos.map((item) => item.id))
    const collections = await all(
      { IncludeItemTypes: 'BoxSet', Fields: '', EnableUserData: 'false' },
      '正在读取系列',
    )
    const series: PopularScan['series'] = []
    for (const [index, collection] of collections.entries()) {
      const members = await all(
        {
          IncludeItemTypes: 'Movie,Video',
          ParentId: collection.Id,
          Fields: '',
          EnableUserData: 'false',
        },
        `正在归组系列 ${index + 1}/${collections.length}`,
      )
      const videoIds = members.map((item) => item.Id).filter((itemId) => available.has(itemId))
      if (videoIds.length)
        series.push({ id: collection.Id, name: collection.Name || '未命名系列', videoIds })
    }
    session.signal.throwIfAborted()
    signal.throwIfAborted()
    return { videos, series }
  }
  async videosByIds(ids: string[]): Promise<PopularLibraryVideo[]> {
    if (!ids.length) return []
    const session = await this.authenticate()
    const items = new Map<string, PopularLibraryVideo>()
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100)
      const data = this.parsePage(
        await this.json(
          await this.request(session, `Users/${session.userId}/Items`, {
            Ids: batch.join(','),
            IncludeItemTypes: 'Movie,Video',
            Recursive: 'true',
            GroupItemsIntoCollections: 'false',
            Fields:
              'ProductionYear,RunTimeTicks,DateCreated,UserDataPlayCount,UserDataLastPlayedDate',
            EnableUserData: 'true',
            Limit: String(batch.length),
          }),
        ),
      )
      session.signal.throwIfAborted()
      for (const item of data.Items)
        items.set(item.Id, {
          ...video(item),
          playCount: item.UserData?.PlayCount ?? null,
          created: item.DateCreated,
          lastPlayed: item.UserData?.LastPlayedDate ?? '',
        })
    }
    return ids.flatMap((itemId) => (items.has(itemId) ? [items.get(itemId)!] : []))
  }
  async page(query: MediaQuery): Promise<LibraryPage> {
    const s = await this.authenticate()
    const params: Record<string, string> = {
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Video,Episode',
      Fields: fields,
      EnableUserData: 'true',
      SortBy: query.sort,
      SortOrder: 'Descending',
      StartIndex: String(query.start),
      Limit: String(query.limit),
    }
    if (query.libraryId) params.ParentId = query.libraryId
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
  async detail(itemId: string, signal?: AbortSignal): Promise<MediaDetail> {
    const s = await this.authenticate()
    signal?.throwIfAborted()
    const parsed = itemSchema.safeParse(
      await this.json(
        await this.request(
          s,
          `Users/${s.userId}/Items/${itemId}`,
          {
            Fields: fields,
            EnableUserData: 'true',
          },
          'GET',
          signal,
        ),
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
  async refresh(itemId: string, expectedGeneration?: number, signal?: AbortSignal) {
    signal?.throwIfAborted()
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
      signal,
    )
    await response.body?.cancel()
    this.titleSearchCache = undefined
  }

  /** 刷新提交不代表已入库；按服务器路径重新发现，允许改名后的新项目 ID。 */
  async serverIdentity() {
    const session = await this.authenticate()
    return createHash('sha256').update(session.serverId).digest('hex')
  }

  async confirmPublished(request: MediaPublicationRequest, signal: AbortSignal): Promise<boolean> {
    return (await this.inspectPublished(request, signal)).state === 'confirmed'
  }

  private userDataIdentity(session: Session) {
    if (!session.serverId) throw new Error('Emby 未返回服务器身份，无法安全保存或迁移观看记录。')
    return createHash('sha256')
      .update(JSON.stringify([session.url, session.serverId, session.userId]))
      .digest('hex')
  }

  private async readUserData(session: Session, itemId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const result = z.object({ Id: id, UserData: mediaUserDataSchema }).safeParse(
      await this.json(
        await this.request(
          session,
          `Users/${session.userId}/Items/${itemId}`,
          {
            EnableUserData: 'true',
            Fields: 'UserDataPlayCount,UserDataLastPlayedDate,UserDataPlaybackPositionTicks',
          },
          'GET',
          signal,
        ),
      ),
    )
    if (!result.success || result.data.Id !== itemId)
      throw new Error('Emby 未返回完整的收藏和观看记录，已停止迁移；不会将缺失数据当作零。')
    session.signal.throwIfAborted()
    signal.throwIfAborted()
    return result.data.UserData
  }

  async captureUserData(itemId: string, signal: AbortSignal): Promise<MediaUserDataSnapshot> {
    mediaIdSchema.parse(itemId)
    signal.throwIfAborted()
    const session = await this.authenticate()
    const identity = this.userDataIdentity(session)
    const data = await this.readUserData(session, itemId, signal)
    return { identity, itemId, capturedAt: new Date().toISOString(), data }
  }

  private async restoreUserData(
    itemId: string,
    snapshot: MediaUserDataSnapshot,
    signal: AbortSignal,
  ) {
    const session = await this.authenticate()
    if (this.userDataIdentity(session) !== snapshot.identity)
      throw new Error('Emby 服务器或账号身份已变化，未迁移收藏和观看记录。')
    // 原 ID 保留时用户记录仍属于原条目，不用旧快照覆盖用户的新操作。
    if (itemId === snapshot.itemId) return
    const current = await this.readUserData(session, itemId, signal)
    const expected = mergeMediaUserData(snapshot.data, current)
    if (containsMediaUserData(current, expected)) return
    let actual = current
    if (!containsMediaUserData(current, { ...expected, IsFavorite: current.IsFavorite })) {
      const response = await this.request(
        session,
        `Users/${session.userId}/Items/${itemId}/UserData`,
        {},
        'POST',
        signal,
        20000,
        { ...expected, ItemId: itemId },
      )
      await response.body?.cancel()
      this.titleSearchCache = undefined
      actual = await this.readUserData(session, itemId, signal)
    }
    // 部分 Emby 版本的 UserData 写回忽略收藏，须使用专用接口并再次读取核对。
    if (expected.IsFavorite && !actual.IsFavorite) {
      const response = await this.request(
        session,
        `Users/${session.userId}/FavoriteItems/${itemId}`,
        {},
        'POST',
        signal,
      )
      await response.body?.cancel()
      this.titleSearchCache = undefined
      actual = await this.readUserData(session, itemId, signal)
    }
    if (!containsMediaUserData(actual, expected))
      throw new Error('Emby 收藏和观看记录写回后未通过核对；任务已保留，可仅重试同步。')
  }

  /** 按完整服务器路径精确查找，改名后的 ID 不依赖旧 ID；不扫描或下载媒体内容。 */
  async inspectPublished(
    request: MediaPublicationRequest,
    signal: AbortSignal,
  ): Promise<MediaPublicationCheck> {
    signal.throwIfAborted()
    const session = await this.authenticate()
    const normalize = (path: string) => {
      const slashes = path.replace(/\\/g, '/').replace(/\/+$/, '')
      return /^[A-Za-z]:\//.test(slashes) ? slashes.toLowerCase() : slashes
    }
    const data = this.parsePage(
      await this.json(
        await this.request(
          session,
          'Items',
          {
            UserId: session.userId,
            Path: request.path,
            Recursive: 'true',
            IncludeItemTypes: 'Movie,Video,Episode',
            Fields: 'Path,MediaSources',
            Limit: '2',
          },
          'GET',
          signal,
        ),
      ),
    )
    if (data.Items.length > 1 || (data.TotalRecordCount ?? 0) > 1)
      return {
        state: 'ambiguous',
        itemId: null,
        message: 'Emby 按发布路径返回多个项目，未自动认领。',
      }
    const candidate = data.Items[0]
    if (
      !candidate ||
      !(
        normalize(candidate.Path) === normalize(request.path) ||
        candidate.MediaSources?.some((source) => normalize(source.Path) === normalize(request.path))
      )
    )
      return { state: 'not-found', itemId: null, message: 'Emby 尚未返回新文件路径对应的项目。' }
    const item = itemSchema.parse(
      await this.json(
        await this.request(
          session,
          `Users/${session.userId}/Items/${candidate.Id}`,
          { Fields: 'Path,MediaSources,MediaStreams' },
          'GET',
          signal,
        ),
      ),
    )
    const sources = (item.MediaSources ?? []).filter(
      (source) => normalize(source.Path) === normalize(request.path),
    )
    const source = sources.find((value) => value.Size === request.size)
    if (!source)
      return {
        state: 'size-mismatch',
        itemId: candidate.Id,
        message: 'Emby 已找到项目，但视频路径或大小尚未与发布结果一致。',
      }
    if (
      request.chinese &&
      !source.MediaStreams?.some(
        (stream) =>
          stream.Type.toLowerCase() === 'subtitle' && /^(chi|zho|zh)(?:$|-)/i.test(stream.Language),
      )
    )
      return {
        state: 'subtitle-missing',
        itemId: candidate.Id,
        message: 'Emby 已找到新视频，但尚未确认所需中文字幕轨。',
      }
    signal.throwIfAborted()
    session.signal.throwIfAborted()
    return {
      state: 'confirmed',
      itemId: candidate.Id,
      message: 'Emby 已核对发布视频的路径、大小及所需字幕。',
    }
  }

  /** 先确认媒体，再迁移已保存的用户记录；无快照的历史调用仍只确认媒体。 */
  async synchronizePublished(
    request: MediaPublicationRequest,
    signal: AbortSignal,
    userData?: MediaUserDataSnapshot,
  ): Promise<boolean> {
    const timeout = AbortSignal.timeout(180000)
    const verification = AbortSignal.any([signal, timeout])
    let lastIssue = ''
    try {
      verification.throwIfAborted()
      if (userData) {
        userData = mediaUserDataSnapshotSchema.parse(userData)
        if (userData.itemId !== request.itemId)
          throw new Error('收藏和观看记录不属于本次原条目，未迁移。')
        const session = await this.authenticate()
        if (this.userDataIdentity(session) !== userData.identity)
          throw new Error('Emby 服务器或账号身份已变化，未迁移收藏和观看记录。')
      }
      const complete = async (itemId: string | null) => {
        if (!itemId) throw new Error('Emby 未返回已确认的项目标识。')
        lastIssue = ''
        if (userData) await this.restoreUserData(itemId, userData, verification)
        return true
      }
      let result = await this.inspectPublished(request, verification)
      if (result.state === 'confirmed') return await complete(result.itemId)
      if (result.state === 'ambiguous') throw new Error(result.message)
      lastIssue = result.message
      const generation = this.generation
      try {
        await this.refresh(result.itemId ?? request.itemId, generation, verification)
      } catch (error) {
        // 旧 ID 因文件改名消失是预期情况；其他刷新错误必须保留具体原因。
        if (!(error instanceof EmbyRequestError && error.status === 404 && !result.itemId))
          throw error
      }
      // 入库速度由服务器决定；持续核对至整体期限，不在约六秒时提前结束。
      while (true) {
        await delay(3000, undefined, { signal: verification })
        result = await this.inspectPublished(request, verification)
        if (result.state === 'confirmed') return await complete(result.itemId)
        if (result.state === 'ambiguous') throw new Error(result.message)
        lastIssue = result.message
      }
    } catch (error) {
      if (signal.aborted) throw new Error('收尾确认已取消；媒体已回写，任务记录已保留。')
      if (timeout.aborted) throw new Error(`Emby 更新确认超过 3 分钟，可重试收尾。${lastIssue}`)
      if (error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)) throw error
      throw new Error('Emby 更新确认请求中断，可重试收尾。')
    }
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
    // 下载持续时间由下载服务的无数据超时管理，不能沿用普通接口的总时限。
    return this.request(
      s,
      `Videos/${itemId}/stream`,
      { Static: 'true', MediaSourceId: sourceId },
      'GET',
      signal,
      null,
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
    format: MediaSubtitleFormat = 'vtt',
  ): Promise<Buffer> {
    if (!['vtt', 'ass', 'ssa'].includes(format)) throw new Error('字幕格式不受支持。')
    const s = await this.authenticate()
    if (expectedGeneration !== this.revision) throw new Error('媒体服务器连接已变化，请重新播放。')
    const response = await this.request(
      s,
      `Videos/${itemId}/${sourceId}/Subtitles/${index}/Stream.${format}`,
      startSeconds > 0 ? { StartPositionTicks: String(Math.floor(startSeconds * 10000000)) } : {},
      'GET',
      signal,
    )
    const type = response.headers.get('content-type')?.split(';')[0]?.toLowerCase()
    const types = ['text/plain', 'application/octet-stream']
    if (format === 'vtt') types.push('text/vtt')
    else types.push('text/x-ass', 'text/x-ssa', 'application/x-ass', 'application/x-ssa')
    if (type && !types.includes(type)) {
      await response.body?.cancel()
      throw new Error('服务器返回的字幕格式无效。')
    }
    const data = await this.bounded(response, 8 * 1024 * 1024)
    const content = data.toString('utf8').replace(/^\uFEFF/, '')
    if (format === 'vtt') {
      if (!content.startsWith('WEBVTT')) throw new Error('服务器返回的字幕不是有效的 WebVTT。')
    } else if (
      !/^\s*\[Script Info\]/i.test(content) ||
      !/^\[V4\+? Styles\]\s*$/im.test(content) ||
      !/^\[Events\]\s*$/im.test(content)
    )
      throw new Error('服务器返回的字幕缺少 ASS／SSA 样式或事件，无法保留原字幕外观。')
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
