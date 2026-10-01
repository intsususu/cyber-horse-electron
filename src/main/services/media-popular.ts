import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  popularIndexSchema,
  type PopularGroup,
  type PopularIndex,
  type PopularPageQuery,
  type PopularScan,
  type PopularState,
  type PopularVideoPage,
  type PopularLibraryVideo,
} from '../../shared/media-popular'
import type { EmbyClient } from './emby-client'

export const popularUpdateInterval = 6 * 60 * 60 * 1000

export function rankPopular(scan: PopularScan, identity: string, now = new Date()): PopularIndex {
  const videos = new Map(scan.videos.map((item) => [item.id, item]))
  const actors = new Map<string, { id: string; name: string; videoIds: string[] }>()
  for (const item of videos.values()) {
    for (const person of new Map(item.people.map((person) => [person.id, person])).values()) {
      const group = actors.get(person.id) ?? { ...person, videoIds: [] }
      group.videoIds.push(item.id)
      actors.set(person.id, group)
    }
  }
  const rank = (groups: PopularScan['series']) => {
    const rows = groups
      .map((group) => {
        const members = [...new Set(group.videoIds)]
          .flatMap((id) => (videos.has(id) ? [videos.get(id)!] : []))
          .sort(
            (a, b) =>
              b.plays - a.plays ||
              Number(b.favorite) - Number(a.favorite) ||
              a.id.localeCompare(b.id),
          )
        return {
          id: group.id,
          name: group.name,
          videoIds: members.map((item) => item.id),
          videos: members.length,
          plays: members.reduce((sum, item) => sum + item.plays, 0),
          favorites: members.filter((item) => item.favorite).length,
          score: 0,
        }
      })
      .filter((group) => group.videos > 0)
    const maximum = rows.reduce(
      (max, row) => ({
        plays: Math.max(max.plays, row.plays),
        favorites: Math.max(max.favorites, row.favorites),
        videos: Math.max(max.videos, row.videos),
      }),
      { plays: 0, favorites: 0, videos: 0 },
    )
    const normalized = (value: number, max: number) =>
      max ? Math.log1p(value) / Math.log1p(max) : 0
    for (const row of rows)
      row.score =
        100 *
        (0.6 * normalized(row.plays, maximum.plays) +
          0.25 * normalized(row.favorites, maximum.favorites) +
          0.15 * normalized(row.videos, maximum.videos))
    rows.sort(
      (a, b) =>
        b.score - a.score ||
        b.plays - a.plays ||
        b.favorites - a.favorites ||
        b.videos - a.videos ||
        a.id.localeCompare(b.id),
    )
    return { count: rows.length, top: rows.slice(0, 15) satisfies PopularGroup[] }
  }
  const series = rank(scan.series)
  const people = rank([...actors.values()])
  return popularIndexSchema.parse({
    version: 1,
    identity,
    updatedAt: now.toISOString(),
    totals: {
      videos: videos.size,
      plays: [...videos.values()].reduce((sum, item) => sum + item.plays, 0),
      favorites: [...videos.values()].filter((item) => item.favorite).length,
      missingPeople: [...videos.values()].filter((item) => !item.people.length).length,
      series: series.count,
      actors: people.count,
    },
    groups: { series: series.top, actors: people.top },
  })
}

type Client = Pick<EmbyClient, 'popularIdentity' | 'scanPopular' | 'videosByIds' | 'generation'>
export class MediaPopularService {
  private identity = ''
  private generation = -1
  private epoch = 0
  private index: PopularIndex | null = null
  private error = ''
  private progress = ''
  private blocked = false
  private controller?: AbortController
  private operation?: Promise<void>
  private loading?: { identity: string; promise: Promise<void> }
  private timer?: ReturnType<typeof setInterval>
  private retryAfter = 0
  private videoCache?: { key: string; expires: number; items: PopularLibraryVideo[] }
  private videoLoad?: { key: string; promise: Promise<PopularLibraryVideo[]> }
  constructor(
    private directory: string,
    private client: Client,
    private now = () => Date.now(),
  ) {}

