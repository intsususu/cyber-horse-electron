import { randomUUID } from 'node:crypto'
import type { EmbyClient } from './emby-client'
import type { MediaPlaybackSession, MediaSubtitle } from '../../shared/media-library'
import type { MediaPlaybackLog } from './media-playback-log'

type Playback = {
  token: string
  diagnosticId: string
  itemId: string
  sourceId: string
  startSeconds: number
  direct: boolean
  container: string
  generation: number
  controller: AbortController
  expires: number
  upstreamStatus: number | null
  upstreamType: string | null
  subtitles: MediaSubtitle[]
}

export class MediaPlayback {
  private current: Playback | null = null
  private revision = 0

  constructor(
    private client: EmbyClient,
    private log?: MediaPlaybackLog,
  ) {}

  async open(
    itemId: string,
    sourceId: string,
    startSeconds: number,
    transcode: boolean,
    native = false,
  ): Promise<MediaPlaybackSession | null> {
    const revision = ++this.revision
    const diagnosticId = randomUUID().slice(0, 8)
    let detail
    try {
      detail = await this.client.detail(itemId)
    } catch (error) {
      if (revision !== this.revision) return null
      const reason = error instanceof Error ? error.message : '无法读取媒体详情。'
      await this.log?.record('播放准备失败', { diagnosticId, reason }).catch(() => {})
      throw new Error(`${reason}（诊断编号 ${diagnosticId}）`)
    }
    if (revision !== this.revision) return null
    const source = detail.sources.find((value) => value.id === sourceId)
    if (!source) throw new Error('所选媒体版本已不存在。')
    const direct =
      !transcode &&
      (native || ['mp4', 'm4v', 'webm', 'mkv'].includes(source.container.toLowerCase()))
    if (native && !/^[a-z0-9]{1,12}$/.test(source.container.toLowerCase()))
      throw new Error('视频容器无效，无法交给 VLC 播放。')
    this.close()
    const token = randomUUID()
    this.current = {
      token,
      diagnosticId,
      itemId,
      sourceId,
      startSeconds,
      direct,
      container: source.container.toLowerCase(),
      generation: this.client.generation,
      controller: new AbortController(),
      expires: Date.now() + 8 * 60 * 60 * 1000,
      upstreamStatus: null,
      upstreamType: null,
      subtitles: source.subtitles,
    }
    void this.log
      ?.record('播放开始', {
        diagnosticId,
        mode: direct ? '直接播放' : '转码播放',
        container: source.container.toLowerCase(),
        startSeconds,
      })
      .catch(() => {})
    return {
      url: `horse://app/media-playback/${token}/stream.${direct ? source.container.toLowerCase() : 'mp4'}`,
      token,
      direct,
      diagnosticId,
      subtitles: source.subtitles,
      supportsCrossOrigin: true,
      defaultSubtitleIndex: source.defaultSubtitleIndex,
    }
  }

  async reportError(request: {
    token: string
    code: number
    readyState: number
    networkState: number
  }): Promise<void> {
    const playback = this.current
    if (!playback || playback.token !== request.token) return
    await this.log?.record('播放器错误', {
      diagnosticId: playback.diagnosticId,
      mode: playback.direct ? '直接播放' : '转码播放',
      code: request.code,
      readyState: request.readyState,
      networkState: request.networkState,
      upstreamStatus: playback.upstreamStatus,
      upstreamType: playback.upstreamType,
    })
  }

  close(token?: string): void {
    if (token) {
      if (this.current?.token !== token) return
    } else this.revision++
    this.current?.controller.abort()
    this.current = null
  }

  async subtitle(token: string, index: number): Promise<Response> {
    const playback = this.current
    if (!playback || playback.token !== token || playback.expires < Date.now())
      return new Response('播放地址已失效。', { status: 403 })
    if (!playback.subtitles.some((track) => track.index === index && track.isText))
      return new Response('字幕轨道不可用。', { status: 404 })
    try {
      const data = await this.client.subtitle(
        playback.itemId,
        playback.sourceId,
        index,
        playback.direct ? 0 : playback.startSeconds,
        playback.controller.signal,
        playback.generation,
      )
      void this.log
        ?.record('字幕响应', {
          diagnosticId: playback.diagnosticId,
          index,
          bytes: data.length,
        })
        .catch(() => {})
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      void this.log
        ?.record('字幕加载失败', {
          diagnosticId: playback.diagnosticId,
          index,
          reason: error instanceof Error ? error.message : '字幕读取失败。',
        })
        .catch(() => {})
      return new Response('字幕加载失败。', {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  }

  async response(request: Request, token: string): Promise<Response> {
    const playback = this.current
    if (!playback || playback.token !== token || playback.expires < Date.now())
      return new Response('播放地址已失效。', { status: 403 })
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('不支持的视频请求。', { status: 405 })
    const range = request.headers.get('range')
    if (range && !/^bytes=\d*-\d*$/.test(range))
      return new Response('视频范围参数无效。', { status: 416 })
    try {
      const upstream = await this.client.playback(
        playback.itemId,
        playback.sourceId,
        playback.startSeconds,
        playback.direct,
        playback.container,
        range,
        playback.controller.signal,
        playback.generation,
        playback.token.replaceAll('-', ''),
      )
      const type = upstream.headers.get('content-type')?.split(';')[0]?.toLowerCase()
      playback.upstreamStatus = upstream.status
      playback.upstreamType = type ?? null
      void this.log
        ?.record('视频流响应', {
          diagnosticId: playback.diagnosticId,
          status: upstream.status,
          type: type ?? null,
          requestedRange: Boolean(range),
          contentRange: Boolean(upstream.headers.get('content-range')),
        })
        .catch(() => {})
      if (!type || !(type.startsWith('video/') || type === 'application/octet-stream')) {
        await upstream.body?.cancel()
        return new Response('服务器未返回可播放的视频流。', { status: 502 })
      }
      const headers = new Headers()
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name)
        if (value) headers.set(name, value)
      }
      headers.set('Cache-Control', 'no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      if (request.method === 'HEAD') void upstream.body?.cancel()
      return new Response(request.method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        headers,
      })
    } catch (error) {
      void this.log
        ?.record('视频流请求失败', {
          diagnosticId: playback.diagnosticId,
          reason: error instanceof Error ? error.message : '视频流读取失败。',
        })
        .catch(() => {})
      return new Response(error instanceof Error ? error.message : '视频流读取失败。', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
  }
}
