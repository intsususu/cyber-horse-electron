import { afterEach, describe, expect, it, vi } from 'vitest'
import * as timers from 'node:timers/promises'
import { EmbyClient } from '../src/main/services/emby-client'
import { defaultSettings } from '../src/shared/contracts'
import { mediaUserDataSchema, type MediaUserData } from '../src/shared/media-user-data'
import { taskContextSchema } from '../src/shared/task-workspace'

vi.mock('node:timers/promises', async (original) => ({ ...(await original<typeof timers>()) }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const empty: MediaUserData = {
  IsFavorite: false,
  PlayCount: 0,
  Played: false,
  PlaybackPositionTicks: 0,
  LastPlayedDate: null,
}
const saved: MediaUserData = {
  IsFavorite: true,
  PlayCount: 7,
  Played: true,
  PlaybackPositionTicks: 123400000,
  LastPlayedDate: '2026-09-20T12:00:00.000Z',
  Rating: 9,
}

function fixture() {
  const settings = structuredClone(defaultSettings)
  settings.mediaServer.serverUrl = 'http://media.invalid/emby'
  settings.mediaServer.username = '测试用户'
  const state = {
    serverId: 'server1',
    userId: 'user1',
    old: { ...saved } as unknown,
    current: { ...empty } as MediaUserData,
    targetId: 'new1',
    matches: 1,
    size: 100,
    chinese: true,
    writeStatus: 204,
    ignoreWrite: false,
    ignoreFavoriteInUserData: false,
    favoriteStatus: 200,
    ignoreFavoriteWrite: false,
    interruptAfterWrite: false,
  }
  const writes: Record<string, unknown>[] = []
  const calls: { path: string; method: string; query: URLSearchParams }[] = []
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    init.signal?.throwIfAborted()
    const url = new URL(input)
    const path = url.pathname
    const method = init.method ?? 'GET'
    calls.push({ path, method, query: url.searchParams })
    if (path.endsWith('/AuthenticateByName'))
      return Response.json({
        AccessToken: '测试令牌',
        ServerId: state.serverId,
        User: { Id: state.userId },
      })
    if (path.endsWith('/UserData') && method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      writes.push(body)
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
      if (state.writeStatus !== 204) return new Response(null, { status: state.writeStatus })
      if (!state.ignoreWrite) {
        const favorite = state.current.IsFavorite
        state.current = mediaUserDataSchema.parse(body)
        if (state.ignoreFavoriteInUserData) state.current.IsFavorite = favorite
      }
      if (state.interruptAfterWrite) throw new TypeError('模拟响应丢失')
      return new Response(null, { status: 204 })
    }
    if (path.endsWith('/FavoriteItems/new1') && method === 'POST') {
      if (state.favoriteStatus !== 200) return new Response(null, { status: state.favoriteStatus })
      if (!state.ignoreFavoriteWrite) state.current.IsFavorite = true
      return Response.json(state.current)
    }
    const item = (itemId: string, data: unknown) => ({
      Id: itemId,
      UserData: data,
      Path: '/media/ABC-123-C.mkv',
      MediaSources: [
        {
          Id: 'source1',
          Path: '/media/ABC-123-C.mkv',
          Size: state.size,
          MediaStreams: state.chinese ? [{ Type: 'Subtitle', Index: 1, Language: 'chi' }] : [],
        },
      ],
    })
    if (path.endsWith('/Items/old1')) return Response.json(item('old1', state.old))
    if (path.endsWith('/Items/new1')) return Response.json(item('new1', state.current))
    if (path.endsWith('/Items') && url.searchParams.has('Path'))
      return Response.json({
        Items: state.matches === 0 ? [] : [item(state.targetId, state.current)],
        TotalRecordCount: state.matches,
      })
    if (path.endsWith('/Refresh')) return new Response(null, { status: 204 })
    throw new Error('未允许的请求：' + method + ' ' + path)
  })
  vi.stubGlobal('fetch', fetcher)
  const client = new EmbyClient(
    async () => settings,
    async () => '测试密码',
  )
  const signal = new AbortController().signal
  const request = { itemId: 'old1', path: '/media/ABC-123-C.mkv', size: 100, chinese: true }
  return { client, state, writes, calls, fetcher, signal, request }
}