  private path(identity: string) {
    return join(this.directory, 'media-popular', `${identity}.json`)
  }
  private snapshot(): PopularState {
    return {
      index: this.index,
      scanning: !!this.operation,
      progress: this.progress,
      error: this.error,
      nextUpdate:
        this.index && !this.blocked
          ? new Date(
              Math.max(Date.parse(this.index.updatedAt) + popularUpdateInterval, this.retryAfter),
            ).toISOString()
          : null,
    }
  }
  invalidate() {
    this.epoch++
    this.controller?.abort()
    this.identity = ''
    this.index = null
    this.error = ''
    this.progress = ''
    this.blocked = false
    this.retryAfter = 0
    this.loading = undefined
    this.videoCache = undefined
    this.videoLoad = undefined
    // 等待旧扫描真正结束后，才能开始下一次扫描。
  }
  private async context() {
    const identity = await this.client.popularIdentity()
    const generation = this.client.generation
    if (this.identity === identity && this.generation === generation) {
      if (this.loading?.identity === identity) await this.loading.promise
      return
    }
    this.invalidate()
    this.identity = identity
    this.generation = generation
    const epoch = this.epoch
    const promise = (async () => {
      try {
        const raw = await readFile(this.path(identity), 'utf8')
        const index = popularIndexSchema.parse(JSON.parse(raw))
        if (index.identity !== identity) throw new Error('账号不匹配')
        if (this.epoch === epoch) this.index = index
      } catch (error) {
        if (this.epoch !== epoch) return
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.blocked = true
          this.error =
            '本地热门索引无法读取，原文件已保留。请先修复或移走损坏文件，再重新进入应用。'
        }
      }
    })()
    this.loading = { identity, promise }
    await promise
    if (this.loading?.promise === promise) this.loading = undefined
  }
  async state() {
    await this.context()
    return this.snapshot()
  }
  async refresh(): Promise<PopularState> {
    await this.context()
    if (this.blocked) throw new Error(this.error)
    if (this.operation) return this.snapshot()
    const identity = this.identity
    const generation = this.generation
    const epoch = this.epoch
    const controller = new AbortController()
    this.controller = controller
    this.error = ''
    this.progress = '正在准备扫描'
    const current = () => epoch === this.epoch && generation === this.client.generation
    const operation = (async () => {
      let temporary: string | undefined
      try {
        const scan = await this.client.scanPopular(controller.signal, (progress) => {
          if (current()) this.progress = progress
        })
        controller.signal.throwIfAborted()
        if (!current()) return
        const index = rankPopular(scan, identity, new Date(this.now()))
        const target = this.path(identity)
        await mkdir(join(this.directory, 'media-popular'), { recursive: true })
        temporary = `${target}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(index), { encoding: 'utf8', flag: 'wx' })
        controller.signal.throwIfAborted()
        if (!current()) return
        await rename(temporary, target)
        if (current()) {
          this.index = index
          this.progress = ''
          this.retryAfter = 0
        }
      } catch (error) {
        if (!current()) return
        this.progress = ''
        this.retryAfter = this.now() + popularUpdateInterval
        this.error = controller.signal.aborted
          ? '扫描已取消，保留上次成功的榜单。'
          : error instanceof Error
            ? error.message
            : '热门更新失败，保留上次成功的榜单。'
      } finally {
        if (temporary) await rm(temporary, { force: true }).catch(() => {})
      }
    })()
    this.operation = operation
    void operation.finally(() => {
      if (this.operation === operation) {
        this.operation = undefined
        this.controller = undefined
      }
    })
    return this.snapshot()
  }
  cancel() {
    this.controller?.abort()
  }
  async wait() {
    await this.operation
  }
  async page(query: PopularPageQuery): Promise<PopularVideoPage> {
    await this.context()
    if (!this.index || query.updatedAt !== this.index.updatedAt)
      throw new Error('榜单已更新，请返回首页重新选择。')
    const group = this.index.groups[query.kind].find((group) => group.id === query.id)
    if (!group) throw new Error('此项目已不在当前榜单中，请返回首页。')
    const epoch = this.epoch
    const generation = this.client.generation
    const key = `${this.identity}:${this.index.updatedAt}:${query.kind}:${query.id}`
    if (query.reload && query.start === 0) {
      this.videoCache = undefined
      this.videoLoad = undefined
    }
    let all =
      this.videoCache?.key === key && this.videoCache.expires > this.now()
        ? this.videoCache.items
        : undefined
    if (!all) {
      if (this.videoLoad?.key !== key)
        this.videoLoad = { key, promise: this.client.videosByIds(group.videoIds) }
      const operation = this.videoLoad
      try {
        all = await operation.promise
        if (
          epoch === this.epoch &&
          generation === this.client.generation &&
          this.videoLoad === operation
        )
          this.videoCache = { key, items: all, expires: this.now() + 60000 }
      } finally {
        if (this.videoLoad === operation) this.videoLoad = undefined
      }
    }
    if (epoch !== this.epoch || generation !== this.client.generation)
      throw new Error('媒体账号已变化，请重新加载榜单。')
    const term = (query.searchTerm ?? '').normalize('NFKC').toLocaleLowerCase()
    const items = all.filter(
      (item) =>
        (!query.favorites || item.favorite) &&
        (!term || item.name.normalize('NFKC').toLocaleLowerCase().includes(term)),
    )
    const date = (value: string) => (Number.isFinite(Date.parse(value)) ? Date.parse(value) : -1)
    const value = (item: PopularLibraryVideo) =>
      query.sort === 'DateCreated'
        ? date(item.created)
        : query.sort === 'DatePlayed'
          ? date(item.lastPlayed)
          : (item.playCount ?? -1)
    items.sort((a, b) => value(b) - value(a) || a.id.localeCompare(b.id))
    return {
      items: items.slice(query.start, query.start + 30),
      next: Math.min(query.start + 30, items.length),
      total: items.length,
      missing: Math.max(0, group.videoIds.length - all.length),
    }
  }
  async tick() {
    try {
      const state = await this.state()
      if (
        state.index &&
        !state.scanning &&
        !this.blocked &&
        this.now() >=
          Math.max(Date.parse(state.index.updatedAt) + popularUpdateInterval, this.retryAfter)
      )
        await this.refresh()
    } catch {
      /* 网络或配置不可用时等待下次检查，不覆盖索引。 */
    }
  }
  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 60000)
    this.timer.unref()
    void this.tick()
  }
  stop() {
    clearInterval(this.timer)
    this.timer = undefined
    this.cancel()
  }
}
