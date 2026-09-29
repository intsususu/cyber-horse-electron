import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, parse } from 'node:path'
import { defaultSettings } from '../src/shared/contracts'
import {
  mediaQuerySchema,
  mediaDownloadSchema,
  mediaImageSchema,
  mediaPlaybackSchema,
  mediaPlaybackErrorSchema,
} from '../src/shared/media-library'
import { EmbyClient } from '../src/main/services/emby-client'
import { MediaPlayback } from '../src/main/services/media-playback'
import { MediaPlaybackLog } from '../src/main/services/media-playback-log'
import { MediaDownloads } from '../src/main/services/media-downloads'
import { MediaProcessService } from '../src/main/services/media-process'
import { PipelineTools } from '../src/main/services/pipeline-tools'
import { ExecutionLock } from '../src/main/services/execution-lock'

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const payload = Buffer.from('隔离的媒体内容')
async function fixture() {
  const root = await fs.realpath(await mkdtemp(join(tmpdir(), 'horse-media-test-')))
  const settings = structuredClone(defaultSettings)
  for (const key of [
    'download',
    'preprocess',
    'whisperOutput',
    'videoOutput',
    'mdcOutput',
    'nas',
  ] as const) {
    settings.paths[key] = join(root, key)
    await mkdir(settings.paths[key])
  }
  settings.mediaServer = {
    ...defaultSettings.mediaServer,
    serverUrl: 'http://media.invalid/emby',
    username: '测试用户',
    downloadDirectory: '',
  }
  const calls: { url: URL; init: RequestInit }[] = []
  let mode = ''
  let catalog: (typeof item)[] | null = null
  const item = {
    Id: 'v1',
    Name: '影片',
    Path: '/server/影片/ABC-123.mp4',
    Genres: ['剧情'],
    People: [{ Id: 12, Name: '演员', Role: '主角' }],
    UserData: { IsFavorite: false },
    MediaSources: [
      {
        Id: 's1',
        Path: '/server/影片/ABC-123.mp4',
        Container: 'mp4',
        Size: payload.length,
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
          {
            Type: 'Subtitle',
            Index: 2,
            DisplayTitle: '中文',
            Language: 'zho',
            Codec: 'srt',
            IsTextSubtitleStream: true,
          },
          {
            Type: 'Subtitle',
            Index: 3,
            DisplayTitle: '图像字幕',
            Language: 'zho',
            Codec: 'pgs',
            IsTextSubtitleStream: false,
          },
        ],
      },
    ],
    Chapters: [{ Name: '片头', StartPositionTicks: 100000000, ImageTag: 'preview' }],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url)
      calls.push({ url: parsed, init })
      if (parsed.pathname.endsWith('AuthenticateByName'))
        return Response.json({
          AccessToken: '测试令牌',
          ServerId: 'fixture-server',
          User: { Id: 'u1', Policy: { EnableContentDeletion: true } },
        })
      if (mode === '过期') return new Response('', { status: 401 })
      if (mode === '禁止') return new Response('', { status: 403 })
      if (mode === '坏响应') return Response.json({ Items: '错误' })
      if (parsed.pathname.endsWith('/Views'))
        return Response.json({ Items: [{ Id: 'lib', Name: '影片库' }] })
      if (parsed.pathname.endsWith('/Items/v1')) return Response.json(item)
      if (parsed.pathname.endsWith('/Subtitles/2/Stream.vtt'))
        return new Response('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n中文字幕\n', {
          headers: { 'content-type': 'text/vtt' },
        })
      if (
        parsed.pathname.endsWith('/stream') ||
        parsed.pathname.endsWith('/stream.mp4') ||
        parsed.pathname.endsWith('/stream.mkv')
      ) {
        if (mode === '中断') return new Response(payload.subarray(0, 2))
        if (mode === '慢速')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(payload.subarray(0, 2))
                init.signal?.addEventListener(
                  'abort',
                  () => controller.error(new Error('已取消')),
                  { once: true },
                )
              },
            }),
          )
        return new Response(payload, {
          status: init.headers && 'Range' in init.headers ? 206 : 200,
          headers: {
            'content-length': String(payload.length),
            'content-type': parsed.pathname.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4',
            ...(init.headers && 'Range' in init.headers
              ? { 'content-range': `bytes 0-${payload.length - 1}/${payload.length}` }
              : {}),
          },
        })
      }
      if (parsed.pathname.includes('/Images/'))
        return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
      if (init.method === 'POST' || init.method === 'DELETE')
        return new Response(null, { status: 204 })
      if (parsed.pathname.endsWith('/Items') && catalog) {
        const start = Number(parsed.searchParams.get('StartIndex') ?? 0)
        const limit = Number(parsed.searchParams.get('Limit') ?? 20)
        return Response.json({
          Items: parsed.searchParams.has('SearchTerm') ? [] : catalog.slice(start, start + limit),
          TotalRecordCount: parsed.searchParams.has('SearchTerm') ? 0 : catalog.length,
        })
      }
      return Response.json({ Items: [item], TotalRecordCount: 41 })
    }),
  )
  const client = new EmbyClient(
    async () => structuredClone(settings),
    async () => '测试密码',
  )
  const downloads = new MediaDownloads(join(root, 'data'), [], client, async () =>
    structuredClone(settings),
  )
  return {
    root,
    settings,
    calls,
    client,
    downloads,
    item,
    setCatalog: (items: (typeof item)[]) => {
      catalog = items
    },
    mode: (value: string) => {
      mode = value
    },
  }
}
const query = {
  libraryId: 'lib',
  start: 20,
  limit: 20,
  sort: 'DatePlayed' as const,
  favorites: true,
  filter: { kind: 'person' as const, id: '12', name: '演员' },
}
const waitDownloads = async (service: MediaDownloads) => {
  await vi.waitFor(async () =>
    expect(
      (await service.snapshot()).every((v) => !['running', 'cancelling'].includes(v.status)),
    ).toBe(true),
  )
  return service.snapshot()
}

