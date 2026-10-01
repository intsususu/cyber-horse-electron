import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VlcPlayer, clampVlcBounds } from '../src/main/services/vlc-player'
import type { MediaPlayback } from '../src/main/services/media-playback'
import { vlcControlSchema, vlcOpenSchema } from '../src/shared/vlc-player'
import { defaultSettings, settingsSchema } from '../src/shared/contracts'

const roots: string[] = []
const players: VlcPlayer[] = []
afterEach(async () => {
  for (const player of players.splice(0)) player.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const bounds = { x: 200, y: 100, width: 800, height: 450, visible: true }
const window = { handle: '1234', width: 1480, height: 900, scale: 1 }
const request = () => ({
  requestId: randomUUID(),
  id: 'v1',
  sourceId: 's1',
  startSeconds: 0,
  bounds,
})
async function fixture(machine = 0x8664, codec = 'srt') {
  const root = await mkdtemp(join(tmpdir(), 'horse-vlc-test-'))
  roots.push(root)
  await mkdir(join(root, 'plugins'))
  await writeFile(join(root, 'libvlccore.dll'), '')
  await writeFile(join(root, 'host.exe'), '')
  const pe = Buffer.alloc(80)
  pe.writeUInt16LE(0x5a4d)
  pe.writeUInt32LE(64, 60)
  pe.writeUInt32LE(0x4550, 64)
  pe.writeUInt16LE(machine, 68)
  await writeFile(join(root, 'libvlc.dll'), pe)
  const mediaToken = randomUUID()
  const playback = {
    open: vi.fn(async () => ({
      token: mediaToken,
      url: `horse://app/media-playback/${mediaToken}/stream.avi`,
      subtitles: [{ index: 2, name: '中文', language: 'zho', codec, isText: true }],
    })),
    close: vi.fn(),
    response: vi.fn(
      async (_request: Request, _token: string) =>
        new Response('视频', {
          status: 206,
          headers: { 'content-type': 'video/x-msvideo', 'content-range': 'bytes 0-5/6' },
        }),
    ),
    subtitle: vi.fn(
      async (_token: string, _index: number, _format: string) => new Response('字幕'),
    ),
  }
  const commands: Record<string, unknown>[] = []
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    stdin: new Writable({
      write(chunk, _encoding, done) {
        for (const line of chunk.toString().trim().split('\n')) {
          const command = JSON.parse(line)
          commands.push(command)
          if (command.action === 'open')
            child.stdout!.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  type: 'state',
                  state: {
                    token: command.token,
                    status: 'playing',
                    position: 1,
                    duration: 90,
                    width: 320,
                    height: 180,
                    volume: 1,
                    muted: command.muted,
                    subtitles: [
                      { index: 0, name: '内置字幕', language: '', codec: 'vlc', isText: true },
                    ],
                    subtitleIndex: 0,
                    message: '',
                  },
                }) + '\n',
              ),
            )
          if (command.action === 'close') {
            Object.assign(child, { exitCode: 0 })
            child.emit('exit', 0)
          }
        }
        done()
      },
    }),
    kill: vi.fn(() => true),
  })
  const launch = vi.fn(() => {
    setTimeout(() => child.stdout!.emit('data', Buffer.from('{"type":"ready"}\n')), 1)
    return child
  })
  const player = new VlcPlayer(playback as unknown as MediaPlayback, {
    helper: join(root, 'host.exe'),
    directories: [root],
    platform: 'win32',
    launch,
  })
  players.push(player)
  return { root, player, playback, child, launch, commands }
}
describe('VLC 内嵌播放和边界保护', () => {
  it('旧配置默认关闭 VLC，新选择保存契约且拒绝任意路径和 URL', () => {
    const legacy = settingsSchema.parse({ ...defaultSettings, player: { startMuted: false } })
    expect(legacy.player).toEqual({ startMuted: false, useVlc: false })
    expect(
      settingsSchema.parse({ ...legacy, player: { ...legacy.player, useVlc: true } }).player.useVlc,
    ).toBe(true)
    expect(
      settingsSchema.safeParse({ ...legacy, player: { ...legacy.player, useVlc: '是' } }).success,
    ).toBe(false)
    expect(vlcOpenSchema.safeParse({ ...request(), url: 'http://other.invalid' }).success).toBe(
      false,
    )
    expect(
      vlcControlSchema.safeParse({ token: randomUUID(), action: 'seek', seconds: -1 }).success,
    ).toBe(false)
    expect(
      vlcControlSchema.safeParse({
        token: randomUUID(),
        action: 'bounds',
        bounds: { ...bounds, x: -1 },
      }).success,
    ).toBe(false)
  })
  it('拒绝缺失、32 位和非 Windows 引擎，不把检查当作实际播放成功', async () => {
    const f = await fixture(0x14c)
    expect((await f.player.availability()).available).toBe(false)
    await expect(f.player.open(request(), window, true)).rejects.toThrow('64 位')
    expect(f.launch).not.toHaveBeenCalled()
    const other = new VlcPlayer(f.playback as unknown as MediaPlayback, {
      helper: '',
      platform: 'linux',
    })
    expect((await other.availability()).message).toContain('Windows')
  })
  it('按缩放换算并限制在应用窗口内，不允许越界原生画面', () => {
    expect(
      clampVlcBounds(
        { ...bounds, x: 700, y: 500, width: 800, height: 800 },
        { ...window, scale: 2 },
      ),
    ).toMatchObject({ x: 1400, y: 900, width: 80, height: 0 })
  })
  it('仅通过限时回环代理读取视频，拒绝错误令牌、来源、URL、范围和写入请求', async () => {
    const f = await fixture()
    const r = request()
    expect(await f.player.open(r, window, true)).not.toBeNull()
    await vi.waitFor(() => expect(f.player.state(r.requestId)?.width).toBe(320))
    const command = f.commands.find((command) => command.action === 'open')!
    const url = command.url as string
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/stream$/)
    expect(f.playback.open).toHaveBeenCalledWith('v1', 's1', 0, false, true)
    expect(await (await fetch(url, { headers: { Range: 'bytes=0-5' } })).text()).toBe('视频')
    expect(f.playback.response.mock.calls[0]?.[0].headers.get('range')).toBe('bytes=0-5')
    expect(f.playback.response.mock.calls[0]?.[1]).not.toBe(r.requestId)
    expect((await fetch(url.replace('/stream', '/other'))).status).toBe(403)
    expect((await fetch(url, { headers: { Origin: 'https://other.invalid' } })).status).toBe(403)
    expect((await fetch(url, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${url}?token=other`)).status).toBe(403)
    expect(f.playback.response).toHaveBeenCalledOnce()
    f.player.close(r.requestId)
    expect(f.player.state(r.requestId)).toBeNull()
    await expect(fetch(url)).rejects.toThrow()
    expect(f.playback.close).toHaveBeenCalled()
    expect(f.commands.at(-1)?.action).toBe('close')
  })
  it('字幕白名单、定位限制、暂停和音量使用固定命令', async () => {
    const f = await fixture(),
      r = request()
    await f.player.open(r, window, true)
    await vi.waitFor(() => expect(f.player.state(r.requestId)?.status).toBe('playing'))
    f.player.control({ token: r.requestId, action: 'subtitle', index: 100002 }, window)
    expect(f.commands.at(-1)).toMatchObject({ action: 'subtitle-url' })
    expect((await fetch(f.commands.at(-1)!.url as string)).status).toBe(200)
    f.player.control({ token: r.requestId, action: 'subtitle', index: null }, window)
    expect(f.commands.at(-1)).toMatchObject({ action: 'subtitle', index: null })
    expect(() =>
      f.player.control({ token: r.requestId, action: 'subtitle', index: 123 }, window),
    ).toThrow('不可用')
    f.player.control({ token: r.requestId, action: 'seek', seconds: 500 }, window)
    expect(f.commands.at(-1)?.seconds).toBe(90)
    f.player.control({ token: r.requestId, action: 'pause', paused: true }, window)
    expect(f.commands.at(-1)).toMatchObject({ action: 'pause', paused: true })
    f.player.control({ token: r.requestId, action: 'audio', volume: 0.5, muted: false }, window)
    expect(f.commands.at(-1)).toMatchObject({ action: 'audio', volume: 0.5, muted: false })
  })
  for (const format of ['ass', 'ssa'])
    it(`${format.toUpperCase()} 服务器字幕保留样式格式，只允许当前轨道对应的后缀`, async () => {
      const f = await fixture(0x8664, format),
        r = request()
      await f.player.open(r, window, true)
      await vi.waitFor(() => expect(f.player.state(r.requestId)?.status).toBe('playing'))
      expect(
        f.player.state(r.requestId)?.subtitles.find((track) => track.index === 100002)?.name,
      ).toContain('保留样式')
      f.player.control({ token: r.requestId, action: 'subtitle', index: 100002 }, window)
      const url = f.commands.at(-1)!.url as string
      expect(url).toMatch(new RegExp(`\\.${format}$`))
      expect((await fetch(url)).status).toBe(200)
      expect(f.playback.subtitle).toHaveBeenCalledWith(expect.any(String), 2, format)
      expect((await fetch(url.replace(`.${format}`, '.vtt'))).status).toBe(403)
      expect((await fetch(url.replace('/2.', '/3.'))).status).toBe(403)
      expect((await fetch(url.replace(`.${format}`, '.exe'))).status).toBe(403)
      expect(f.playback.subtitle).toHaveBeenCalledOnce()
    })
  it('准备期间和 IPC 受理前取消都不启动进程，旧会话关闭不干扰新播放', async () => {
    const f = await fixture(),
      r = request()
    f.player.close(r.requestId)
    expect(await f.player.open(r, window, true)).toBeNull()
    expect(f.launch).not.toHaveBeenCalled()
    const pending = request(),
      work = f.player.open(pending, window, true)
    f.player.close(pending.requestId)
    expect(await work).toBeNull()
    expect(f.launch).not.toHaveBeenCalled()
    const current = request()
    await f.player.open(current, window, true)
    f.player.close(r.requestId)
    expect(f.player.state(current.requestId)).not.toBeNull()
  })
  it('原生进程异常退出释放流和窗口，保留中文失败状态供用户重试', async () => {
    const f = await fixture(),
      r = request()
    await f.player.open(r, window, true)
    f.child.emit('exit', 1)
    expect(f.player.state(r.requestId)).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('退出'),
    })
    expect(f.playback.close).toHaveBeenCalled()
  })
  it('原生引擎报告解码失败时也停止转发和宿主，不让后续旧状态覆盖失败', async () => {
    const f = await fixture(),
      r = request()
    await f.player.open(r, window, true)
    await vi.waitFor(() => expect(f.player.state(r.requestId)?.status).toBe('playing'))
    const previous = f.player.state(r.requestId)!
    f.child.stdout!.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'state',
          state: { ...previous, status: 'failed', message: '视频解码失败。' },
        }) + '\n',
      ),
    )
    expect(f.player.state(r.requestId)).toMatchObject({
      status: 'failed',
      message: '视频解码失败。',
    })
    expect(f.commands.at(-1)?.action).toBe('close')
    f.child.stdout!.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'state', state: previous }) + '\n'),
    )
    expect(f.player.state(r.requestId)?.status).toBe('failed')
  })
})