describe('Emby 用户记录迁移', () => {
  it('保存完整用户数据并持久化至任务契约；不保存旧 Key 或令牌', async () => {
    const f = fixture()
    f.state.old = { ...saved, Key: '旧键', ItemId: 'old1', ServerId: '旧服务器' }
    const snapshot = await f.client.captureUserData('old1', f.signal)
    const context = taskContextSchema.parse({
      configuration: 'a'.repeat(64),
      sync: {
        server: 'b'.repeat(64),
        itemId: 'old1',
        originalRemotePath: '/media/ABC-123.mp4',
        state: 'pending',
        message: '',
        userData: snapshot,
      },
    })
    expect(taskContextSchema.parse(JSON.parse(JSON.stringify(context))).sync?.userData).toEqual(
      snapshot,
    )
    expect(snapshot.data).toEqual(saved)
    expect(JSON.stringify(snapshot)).not.toMatch(/旧键|测试令牌|测试密码/)
    expect(f.calls.at(-1)?.query.get('Fields')).toContain('UserDataPlayCount')
    expect(f.calls.at(-1)?.query.get('Fields')).toContain('UserDataPlaybackPositionTicks')
  })

  it.each(['PlayCount', 'IsFavorite', 'Played', 'PlaybackPositionTicks'])(
    '缺失 %s 时停止，不用零补齐',
    async (field) => {
      const f = fixture()
      const incomplete = { ...saved } as Record<string, unknown>
      delete incomplete[field]
      f.state.old = incomplete
      await expect(f.client.captureUserData('old1', f.signal)).rejects.toThrow('完整')
      expect(f.writes).toEqual([])
    },
  )

  it('路径大小和字幕确认后迁移，写后重读；重复同步不会重复写入或累加次数', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).resolves.toBe(true)
    expect(f.writes).toEqual([{ ...saved, ItemId: 'new1' }])
    expect(f.calls.at(-1)?.method).toBe('GET')
    expect(f.state.current).toEqual(saved)
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.writes).toHaveLength(1)
    expect(f.calls.every((call) => !/stream|Download|Playback/.test(call.path))).toBe(true)
    expect(f.calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  it('UserData 忽略收藏时通过专用接口补回，重试不重复写入', async () => {
    const f = fixture()
    f.state.ignoreFavoriteInUserData = true
    const snapshot = await f.client.captureUserData('old1', f.signal)
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.state.current).toEqual(saved)
    expect(f.calls.filter((call) => call.path.includes('/FavoriteItems/'))).toHaveLength(1)
    expect(f.calls.at(-1)?.method).toBe('GET')
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.writes).toHaveLength(1)
    expect(f.calls.filter((call) => call.path.includes('/FavoriteItems/'))).toHaveLength(1)
  })

  it('仅缺收藏时不重写已恢复的观看记录', async () => {
    const f = fixture()
    f.state.current = { ...saved, IsFavorite: false }
    const snapshot = await f.client.captureUserData('old1', f.signal)
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.writes).toEqual([])
    expect(f.state.current).toEqual(saved)
  })

  it('收藏接口失败保留观看记录，重试只补收藏', async () => {
    const f = fixture()
    f.state.ignoreFavoriteInUserData = true
    f.state.favoriteStatus = 403
    const snapshot = await f.client.captureUserData('old1', f.signal)
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).rejects.toThrow(
      '权限',
    )
    expect(f.state.current).toEqual({ ...saved, IsFavorite: false })
    f.state.favoriteStatus = 200
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.writes).toHaveLength(1)
    expect(f.state.current).toEqual(saved)
  })

  it('收藏接口成功却未保存仍拒绝完成', async () => {
    const f = fixture()
    f.state.ignoreFavoriteInUserData = true
    f.state.ignoreFavoriteWrite = true
    const snapshot = await f.client.captureUserData('old1', f.signal)
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).rejects.toThrow(
      '未通过核对',
    )
  })

  it('补收藏前取消不再发出写入，保留已恢复的观看记录', async () => {
    const f = fixture()
    f.state.ignoreFavoriteInUserData = true
    const snapshot = await f.client.captureUserData('old1', f.signal)
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await f.fetcher(url, init)
      if (url.includes('/UserData')) controller.abort()
      return response
    })
    await expect(
      f.client.synchronizePublished(f.request, controller.signal, snapshot),
    ).rejects.toThrow('取消')
    expect(f.calls.some((call) => call.path.includes('/FavoriteItems/'))).toBe(false)
    expect(f.state.current.PlayCount).toBe(7)
  })

  it('原 ID 未改变时保留用户的新操作，不用旧快照覆盖', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    f.state.targetId = 'old1'
    f.state.old = { ...empty }
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.writes).toEqual([])
  })

  it('保留新条目更高次数、较新观看位置和评分，补回旧收藏', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    f.state.current = {
      ...empty,
      PlayCount: 10,
      Played: true,
      PlaybackPositionTicks: 888,
      LastPlayedDate: '2026-09-30T12:00:00.000Z',
      Rating: 8,
    }
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.state.current).toEqual({
      ...f.state.current,
      IsFavorite: true,
      PlayCount: 10,
      PlaybackPositionTicks: 888,
      LastPlayedDate: '2026-09-30T12:00:00.000Z',
      Rating: 8,
    })
  })

  it.each(['userId', 'serverId'] as const)('%s 变化拒绝迁移且不刷新新服务器', async (field) => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    f.state[field] = 'changed'
    f.client.invalidate()
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).rejects.toThrow(
      '身份已变化',
    )
    expect(f.writes).toEqual([])
    expect(f.calls.some((call) => call.path.endsWith('/Refresh'))).toBe(false)
  })

  it('条目不属于快照时拒绝操作', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    await expect(
      f.client.synchronizePublished({ ...f.request, itemId: 'other' }, f.signal, snapshot),
    ).rejects.toThrow('不属于')
    expect(f.writes).toEqual([])
  })

  it('路径歧义不迁移', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    f.state.matches = 2
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).rejects.toThrow(
      '多个项目',
    )
    expect(f.writes).toEqual([])
  })

  it.each(['size', 'chinese', 'matches'] as const)(
    '%s 未确认时不写用户记录',
    async (field) => {
      const f = fixture()
      const snapshot = await f.client.captureUserData('old1', f.signal)
      if (field === 'size') f.state.size = 90
      if (field === 'chinese') f.state.chinese = false
      if (field === 'matches') f.state.matches = 0
      const deadline = new AbortController()
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
      vi.spyOn(timers, 'setTimeout').mockImplementation(async (_ms, _value, options) => {
        deadline.abort()
        options!.signal!.throwIfAborted()
      })
      const result = expect(
        f.client.synchronizePublished(f.request, f.signal, snapshot),
      ).rejects.toThrow(/大小|字幕|路径/)
      await result
      expect(f.writes).toEqual([])
    },
    10000,
  )

  it.each([403, 500])('写入失败 %s 可重试，不伪报成功', async (status) => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    f.state.writeStatus = status
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).rejects.toThrow(
      /权限|状态码/,
    )
    expect(f.state.current).toEqual(empty)
    f.state.writeStatus = 204
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.state.current.PlayCount).toBe(7)
  })

  it('成功响应但未保存数据必须核对失败', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    f.state.ignoreWrite = true
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).rejects.toThrow(
      '未通过核对',
    )
  })

  it('写入后取消保留快照，重试不会重复写入', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await f.fetcher(url, init)
      if (url.includes('/UserData')) controller.abort()
      return response
    })
    await expect(
      f.client.synchronizePublished(f.request, controller.signal, snapshot),
    ).rejects.toThrow('取消')
    expect(f.state.current.PlayCount).toBe(7)
    vi.stubGlobal('fetch', f.fetcher)
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.writes).toHaveLength(1)
  })

  it('目标用户数据不完整时停止，不能将读取失败当作新条目零记录', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    f.state.current = { ...empty, PlayCount: undefined } as unknown as MediaUserData
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).rejects.toThrow(
      '完整',
    )
    expect(f.writes).toEqual([])
  })

  it('写入后响应丢失，重启客户端从快照恢复不增加次数', async () => {
    const f = fixture()
    const snapshot = JSON.parse(JSON.stringify(await f.client.captureUserData('old1', f.signal)))
    f.state.interruptAfterWrite = true
    await expect(f.client.synchronizePublished(f.request, f.signal, snapshot)).rejects.toThrow()
    f.client.invalidate()
    f.state.interruptAfterWrite = false
    await f.client.synchronizePublished(f.request, f.signal, snapshot)
    expect(f.writes).toHaveLength(1)
    expect(f.state.current.PlayCount).toBe(7)
  })

  it('取消后不写入；历史无快照任务仅确认媒体，不伪造旧数据', async () => {
    const f = fixture()
    const snapshot = await f.client.captureUserData('old1', f.signal)
    const controller = new AbortController()
    controller.abort()
    await expect(
      f.client.synchronizePublished(f.request, controller.signal, snapshot),
    ).rejects.toThrow('取消')
    await f.client.synchronizePublished(f.request, f.signal)
    expect(f.writes).toEqual([])
  })
})
