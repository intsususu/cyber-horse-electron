import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import {
  vlcStateSchema,
  type VlcAvailability,
  type VlcBounds,
  type VlcControl,
  type VlcOpenRequest,
  type VlcState,
} from '../../shared/vlc-player'
import { MediaPlayback } from './media-playback'
import { nativeSubtitleFormat, type MediaSubtitle } from '../../shared/media-library'

export type VlcWindow = { handle: string; width: number; height: number; scale: number }
type Options = {
  helper: string
  directories?: string[]
  platform?: string
  launch?: (helper: string, args: string[]) => ChildProcess
  onInput?: (key: 'focus' | 'Space' | 'Enter' | 'Escape' | 'Left' | 'Right') => void
}
type Active = {
  token: string
  mediaToken: string | null
  secret: string
  server: Server | null
  child: ChildProcess | null
  state: VlcState
  tracks: MediaSubtitle[]
  subtitleChoice: number | null | undefined
  port: number
  closing: boolean
  revision: number
}

export function clampVlcBounds(bounds: VlcBounds, window: VlcWindow): VlcBounds {
  const x = Math.round(Math.min(window.width, Math.max(0, bounds.x * window.scale)))
  const y = Math.round(Math.min(window.height, Math.max(0, bounds.y * window.scale)))
  return {
    x,
    y,
    width: Math.round(Math.min(Math.max(0, window.width - x), bounds.width * window.scale)),
    height: Math.round(Math.min(Math.max(0, window.height - y), bounds.height * window.scale)),
    visible: bounds.visible,
  }
}

// 原生进程只接触临时回环地址；Emby 认证、来源检查和媒体流仍由主进程管理。
export class VlcPlayer {
  private active: Active | null = null
  private revision = 0
  private cancelled = new Set<string>()
  constructor(
    private playback: MediaPlayback,
    private options: Options,
  ) {}

  private async directory(): Promise<string | null> {
    const candidates = this.options.directories ?? [
      join(
        process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files',
        'VideoLAN/VLC',
      ),
    ]
    for (const directory of candidates) {
      try {
        await stat(join(directory, 'plugins'))
        await stat(join(directory, 'libvlccore.dll'))
        const file = await open(join(directory, 'libvlc.dll'), 'r')
        try {
          const header = Buffer.alloc(64)
          await file.read(header, 0, 64, 0)
          if (header.readUInt16LE(0) !== 0x5a4d) continue
          const pe = Buffer.alloc(6)
          await file.read(pe, 0, 6, header.readUInt32LE(60))
          if (pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === 0x8664) return directory
        } finally {
          await file.close()
        }
      } catch {
        /* 不把未安装、损坏或 32 位 DLL 当作可用引擎。 */
      }
    }
    return null
  }
  async availability(): Promise<VlcAvailability> {
    if ((this.options.platform ?? process.platform) !== 'win32')
      return { available: false, message: 'VLC 内嵌播放目前仅支持 Windows 64 位。' }
    try {
      await stat(this.options.helper)
    } catch {
      return { available: false, message: 'VLC 内嵌播放器尚未准备，请更新并完整重启应用。' }
    }
    return (await this.directory())
      ? { available: true, message: '已检测到 64 位 VLC，播放时会检查引擎版本并启动。' }
      : {
          available: false,
          message: '未检测到标准安装位置中的 64 位 VLC。请安装 VLC 3.x 64 位版本。',
        }
  }

