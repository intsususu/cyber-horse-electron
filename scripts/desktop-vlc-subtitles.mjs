import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { playbackSample } from './fixtures/playback-sample.mjs'
import { closeDesktop } from './fixtures/close-desktop.mjs'

// 只验证字幕格式与实际原生渲染，使用合成视频、隔离配置和替身服务器。
const profile = await mkdtemp(resolve('test-results/vlc-subtitles-'))
const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const styled = `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,KaiTi,22,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:01:30.00,Default,,0,0,0,,VLC 楷体样式验证
`
let app
try {
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  const sample = await playbackSample(page, { frameRate: 30 })
  await app.evaluate(
    (_, { bytes, styled }) => {
      const sample = Buffer.from(bytes)
      globalThis.vlcSubtitleRequests = []
      globalThis.fetch = async (input, init) => {
        const path = new URL(input).pathname
        globalThis.vlcSubtitleRequests.push(path)
        if (path.endsWith('/AuthenticateByName'))
          return Response.json({ AccessToken: 'fixture-token', User: { Id: 'u1' } })
        if (path.endsWith('/Items/v1'))
          return Response.json({
            Id: 'v1',
            Name: '字幕样式验证',
            MediaSources: [
              {
                Id: 's1',
                Container: 'webm',
                MediaStreams: [
                  {
                    Type: 'Subtitle',
                    Index: 2,
                    Language: 'zho',
                    Codec: 'ass',
                    DisplayTitle: '中文楷体',
                  },
                ],
              },
            ],
          })
        if (path.endsWith('/Stream.ass'))
          return new Response(styled, { headers: { 'Content-Type': 'text/plain' } })
        if (path.endsWith('/stream.webm')) {
          const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get('range') || '')
          const start = range ? Number(range[1]) : 0
          const end = Math.min(range?.[2] ? Number(range[2]) : sample.length - 1, sample.length - 1)
          if (start > end) return new Response(null, { status: 416 })
          const headers = {
            'Content-Type': 'video/webm',
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
          }
          if (range) headers['Content-Range'] = `bytes ${start}-${end}/${sample.length}`
          return new Response(sample.subarray(start, end + 1), {
            status: range ? 206 : 200,
            headers,
          })
        }
        return new Response(null, { status: 404 })
      }
    },
    { bytes: Array.from(sample), styled },
  )
  await page.evaluate(async () => {
    const { settings } = await window.cyberHorse.getSettings()
    await window.cyberHorse.saveSettings({
      ...settings,
      player: { ...settings.player, useVlc: true },
      mediaServer: {
        ...settings.mediaServer,
        serverUrl: 'http://media.invalid',
        username: '测试用户',
      },
    })
  })
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.restore()
    window.show()
    window.setBounds({ x: 40, y: 40, width: 1200, height: 800 })
    window.setAlwaysOnTop(true)
    window.moveTop()
    window.focus()
  })
  const token = randomUUID()
  await page.evaluate((request) => window.cyberHorse.openVlcPlayback(request), {
    requestId: token,
    id: 'v1',
    sourceId: 's1',
    startSeconds: 0,
    bounds: { x: 220, y: 130, width: 960, height: 540, visible: true },
  })
  const state = () => page.evaluate((token) => window.cyberHorse.getVlcPlayback(token), token)
  await expect.poll(async () => (await state())?.width).toBe(320)
  await page.evaluate(
    (token) => window.cyberHorse.controlVlcPlayback({ token, action: 'subtitle', index: 100002 }),
    token,
  )
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.vlcSubtitleRequests.some((path) => path.endsWith('/Stream.ass')),
      ),
    )
    .toBe(true)
  await expect
    .poll(async () => (await state())?.subtitles.some((track) => track.index < 100000))
    .toBe(true)
  expect(
    await app.evaluate(() =>
      globalThis.vlcSubtitleRequests.some((path) => path.endsWith('/Stream.vtt')),
    ),
  ).toBe(false)
  await page.waitForTimeout(700)
  const capture = async () =>
    app.evaluate(
      async ({ desktopCapturer, BrowserWindow, screen }, rect) => {
        const display = screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds())
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            width: display.size.width * display.scaleFactor,
            height: display.size.height * display.scaleFactor,
          },
        })
        const source = sources.find((source) => source.display_id === String(display.id))
        const scale = source.thumbnail.getSize().width / display.size.width
        const picture = source.thumbnail.crop({
          x: Math.round(rect.x - display.bounds.x * scale),
          y: Math.round(rect.y - display.bounds.y * scale),
          width: rect.width,
          height: rect.height,
        })
        const bitmap = picture.getBitmap()
        const size = picture.getSize()
        let yellow = 0
        // 合成画面无黄色；下半部黄色像素来自 ASS 指定的字体颜色。
        for (let y = Math.floor(size.height / 2); y < size.height; y++)
          for (let x = 0; x < size.width; x++) {
            const p = (y * size.width + x) * 4
            if (bitmap[p] < 90 && bitmap[p + 1] > 150 && bitmap[p + 2] > 150) yellow++
          }
        return { yellow, bytes: Array.from(picture.toPNG()) }
      },
      (await state()).surfaceBounds,
    )
  let image
  await expect
    .poll(
      async () => {
        image = await capture()
        return image.yellow
      },
      { timeout: 10000 },
    )
    .toBeGreaterThan(100)
  await writeFile(resolve('test-results/VLC-ASS-楷体样式.png'), Buffer.from(image.bytes))
  await page.evaluate(
    (token) => window.cyberHorse.controlVlcPlayback({ token, action: 'subtitle', index: null }),
    token,
  )
  await expect.poll(async () => (await capture()).yellow).toBe(0)
  await page.evaluate((token) => window.cyberHorse.closeVlcPlayback(token), token)
  expect(await state()).toBeNull()
  console.log('VLC 字幕定向验证通过：ASS 原格式传输、原生楷体与颜色、关闭字幕和会话清理。')
} finally {
  if (app) await closeDesktop(app)
}