describe('媒体库网络契约', () => {
  it('详情链接使用当前服务器与服务端番号，未配置时拒绝打开 JavBus', async () => {
    const f = await fixture()
    expect(await f.client.externalLink('v1', 'emby')).toBe(
      'http://media.invalid/emby/web/index.html#!/item?id=v1&serverId=fixture-server',
    )
    await expect(f.client.externalLink('v1', 'javbus')).rejects.toThrow('请先配置')
    f.settings.mediaServer.javbusUrl = 'https://www.javbus.com/VDD-209'
    expect(await f.client.externalLink('v1', 'javbus')).toBe('https://www.javbus.com/ABC-123')
    f.item.Name = 'VDD-210 新名称'
    expect(await f.client.externalLink('v1', 'javbus')).toBe('https://www.javbus.com/VDD-210')
  })
  it('复用认证、保持子路径与库范围，不把密码或令牌返回渲染端', async () => {
    const f = await fixture()
    const [libraries, page] = await Promise.all([f.client.libraries(), f.client.page(query)])
    expect(libraries[0]?.name).toBe('影片库')
    expect(page.next).toBe(21)
    expect(page.favoriteDateUnavailable).toBe(true)
    expect(f.calls.filter((v) => v.url.pathname.endsWith('AuthenticateByName'))).toHaveLength(1)
    const request = f.calls.find((v) => v.url.pathname.endsWith('/Items'))!
    expect(request.url.pathname).toBe('/emby/Users/u1/Items')
    expect(Object.fromEntries(request.url.searchParams)).toMatchObject({
      ParentId: 'lib',
      StartIndex: '20',
      Limit: '20',
      IsFavorite: 'true',
      PersonIds: '12',
      SortBy: 'DatePlayed',
    })
    expect(request.init.redirect).toBe('error')
    expect(JSON.stringify([libraries, page])).not.toMatch(/测试令牌|测试密码/)
    const detail = await f.client.detail('v1')
    expect(detail.genres).toEqual([{ id: '', name: '剧情' }])
    expect(detail.people[0]?.id).toBe('12')
    expect(detail.canDelete).toBe(true)
    expect(detail.chapters).toEqual([{ index: 0, name: '片头', startSeconds: 10, hasImage: true }])
    await f.client.favorite('v1', false)
    expect(f.calls.at(-1)?.init.method).toBe('DELETE')
  })
  it('逐页按当前库标题包含匹配中文片段，并缓存后续结果页', async () => {
    const f = await fixture()
    f.setCatalog(
      Array.from({ length: 135 }, (_, index) => ({
        ...f.item,
        Id: `v${index + 1}`,
        Name:
          index >= 100 && index < 125
            ? `约会170CM高颜值美女大学生小佟丽娅 ${index}`
            : `其他影片 ${index}`,
      })),
    )
    const search = mediaQuerySchema.parse({
      ...query,
      libraryId: 'lib',
      start: 0,
      favorites: false,
      filter: undefined,
      searchTerm: '  佟丽娅  ',
    })
    const first = await f.client.page(search)
    expect(first.total).toBe(25)
    expect(first.items).toHaveLength(20)
    expect(first.items.every((item) => item.name.includes('佟丽娅'))).toBe(true)
    const requests = f.calls.filter((call) => call.url.pathname.endsWith('/Items'))
    expect(requests.map((request) => request.url.searchParams.get('StartIndex'))).toEqual([
      '0',
      '100',
    ])
    expect(requests.every((request) => request.url.searchParams.get('ParentId') === 'lib')).toBe(
      true,
    )
    expect(requests.every((request) => !request.url.searchParams.has('SearchTerm'))).toBe(true)
    const second = await f.client.page({ ...search, start: first.next })
    expect(second.items).toHaveLength(5)
    expect(f.calls.filter((call) => call.url.pathname.endsWith('/Items'))).toHaveLength(2)
    expect(mediaQuerySchema.safeParse({ ...search, searchTerm: '   ' }).success).toBe(false)
    expect(mediaQuerySchema.safeParse({ ...search, searchTerm: '字'.repeat(201) }).success).toBe(
      false,
    )
  })
  it('认证失效后重登，用户名更换也必须重登；权限失败不伪造成功', async () => {
    const f = await fixture()
    await f.client.libraries()
    f.mode('过期')
    await expect(f.client.favorite('v1', true)).rejects.toThrow('认证已失效')
    f.mode('')
    await f.client.libraries()
    f.settings.mediaServer.username = '另一用户'
    await f.client.libraries()
    expect(f.calls.filter((v) => v.url.pathname.endsWith('AuthenticateByName'))).toHaveLength(3)
    f.mode('禁止')
    await expect(f.client.refresh('lib')).rejects.toThrow('权限')
  })
  it('删除确认期间连接变化后拒绝删除，坏数据与任意路径参数被拒绝', async () => {
    const f = await fixture()
    await f.client.detail('v1')
    const generation = f.client.generation
    f.client.invalidate()
    await expect(f.client.delete('v1', generation)).rejects.toThrow('重新确认')
    f.mode('坏响应')
    await expect(f.client.page(query)).rejects.toThrow('格式无效')
    expect(mediaQuerySchema.safeParse({ ...query, path: 'C:/' }).success).toBe(false)
    expect(mediaDownloadSchema.safeParse({ id: '../secret', sourceId: 's1' }).success).toBe(false)
    expect(mediaQuerySchema.safeParse({ ...query, limit: 100000 }).success).toBe(false)
  })
  it('封面只返回允许的图片类型，隐私图仅读取已保存路径', async () => {
    const f = await fixture()
    expect(await f.client.image({ id: 'v1', kind: 'Primary' })).toBeNull()
    expect(await f.client.image({ kind: 'privacyPoster' })).toBeNull()
    f.settings.privacyCover.posterPath = join(f.root, 'cover.png')
    await writeFile(f.settings.privacyCover.posterPath, Buffer.from('封面测试'))
    expect(await f.client.image({ kind: 'privacyPoster' })).toMatch(/^data:image\/png;base64,/)
    f.settings.privacyCover.posterPath = 'relative.png'
    await expect(f.client.image({ kind: 'privacyPoster' })).rejects.toThrow('绝对')
  })
  it('章节图片和视频流只通过受限参数代理，关闭后播放地址失效', async () => {
    const f = await fixture()
    const playback = new MediaPlayback(f.client)
    expect(mediaImageSchema.safeParse({ id: 'v1', kind: 'Chapter', index: 0 }).success).toBe(true)
    expect(mediaImageSchema.safeParse({ id: 'v1', kind: 'Chapter', index: -1 }).success).toBe(false)
    expect(
      mediaPlaybackSchema.safeParse({
        id: 'v1',
        sourceId: 's1',
        startSeconds: -1,
        transcode: false,
      }).success,
    ).toBe(false)
    const session = (await playback.open('v1', 's1', 0, false))!
    expect(session.direct).toBe(true)
    expect(session.url).not.toContain('测试令牌')
    const token = new URL(session.url).pathname.split('/')[2]!
    const response = await playback.response(
      new Request(session.url, { headers: { Range: 'bytes=0-10' } }),
      token,
    )
    expect(response.status).toBe(206)
    expect(await response.arrayBuffer()).toEqual(
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    )
    expect(f.calls.at(-1)?.url.pathname).toBe('/emby/Videos/v1/stream.mp4')
    expect(f.calls.at(-1)?.init.headers).toMatchObject({ Range: 'bytes=0-10' })
    const transcoded = (await playback.open('v1', 's1', 60, true))!
    expect(transcoded.direct).toBe(false)
    playback.close(token)
    const nextToken = transcoded.token
    expect((await playback.response(new Request(transcoded.url), nextToken)).status).toBe(200)
    expect(f.calls.at(-1)?.url.searchParams.get('StartTimeTicks')).toBe('600000000')
    expect(f.calls.at(-1)?.url.searchParams.get('VideoCodec')).toBe('h264')
    playback.close(nextToken)
    expect((await playback.response(new Request(session.url), token)).status).toBe(403)
  })
  it('MKV 媒体源优先按原格式直接播放并转发 Range', async () => {
    const f = await fixture()
    f.item.MediaSources[0]!.Container = 'mkv'
    const playback = new MediaPlayback(f.client)
    const session = (await playback.open('v1', 's1', 0, false))!
    expect(session.direct).toBe(true)
    expect(session.url).toMatch(/\/stream\.mkv$/)
    const response = await playback.response(
      new Request(session.url, { headers: { Range: 'bytes=0-10' } }),
      session.token,
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/x-matroska')
    expect(f.calls.at(-1)?.url.pathname).toBe('/emby/Videos/v1/stream.mkv')
    expect(f.calls.at(-1)?.url.searchParams.get('Static')).toBe('true')
    expect(f.calls.at(-1)?.url.searchParams.has('VideoCodec')).toBe(false)
    await response.body?.cancel()
  })
  it('文字字幕使用当前播放会话代理，图像轨和过期地址不能加载', async () => {
    const f = await fixture()
    const playback = new MediaPlayback(f.client)
    const session = (await playback.open('v1', 's1', 0, false))!
    expect(session.subtitles).toHaveLength(2)
    expect(session.defaultSubtitleIndex).toBe(2)
    const response = await playback.subtitle(session.token, 2)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/vtt')
    expect(await response.text()).toContain('中文字幕')
    expect(f.calls.at(-1)?.url.pathname).toBe('/emby/Videos/v1/s1/Subtitles/2/Stream.vtt')
    expect((await playback.subtitle(session.token, 3)).status).toBe(404)
    const shifted = (await playback.open('v1', 's1', 60, true))!
    expect((await playback.subtitle(shifted.token, 2)).status).toBe(200)
    expect(f.calls.at(-1)?.url.searchParams.get('StartPositionTicks')).toBe('600000000')
    playback.close(shifted.token)
    expect((await playback.subtitle(shifted.token, 2)).status).toBe(403)
  })
  it('播放失败记录响应与播放器错误，不记录令牌和媒体路径', async () => {
    const f = await fixture()
    const log = new MediaPlaybackLog(f.root)
    const playback = new MediaPlayback(f.client, log)
    const session = (await playback.open('v1', 's1', 0, true))!
    expect(
      mediaPlaybackErrorSchema.safeParse({
        token: session.token,
        code: 4,
        readyState: 0,
        networkState: 3,
      }).success,
    ).toBe(true)
    const response = await playback.response(new Request(session.url), session.token)
    await response.body?.cancel()
    await playback.reportError({ token: session.token, code: 4, readyState: 0, networkState: 3 })
    const content = await readFile(log.path, 'utf8')
    expect(content).toContain(session.diagnosticId)
    expect(content).toContain('播放器错误')
    expect(content).toContain('video/mp4')
    expect(content).not.toContain(session.token)
    expect(content).not.toContain('测试令牌')
    expect(content).not.toContain('/server/影片/')
    f.mode('禁止')
    await expect(playback.open('v1', 's1', 0, false)).rejects.toThrow('诊断编号')
    expect(await readFile(log.path, 'utf8')).toContain('播放准备失败')
  })
  it('较早的播放请求失效时正常返回，不把取消写成主进程错误', async () => {
    const f = await fixture()
    const detail = await f.client.detail('v1')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(f.client, 'detail')
      .mockImplementationOnce(async () => {
        await gate
        return detail
      })
      .mockResolvedValue(detail)
    const playback = new MediaPlayback(f.client)
    const earlier = playback.open('v1', 's1', 0, false)
    const latest = await playback.open('v1', 's1', 15, false)
    release()
    expect(await earlier).toBeNull()
    expect(latest?.token).toBeTruthy()
  })
  it('关闭旧会话不会取消正在准备的新会话', async () => {
    const f = await fixture()
    const detail = await f.client.detail('v1')
    const playback = new MediaPlayback(f.client)
    const old = (await playback.open('v1', 's1', 0, false))!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(f.client, 'detail').mockImplementationOnce(async () => {
      await gate
      return detail
    })
    const pending = playback.open('v1', 's1', 15, false)
    playback.close(old.token)
    release()
    expect((await pending)?.token).toBeTruthy()
  })
})
describe('媒体库下载保护', () => {
  it('完整下载安全发布，重名保留旧文件并持久化结果', async () => {
    const f = await fixture()
    await writeFile(join(f.settings.paths.download, 'ABC-123.mp4'), '旧文件')
    await f.downloads.start('v1', 's1')
    const [job] = await waitDownloads(f.downloads)
    expect(job?.status).toBe('completed')
    expect(await readFile(job!.path)).toEqual(payload)
    expect(await readFile(join(f.settings.paths.download, 'ABC-123.mp4'), 'utf8')).toBe('旧文件')
    expect(await readdir(f.settings.paths.download)).toHaveLength(2)
    const restored = new MediaDownloads(join(f.root, 'data'), [], f.client, async () => f.settings)
    expect((await restored.snapshot())[0]?.status).toBe('completed')
    await f.downloads.clearFinished()
    expect(await f.downloads.snapshot()).toEqual([])
    expect(await readFile(job!.path)).toEqual(payload)
    const cleared = new MediaDownloads(join(f.root, 'data'), [], f.client, async () => f.settings)
    expect(await cleared.snapshot()).toEqual([])
  })
  it('清除历史时保留正在下载的任务及临时文件', async () => {
    const f = await fixture()
    f.mode('慢速')
    const job = await f.downloads.start('v1', 's1')
    await vi.waitFor(async () => expect((await f.downloads.snapshot())[0]?.received).toBe(2))
    expect(await f.downloads.activeCountExcluding(new Set())).toBe(1)
    expect(await f.downloads.activeCountExcluding(new Set([job.id]))).toBe(0)
    await f.downloads.clearFinished()
    expect((await f.downloads.snapshot()).map((entry) => entry.id)).toEqual([job.id])
    f.downloads.cancel(job.id)
    await waitDownloads(f.downloads)
    await f.downloads.clearFinished()
    expect(await f.downloads.snapshot()).toEqual([])
    expect(await readFile(job.temporary)).toEqual(payload.subarray(0, 2))
  })
  it('重复下载互斥，取消保留部分文件，不发布目标', async () => {
    const f = await fixture()
    f.mode('慢速')
    const job = await f.downloads.start('v1', 's1')
    await expect(f.downloads.start('v1', 's1')).rejects.toThrow('已在下载')
    await vi.waitFor(async () => expect((await f.downloads.snapshot())[0]?.received).toBe(2))
    f.downloads.cancel(job.id)
    const [done] = await waitDownloads(f.downloads)
    expect(done?.status).toBe('cancelled')
    expect(await readFile(job.temporary)).toEqual(payload.subarray(0, 2))
    expect(await readdir(f.settings.paths.download)).toEqual([basename(job.temporary)])
  })
  it('截断、根目录、保护目录与伪造来源被拒绝', async () => {
    const f = await fixture()
    f.mode('中断')
    const job = await f.downloads.start('v1', 's1')
    expect((await waitDownloads(f.downloads))[0]?.status).toBe('failed')
    expect(await readFile(job.temporary)).toEqual(payload.subarray(0, 2))
    await expect(f.downloads.start('v1', 'wrong')).rejects.toThrow('不存在')
    f.settings.paths.download = parse(f.root).root
    await expect(f.downloads.start('v1', 's1')).rejects.toThrow('根目录')
    f.settings.paths.download = f.root
    const protectedService = new MediaDownloads(
      join(f.root, 'data2'),
      [f.root],
      f.client,
      async () => f.settings,
    )
    await expect(protectedService.start('v1', 's1')).rejects.toThrow('项目目录')
  })
})

describe('媒体库复合任务', () => {
  async function processFixture() {
    const f = await fixture()
    const directory = join(f.settings.paths.nas, '影片')
    await mkdir(directory)
    const original = join(directory, 'ABC-123.mp4')
    await writeFile(original, payload)
    await writeFile(join(directory, 'ABC-123.nfo'), '旧元数据')
    await writeFile(join(directory, '备注.txt'), '用户备注')
    const tools = new PipelineTools()
    vi.spyOn(tools, 'check').mockResolvedValue({})
    vi.spyOn(tools, 'video').mockImplementation(async (_checked, input, output) => {
      await copyFile(input, output)
    })
    vi.spyOn(tools, 'subtitle').mockImplementation(async (_checked, input, output) => {
      await copyFile(input, output)
      const path = join(dirname(output), 'subtitle.srt')
      await writeFile(path, '测试字幕')
      return path
    })
    vi.spyOn(tools, 'scrape').mockImplementation(async (_checked, input, directory) => {
      const video = join(directory, basename(input))
      const nfo = join(directory, basename(input, extname(input)) + '.nfo')
      await copyFile(input, video)
      await writeFile(nfo, '新元数据')
      return [video, nfo]
    })
    const lock = new ExecutionLock()
    const service = new MediaProcessService(
      join(f.root, 'data'),
      [],
      f.client,
      f.downloads,
      async () => structuredClone(f.settings),
      lock,
      tools,
    )
    return { ...f, directory, original, tools, service, lock }
  }
  it('先入队再读取详情；同影片不同操作和版本只保留一项，等待中可取消', async () => {
    const f = await processFixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const detail = vi.spyOn(f.client, 'detail').mockImplementationOnce(async () => {
      await gate
      throw new Error('模拟详情读取失败')
    })
    const first = f.service.enqueue({ id: 'v1', kind: 'video', name: '测试影片' })
    expect(first.alreadyQueued).toBe(false)
    expect(f.service.queueSummary().active).toBe(1)
    expect(
      f.service.enqueue({ id: 'v1', sourceId: 's2', kind: 'subtitle', name: '测试影片' }),
    ).toEqual({
      id: first.id,
      alreadyQueued: true,
    })
    const second = f.service.enqueue({ id: 'v2', kind: 'video', name: '另一影片' })
    expect(second.alreadyQueued).toBe(false)
    expect(f.service.queueSummary().active).toBe(2)
    await vi.waitFor(() => expect(detail).toHaveBeenCalledTimes(1))
    expect(f.service.snapshot().find((record) => record.id === second.id)?.status).toBe('pending')
    f.service.cancel(second.id)
    expect(f.service.snapshot().find((record) => record.id === second.id)?.status).toBe('cancelled')
    release()
    await vi.waitFor(() => expect(f.service.active).toBe(false))
    expect(f.service.snapshot().find((record) => record.id === first.id)?.message).toContain(
      '模拟详情读取失败',
    )
    expect(f.service.queueSummary().active).toBe(0)
    expect(await f.downloads.snapshot()).toEqual([])
    expect(await readFile(f.original)).toEqual(payload)
  })
  it('入队后的预检失败只记录失败任务，可再次提交', async () => {
    const f = await processFixture()
    f.item.MediaSources[0]!.Path = '/server/不存在/ABC-123.mp4'
    const first = f.service.enqueue({ id: 'v1', kind: 'video', name: '测试影片' })
    await vi.waitFor(() => expect(f.service.active).toBe(false))
    expect(f.service.snapshot()[0]?.status).toBe('failed')
    expect(f.service.snapshot()[0]?.message).toContain('未在已配置的 NAS')
    const retry = f.service.enqueue({ id: 'v1', kind: 'video', name: '测试影片' })
    expect(retry.alreadyQueued).toBe(false)
    expect(retry.id).not.toBe(first.id)
    await vi.waitFor(() => expect(f.service.active).toBe(false))
  })
  it('取消正在读取详情的任务会中止请求且不开始下载', async () => {
    const f = await processFixture()
    const detail = vi.spyOn(f.client, 'detail').mockImplementationOnce(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('请求已取消。'))
          else
            signal?.addEventListener('abort', () => reject(new Error('请求已取消。')), {
              once: true,
            })
        }),
    )
    const queued = f.service.enqueue({ id: 'v1', kind: 'video', name: '测试影片' })
    await vi.waitFor(() => expect(detail).toHaveBeenCalledOnce())
    f.service.cancel(queued.id)
    await vi.waitFor(() => expect(f.service.active).toBe(false))
    expect(f.service.snapshot()[0]?.status).toBe('cancelled')
    expect(await f.downloads.snapshot()).toEqual([])
    expect(await readFile(f.original)).toEqual(payload)
  })
  it('入队后在队列内完成预检及处理', async () => {
    const f = await processFixture()
    const queued = f.service.enqueue({ id: 'v1', kind: 'subtitle', name: '测试影片' })
    expect(queued.alreadyQueued).toBe(false)
    await vi.waitFor(() => expect(f.service.active).toBe(false), { timeout: 10000 })
    const record = f.service.snapshot()[0]!
    expect(record.id).toBe(queued.id)
    expect(record.status, record.message).toBe('completed')
    expect(record.sourceId).toBe('s1')
    expect(record.original).toBe(f.original)
  })
  it('自动定位拒绝歧义路径、越界路径与大小不符的文件', async () => {
    const f = await processFixture()
    await mkdir(join(f.settings.paths.nas, 'server', '影片'), { recursive: true })
    await writeFile(join(f.settings.paths.nas, 'server', '影片', 'ABC-123.mp4'), payload)
    await expect(f.service.preview('v1', 's1', 'video')).rejects.toThrow('对应多个文件')
    f.item.MediaSources[0]!.Path = '/server/../影片/ABC-123.mp4'
    await expect(f.service.preview('v1', 's1', 'video')).rejects.toThrow('路径格式无效')
    f.item.MediaSources[0]!.Path = '/server/影片/ABC-123.mp4'
    await fs.rm(join(f.settings.paths.nas, 'server', '影片', 'ABC-123.mp4'))
    f.item.MediaSources[0]!.Size = payload.length + 1
    await expect(f.service.preview('v1', 's1', 'video')).rejects.toThrow('大小不一致')
  })
  it('发布新文件失败时不提前删除原视频与元数据', async () => {
    const f = await processFixture()
    const originalLink = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      if (String(target) === join(f.directory, 'ABC-123-U.mkv'))
        throw Object.assign(new Error('模拟目标写入失败'), { code: 'EIO' })
      return originalLink(source, target)
    })
    const plan = await f.service.preview('v1', 's1', 'video')
    await f.service.start(plan.id)
    await vi.waitFor(() => expect(f.service.active).toBe(false), { timeout: 10000 })
    expect(f.service.snapshot()[0]?.status).toBe('failed')
    const journal = f.service.snapshot()[0]!.journal
    f.service.clearFinished()
    expect(f.service.snapshot()).toEqual([])
    expect(await readFile(journal, 'utf8')).toContain('结果')
    expect(await readFile(f.original)).toEqual(payload)
    expect(await readFile(join(f.directory, 'ABC-123.nfo'), 'utf8')).toBe('旧元数据')
    expect(await readFile(join(f.directory, '备注.txt'), 'utf8')).toBe('用户备注')
  })
  it('取消下载阶段的复合任务会停止后续处理并释放执行锁', async () => {
    const f = await processFixture()
    f.mode('慢速')
    const plan = await f.service.preview('v1', 's1', 'video')
    await f.service.start(plan.id)
    await vi.waitFor(() => expect(f.service.snapshot()[0]?.downloadId).toBeTruthy())
    expect(f.service.queueSummary().active).toBe(1)
    expect(await f.downloads.activeCountExcluding(f.service.queueSummary().downloadIds)).toBe(0)
    f.service.cancel(plan.id)
    await vi.waitFor(() => expect(f.service.active).toBe(false), { timeout: 10000 })
    expect(f.service.queueSummary().active).toBe(0)
    expect(f.service.snapshot()[0]?.status).toBe('cancelled')
    expect(f.tools.video).not.toHaveBeenCalled()
    expect(await readFile(f.original)).toEqual(payload)
    const release = f.lock.acquire('后续任务')
    release()
  })
  for (const kind of ['subtitle', 'video'] as const)
    it(`${kind === 'subtitle' ? '字幕' : '视频'}链只处理指定媒体，成功后清理旧文件和下载产物，未知文件保留`, async () => {
      const f = await processFixture()
      const plan = await f.service.preview('v1', 's1', kind)
      expect(plan.original).toBe(f.original)
      await f.service.start(plan.id)
      expect(() => f.lock.acquire('其他处理')).toThrow('复合任务')
      await vi.waitFor(() => expect(f.service.active).toBe(false), { timeout: 10000 })
      const state = f.service.snapshot()[0]!
      expect(state.status, state.message).toBe('completed')
      await expect(fs.stat(f.original)).rejects.toMatchObject({ code: 'ENOENT' })
      for (const root of [
        f.settings.paths.download,
        f.settings.paths.preprocess,
        f.settings.paths.mdcOutput,
      ])
        expect(await readdir(root)).toEqual([])
      expect((await readdir(f.directory)).some((name) => name.startsWith('.'))).toBe(false)
      expect(await readFile(join(f.directory, '备注.txt'), 'utf8')).toBe('用户备注')
      expect(
        (await readdir(f.directory)).some((name) =>
          name.endsWith(kind === 'video' ? '-U.mkv' : '-C.mkv'),
        ),
      ).toBe(true)
      expect(f.calls.some((call) => call.url.pathname.endsWith('/Refresh'))).toBe(true)
    })
  it('选错同大小原视频时，内容校验阻止工具执行与回写', async () => {
    const f = await processFixture()
    await writeFile(f.original, Buffer.alloc(payload.length, 1))
    const plan = await f.service.preview('v1', 's1', 'video')
    await f.service.start(plan.id)
    await vi.waitFor(() => expect(f.service.active).toBe(false), { timeout: 10000 })
    expect(f.service.snapshot()[0]?.message).toContain('不一致')
    expect(f.tools.video).not.toHaveBeenCalled()
    expect(await readFile(f.original)).toEqual(Buffer.alloc(payload.length, 1))
  })
  it('工具失败保留原媒体；目录越界、多视频目录、配置变化均被拒绝', async () => {
    const f = await processFixture()
    f.item.MediaSources[0]!.Path = '/server/别的影片/ABC-123.mp4'
    await expect(f.service.preview('v1', 's1', 'video')).rejects.toThrow('未在已配置的 NAS')
    f.item.MediaSources[0]!.Path = '/server/影片/ABC-123.mp4'
    await writeFile(join(f.directory, '另一个.mp4'), payload)
    await expect(f.service.preview('v1', 's1', 'video')).rejects.toThrow('一个视频')
    const g = await processFixture()
    vi.spyOn(g.tools, 'video').mockRejectedValue(new Error('工具测试失败'))
    const plan = await g.service.preview('v1', 's1', 'video')
    await g.service.start(plan.id)
    await vi.waitFor(() => expect(g.service.active).toBe(false), { timeout: 10000 })
    expect(g.service.snapshot()[0]?.status).toBe('failed')
    expect(await readFile(g.original)).toEqual(payload)
    const next = await g.service.preview('v1', 's1', 'video')
    g.settings.subtitle.format = 'ass'
    await g.service.start(next.id)
    await vi.waitFor(() => expect(g.service.active).toBe(false))
    expect(g.service.snapshot().at(-1)?.message).toContain('配置已变化')
  })
})
