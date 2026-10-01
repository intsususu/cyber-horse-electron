import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MediaPopularService,
  popularUpdateInterval,
  rankPopular,
} from '../src/main/services/media-popular'
import { EmbyClient } from '../src/main/services/emby-client'
import { defaultSettings } from '../src/shared/contracts'
import { popularPageSchema, type PopularScan } from '../src/shared/media-popular'

const identity = 'a'.repeat(64)
const scan: PopularScan = {
  videos: [
    {
      id: 'v1',
      plays: 12,
      favorite: true,
      people: [
        { id: 'p1', name: '演员甲' },
        { id: 'p1', name: '重复署名' },
      ],
    },
    {
      id: 'v2',
      plays: 3,
      favorite: false,
      people: [
        { id: 'p1', name: '演员甲' },
        { id: 'p2', name: '演员乙' },
      ],
    },
    { id: 'v3', plays: 0, favorite: false, people: [] },
  ],
  series: [
    { id: 'c1', name: '系列甲', videoIds: ['v1', 'v2', 'v1', 'gone'] },
    { id: 'c2', name: '系列乙', videoIds: ['v3'] },
  ],
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'horse-popular-'))
  let time = Date.parse('2026-09-30T01:00:00Z')
  const client = {
    generation: 1,
    popularIdentity: vi.fn(async () => identity),
    scanPopular: vi.fn(async (_signal: AbortSignal) => structuredClone(scan)),
    videosByIds: vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => id !== 'v2')
        .map((id) => ({
          id,
          name: '实时片名',
          overview: '',
          year: null,
          minutes: null,
          favorite: false,
          favoriteDate: null,
          playCount: 10,
          created: '2026-01-01T00:00:00Z',
          lastPlayed: '',
        })),
    ),
  }
  const service = new MediaPopularService(root, client, () => time)
  return {
    root,
    client,
    service,
    advance: (duration: number) => {
      time += duration
    },
  }
}
describe('热门推荐真实索引', () => {
  it('在全组影片上组合排序、收藏与名称搜索，再分页；刷新失效内存缓存', async () => {
    const f = await fixture()
    const videos = Array.from({ length: 65 }, (_, i) => ({
      id: `v${i + 1}`,
      plays: 65 - i,
      favorite: i % 2 === 0,
      people: [],
    }))
    f.client.scanPopular.mockResolvedValue({
      videos,
      series: [{ id: 'c1', name: '系列', videoIds: videos.map((v) => v.id) }],
    })
    const items = videos.map((v, i) => ({
      id: v.id,
      name: i === 64 ? '最后一部 ABC-065' : `影片 ${i + 1}`,
      overview: '',
      year: null,
      minutes: null,
      favorite: v.favorite,
      favoriteDate: null,
      playCount: v.plays,
      created: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      lastPlayed: new Date(Date.UTC(2026, 3, i + 1)).toISOString(),
    }))
    f.client.videosByIds.mockResolvedValue(items)
    await f.service.refresh()
    await f.service.wait()
    const query = {
      kind: 'series' as const,
      id: 'c1',
      updatedAt: (await f.service.state()).index!.updatedAt,
      start: 0,
    }
    const first = await f.service.page({ ...query, sort: 'DateCreated' })
    expect(first.items).toHaveLength(30)
    expect(first.items[0]!.id).toBe('v65')
    const second = await f.service.page({ ...query, sort: 'DateCreated', start: 30 })
    expect(second.items[0]!.id).toBe('v35')
    expect(second.total).toBe(65)
    const matches = await f.service.page({
      ...query,
      sort: 'DatePlayed',
      favorites: true,
      searchTerm: 'abc-065',
    })
    expect(matches.items.map((v) => v.id)).toEqual(['v65'])
    expect(matches.total).toBe(1)
    expect((await f.service.page({ ...query, searchTerm: '不存在' })).total).toBe(0)
    expect((await f.service.page({ ...query, sort: 'PlayCount' })).items[0]!.id).toBe('v1')
    expect(f.client.videosByIds).toHaveBeenCalledTimes(1)
    await f.service.page({ ...query, reload: true })
    expect(f.client.videosByIds).toHaveBeenCalledTimes(2)
  })
  it('按唯一影片累计播放与收藏，重复演员署名不重复计数，零播放仍产生有限排名', () => {
    const result = rankPopular(scan, identity)
    expect(result.groups.series[0]).toMatchObject({
      videos: 2,
      plays: 15,
      favorites: 1,
      videoIds: ['v1', 'v2'],
    })
    expect(result.groups.actors[0]).toMatchObject({ id: 'p1', videos: 2, plays: 15 })
    expect(result.totals).toMatchObject({ videos: 3, missingPeople: 1, plays: 15, favorites: 1 })
    expect(
      rankPopular(
        {
          videos: scan.videos.map((v) => ({ ...v, plays: 0, favorite: false })),
          series: scan.series,
        },
        identity,
      ).groups.actors.every((g) => Number.isFinite(g.score)),
    ).toBe(true)
    expect(rankPopular({ videos: [], series: [] }, identity).groups).toEqual({
      series: [],
      actors: [],
    })
  })
  it('只保存榜单和影片标识，重启读取成功索引，关联清单按标识实时取信息', async () => {
    const f = await fixture()
    await f.service.refresh()
    await f.service.wait()
    const state = await f.service.state()
    const raw = await readFile(join(f.root, 'media-popular', `${identity}.json`), 'utf8')
    expect(raw).not.toContain('overview')
    expect(raw).not.toContain('sources')
    expect(raw).not.toContain('实时片名')
    const resumed = new MediaPopularService(f.root, f.client)
    expect((await resumed.state()).index).toEqual(state.index)
    const page = await resumed.page({
      kind: 'series',
      id: 'c1',
      updatedAt: state.index!.updatedAt,
      start: 0,
    })
    expect(page).toMatchObject({
      items: [{ id: 'v1', name: '实时片名' }],
      missing: 1,
      next: 1,
      total: 1,
    })
    expect(f.client.videosByIds).toHaveBeenCalledWith(['v1', 'v2'])
    await expect(
      resumed.page({ kind: 'series', id: 'c1', updatedAt: '2020-01-01T00:00:00.000Z', start: 0 }),
    ).rejects.toThrow('榜单已更新')
    expect(popularPageSchema.safeParse({ kind: 'series', id: '../x', start: 0 }).success).toBe(
      false,
    )
  })
  it('更新失败和取消均保留上次成功索引，重复启动互斥', async () => {
    const f = await fixture()
    await f.service.refresh()
    await f.service.wait()
    const previous = (await f.service.state()).index
    f.client.scanPopular.mockRejectedValueOnce(new Error('服务器离线'))
    await f.service.refresh()
    await f.service.wait()
    expect((await f.service.state()).index).toEqual(previous)
    f.client.scanPopular.mockImplementationOnce(
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true }),
        ),
    )
    await f.service.refresh()
    await f.service.refresh()
    expect(f.client.scanPopular).toHaveBeenCalledTimes(3)
    f.service.cancel()
    await f.service.wait()
    expect((await f.service.state()).index).toEqual(previous)
    expect((await f.service.state()).error).toContain('取消')
    expect(
      (await readdir(join(f.root, 'media-popular'))).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
  })
  it('切换账号取消旧扫描，旧结果不能进入新账号或覆盖旧索引', async () => {
    const f = await fixture()
    let finish!: (scan: PopularScan) => void
    f.client.scanPopular.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await f.service.refresh()
    f.client.generation++
    f.client.popularIdentity.mockResolvedValue('b'.repeat(64))
    expect((await f.service.state()).index).toBeNull()
    finish(scan)
    await f.service.wait()
    expect((await f.service.state()).index).toBeNull()
    await expect(readFile(join(f.root, 'media-popular', `${identity}.json`))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })
  it('损坏的索引保留原文，禁止静默重建覆盖', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'media-popular'))
    const path = join(f.root, 'media-popular', `${identity}.json`)
    await writeFile(path, '{损坏的数据')
    expect((await f.service.state()).error).toContain('原文件已保留')
    await expect(f.service.refresh()).rejects.toThrow('原文件已保留')
    expect(await readFile(path, 'utf8')).toBe('{损坏的数据')
  })
  it('初始化前不自动扫描，成功初始化后六小时到期更新，失败延后重试', async () => {
    const f = await fixture()
    await f.service.tick()
    expect(f.client.scanPopular).not.toHaveBeenCalled()
    await f.service.refresh()
    await f.service.wait()
    f.advance(popularUpdateInterval - 1)
    await f.service.tick()
    expect(f.client.scanPopular).toHaveBeenCalledTimes(1)
    f.advance(1)
    f.client.scanPopular.mockRejectedValueOnce(new Error('离线'))
    await f.service.tick()
    await f.service.wait()
    await f.service.tick()
    expect(f.client.scanPopular).toHaveBeenCalledTimes(2)
    f.advance(popularUpdateInterval)
    await f.service.tick()
    await f.service.wait()
    expect(f.client.scanPopular).toHaveBeenCalledTimes(3)
    f.service.stop()
  })
  it('Emby 扫描明确请求累计播放字段，归组只发读取请求，缺少字段拒绝生成零值榜单', async () => {
    const settings = structuredClone(defaultSettings)
    settings.mediaServer.serverUrl = 'http://emby.invalid'
    settings.mediaServer.username = '测试'
    let omit = false
    const fetcher = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input)
      if (url.pathname.endsWith('AuthenticateByName'))
        return Response.json({ AccessToken: 'fixture', ServerId: 'test', User: { Id: 'u1' } })
      expect(init.method).toBe('GET')
      if (url.searchParams.get('IncludeItemTypes') === 'BoxSet')
        return Response.json({ Items: [{ Id: 'c1', Name: '系列' }], TotalRecordCount: 1 })
      if (url.searchParams.get('ParentId'))
        return Response.json({ Items: [{ Id: 'v1' }], TotalRecordCount: 1 })
      expect(url.searchParams.get('Fields')).toContain('UserDataPlayCount')
      return Response.json({
        Items: [
          {
            Id: 'v1',
            Name: '视频',
            UserData: { ...(omit ? {} : { PlayCount: 7 }), IsFavorite: true },
            People: [{ Id: 'p1', Name: '演员', Type: 'Actor' }],
          },
        ],
        TotalRecordCount: 1,
      })
    })
    vi.stubGlobal('fetch', fetcher)
    const client = new EmbyClient(
      async () => settings,
      async () => 'fixture',
    )
    expect(
      (await client.scanPopular(new AbortController().signal, () => {})).videos[0],
    ).toMatchObject({ plays: 7, favorite: true })
    omit = true
    await expect(client.scanPopular(new AbortController().signal, () => {})).rejects.toThrow(
      '未返回当前账号',
    )
  })
})