  private current(active: Active): boolean {
    return (
      this.active === active &&
      !active.closing &&
      active.state.status !== 'failed' &&
      active.revision === this.revision
    )
  }
  private send(active: Active, command: object): void {
    if (!this.current(active) || !active.child?.stdin?.writable) return
    active.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) this.fail(active, 'VLC 播放进程已断开，请重新打开视频。')
    })
  }
  private fail(active: Active, message: string): void {
    if (
      this.active !== active ||
      active.closing ||
      active.revision !== this.revision ||
      (!active.child && !active.server)
    )
      return
    active.state = { ...active.state, status: 'failed', message }
    this.release(active)
  }
  private release(active: Active): void {
    this.playback.close(active.mediaToken ?? undefined)
    active.server?.closeAllConnections()
    active.server?.close()
    active.server = null
    const child = active.child
    active.child = null
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end('{"action":"close"}\n')
      const timer = setTimeout(() => child.kill(), 2000)
      timer.unref()
      child.once('exit', () => clearTimeout(timer))
    }
  }
  close(token?: string): void {
    if (token) {
      this.cancelled.add(token)
      if (this.cancelled.size > 256) this.cancelled.delete(this.cancelled.values().next().value!)
    }
    const active = this.active
    if (!active || (token && token !== active.token)) return
    this.revision++
    active.closing = true
    this.active = null
    this.release(active)
  }
  state(token: string): VlcState | null {
    return this.active?.token === token ? structuredClone(this.active.state) : null
  }

  async open(request: VlcOpenRequest, window: VlcWindow, muted: boolean): Promise<VlcState | null> {
    if (this.cancelled.has(request.requestId)) return null
    this.close()
    const active: Active = {
      token: request.requestId,
      mediaToken: null,
      secret: randomUUID(),
      server: null,
      child: null,
      tracks: [],
      subtitleChoice: undefined,
      port: 0,
      closing: false,
      revision: ++this.revision,
      state: {
        token: request.requestId,
        status: 'loading',
        position: request.startSeconds,
        duration: null,
        width: 0,
        height: 0,
        muted,
        volume: 1,
        subtitles: [],
        subtitleIndex: null,
        message: '',
      },
    }
    this.active = active
    try {
      const availability = await this.availability()
      if (!this.current(active)) return null
      if (!availability.available) throw new Error(availability.message)
      const directory = await this.directory()
      if (!this.current(active)) return null
      if (!directory) throw new Error('VLC 安装已变化，请重新检查。')
      const session = await this.playback.open(
        request.id,
        request.sourceId,
        request.startSeconds,
        false,
        true,
      )
      if (!this.current(active)) {
        if (session) this.playback.close(session.token)
        return null
      }
      if (!session) {
        this.close(active.token)
        return null
      }
      active.mediaToken = session.token
      active.tracks = session.subtitles
        .filter((track) => track.isText)
        .map((track) => ({
          ...track,
          index: 100000 + track.index,
          name: `${track.name}（服务器字幕${nativeSubtitleFormat(track.codec) === 'vtt' ? '' : '，保留样式'}）`,
        }))
      const server = createServer(async (incoming, outgoing) => {
        if (
          !this.current(active) ||
          !incoming.url ||
          incoming.headers.host !== `127.0.0.1:${active.port}` ||
          !['GET', 'HEAD'].includes(incoming.method ?? '') ||
          incoming.headers.origin
        ) {
          outgoing.writeHead(403).end()
          return
        }
        const url = new URL(incoming.url, `http://127.0.0.1:${active.port}`)
        const prefix = `/${active.secret}/`
        const subtitle = new RegExp(
          `^/${active.secret}/subtitles/(\\d{1,4})\\.(vtt|ass|ssa)$`,
        ).exec(url.pathname)
        const track =
          subtitle &&
          session.subtitles.find((track) => track.index === Number(subtitle[1]) && track.isText)
        if (
          url.search ||
          (url.pathname !== `${prefix}stream` && !subtitle) ||
          (subtitle && (!track || subtitle[2] !== nativeSubtitleFormat(track.codec)))
        ) {
          outgoing.writeHead(403).end()
          return
        }
        try {
          const response = subtitle
            ? await this.playback.subtitle(
                session.token,
                Number(subtitle[1]),
                nativeSubtitleFormat(track!.codec),
              )
            : await this.playback.response(
                new Request(session.url, {
                  method: incoming.method,
                  headers: incoming.headers.range ? { range: incoming.headers.range } : {},
                }),
                session.token,
              )
          if (!this.current(active) || outgoing.destroyed) {
            await response.body?.cancel()
            outgoing.destroy()
            return
          }
          outgoing.writeHead(response.status, Object.fromEntries(response.headers))
          if (!response.body || incoming.method === 'HEAD') {
            await response.body?.cancel()
            outgoing.end()
            return
          }
          await pipeline(
            Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
            outgoing,
          )
        } catch {
          outgoing.destroy()
        }
      })
      active.server = server
      server.requestTimeout = 0
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      if (!this.current(active)) {
        server.closeAllConnections()
        server.close()
        return null
      }
      server.on('error', () => this.fail(active, 'VLC 本机视频转发失败，请重新打开视频。'))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法启动 VLC 本机视频转发。')
      active.port = address.port
      const child = (
        this.options.launch ??
        ((helper, args) =>
          spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }))
      )(this.options.helper, [directory, window.handle])
      active.child = child
      // 原生库可能打印带临时地址的诊断信息；不将这些内容写入应用日志。
      child.stderr?.resume()
      child.stdin?.on('error', () => this.fail(active, 'VLC 播放进程已断开，请重新打开视频。'))
      const lines = createInterface({ input: child.stdout! })
      await new Promise<void>((resolve, reject) => {
        let ready = false
        const timer = setTimeout(
          () => reject(new Error('VLC 播放器启动超时，请重新打开视频。')),
          8000,
        )
        const failed = (message: string) => {
          clearTimeout(timer)
          if (!ready) reject(new Error(message))
          else this.fail(active, message)
        }
        child.once('error', () => failed('无法启动 VLC 播放进程，请更新应用并检查安装。'))
        child.once('exit', () => {
          lines.close()
          failed('VLC 播放进程已退出，请重新打开视频。')
        })
        lines.on('line', (line) => {
          if (!this.current(active)) {
            clearTimeout(timer)
            if (!ready) resolve()
            return
          }
          if (line.length > 131072) {
            failed('VLC 返回的播放状态无效。')
            return
          }
          try {
            const event = JSON.parse(line)
            if (event.type === 'ready') {
              ready = true
              clearTimeout(timer)
              resolve()
            } else if (
              event.type === 'input' &&
              ['focus', 'Space', 'Enter', 'Escape', 'Left', 'Right'].includes(event.key)
            )
              this.options.onInput?.(event.key)
            else if (event.type === 'error')
              failed('VLC 内嵌播放失败，请检查 64 位 VLC 3.x 安装或切回默认播放器。')
            else if (event.type === 'state') {
              const parsed = vlcStateSchema.safeParse(event.state)
              if (parsed.success && parsed.data.token === active.token) {
                active.state = {
                  ...parsed.data,
                  subtitles: [
                    ...parsed.data.subtitles.map((track) => ({
                      ...track,
                      name: track.name.replace(/^Track\s+(\d+)$/i, '字幕 $1'),
                    })),
                    ...active.tracks,
                  ],
                  subtitleIndex:
                    active.subtitleChoice === undefined
                      ? parsed.data.subtitleIndex
                      : active.subtitleChoice,
                }
                if (parsed.data.status === 'failed') this.fail(active, parsed.data.message)
              }
            }
          } catch {
            failed('VLC 返回的播放状态无效。')
          }
        })
      })
      if (!this.current(active)) {
        this.release(active)
        return null
      }
      this.send(active, {
        action: 'open',
        token: active.token,
        url: `http://127.0.0.1:${active.port}/${active.secret}/stream`,
        startSeconds: request.startSeconds,
        muted,
        bounds: clampVlcBounds(request.bounds, window),
      })
      return structuredClone(active.state)
    } catch (error) {
      if (!this.current(active)) return null
      this.close(active.token)
      throw new Error(error instanceof Error ? error.message : 'VLC 内嵌播放失败。')
    }
  }
  control(request: VlcControl, window: VlcWindow): void {
    const active = this.active
    if (!active || active.token !== request.token || active.state.status === 'failed')
      throw new Error('VLC 播放会话已失效。')
    if (request.action === 'bounds')
      this.send(active, { ...request, bounds: clampVlcBounds(request.bounds, window) })
    else if (request.action === 'seek')
      this.send(active, {
        ...request,
        seconds: Math.min(request.seconds, active.state.duration ?? request.seconds),
      })
    else if (request.action === 'subtitle') {
      if (
        request.index !== null &&
        !active.state.subtitles.some((track) => track.index === request.index)
      )
        throw new Error('VLC 字幕轨道不可用。')
      active.subtitleChoice = request.index
      const track = active.tracks.find((track) => track.index === request.index)
      if (request.index !== null && track)
        this.send(active, {
          action: 'subtitle-url',
          url: `http://127.0.0.1:${active.port}/${active.secret}/subtitles/${request.index - 100000}.${nativeSubtitleFormat(track.codec)}`,
        })
      else this.send(active, request)
    } else this.send(active, request)
  }
}
