import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { createServer } from 'vite'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { playbackSample } from './fixtures/playback-sample.mjs'

// 通过 HTTP 加载相同渲染产物，覆盖开发页面与 horse 媒体协议不同源的真实浏览器行为。
const output = resolve('test-results')
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: false,
  root: resolve('out/renderer'),
  server: { host: '127.0.0.1', port: 0 },
})
let app
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
  const env = {
    ...process.env,
    ELECTRON_RENDERER_URL: origin,
    CYBER_HORSE_DATA_DIR: await mkdtemp(join(output, 'dev-playback-profile-')),
  }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', '--disable-background-timer-throttling'], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  expect(new URL(page.url()).origin).toBe(origin)
  const sample = await playbackSample(page)
  await app.evaluate((_, bytes) => {
    const sample = Buffer.from(bytes)
    const item = {
      Id: 'v1',
      Name: '开发模式字幕测试',
      MediaSources: [
        {
          Id: 's1',
          Container: 'webm',
          DefaultSubtitleStreamIndex: 2,
          MediaStreams: [
            { Type: 'Subtitle', Index: 2, Language: 'zho', Codec: 'srt', DisplayTitle: '中文' },
          ],
        },
      ],
    }
    globalThis.fetch = async (input, init) => {
      const path = new URL(input).pathname
      if (path.endsWith('/AuthenticateByName'))
        return Response.json({ AccessToken: 'fixture-token', User: { Id: 'u1' } })
      if (path.endsWith('/Views')) return Response.json({ Items: [{ Id: 'lib1', Name: '测试库' }] })
      if (path.endsWith('/Items')) return Response.json({ Items: [item], TotalRecordCount: 1 })
      if (path.endsWith('/Items/v1')) return Response.json(item)
      if (path.endsWith('/Similar')) return Response.json({ Items: [] })
      if (path.endsWith('/Stream.vtt'))
        return new Response('WEBVTT\n\n00:00:00.000 --> 00:01:30.000\n开发模式字幕已加载\n', {
          headers: { 'Content-Type': 'text/vtt' },
        })
      if (path.endsWith('/stream.webm')) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init.headers).get('range') || '')
        const start = range ? Number(range[1]) : 0
        const end = range?.[2] ? Number(range[2]) : sample.length - 1
        const headers = {
          'Content-Type': 'video/webm',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
        }
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${sample.length}`
        return new Response(sample.subarray(start, end + 1), { status: range ? 206 : 200, headers })
      }
      return new Response(null, { status: 404 })
    }
  }, Array.from(sample))
  await page.evaluate(async () => {
    const { settings } = await window.cyberHorse.getSettings()
    await window.cyberHorse.saveSettings({
      ...settings,
      mediaServer: {
        ...settings.mediaServer,
        serverUrl: 'http://media.invalid',
        username: '测试用户',
      },
    })
  })
  await page.getByRole('button', { name: 'EMBY媒体库', exact: true }).click()
  await page.locator('.media-card').first().click()
  await page.getByRole('button', { name: '播放视频', exact: true }).click()
  const video = page.locator('.media-video')
  await expect.poll(() => video.evaluate((v) => v.videoWidth)).toBe(320)
  await expect(page.locator('.media-player-subtitles')).toHaveText('开发模式字幕已加载')
  const trackUrl = await video.locator('track').getAttribute('src')
  // 只开放可信开发来源；其他网站不能读取播放响应。
  const headers = await app.evaluate(
    async ({ net }, { trackUrl, origin }) => {
      const allowed = await net.fetch(trackUrl, { headers: { Origin: origin } })
      const denied = await net.fetch(trackUrl, { headers: { Origin: 'https://untrusted.invalid' } })
      return [
        allowed.headers.get('access-control-allow-origin'),
        denied.headers.get('access-control-allow-origin'),
      ]
    },
    { trackUrl, origin },
  )
  expect(headers).toEqual([origin, null])
  await page.getByRole('button', { name: '选择字幕', exact: true }).click()
  await page.getByRole('option', { name: '字幕关闭', exact: true }).click()
  await expect(page.locator('.media-player-subtitles')).toHaveCount(0)
  await page.getByRole('button', { name: '选择字幕', exact: true }).click()
  await page.getByRole('option', { name: '中文', exact: true }).click()
  await expect(page.locator('.media-player-subtitles')).toHaveText('开发模式字幕已加载')
  await page.screenshot({ path: join(output, '开发模式-字幕播放.png'), scale: 'css' })
  await page.getByRole('button', { name: '返回详情', exact: true }).click()
  const legacySession = await page.evaluate(() =>
    window.cyberHorse.openMediaPlayback({
      id: 'v1',
      sourceId: 's1',
      startSeconds: 0,
      transcode: false,
    }),
  )
  delete legacySession.supportsCrossOrigin
  // 模拟仍在运行的旧后台：没有能力字段，也没有跨域响应头。
  await app.evaluate(
    ({ ipcMain, protocol }, { legacySession, bytes }) => {
      ipcMain.removeHandler('media:open-playback')
      ipcMain.handle('media:open-playback', () => legacySession)
      protocol.unhandle('horse')
      protocol.handle('horse', (request) => {
        globalThis.legacyMediaOrigin = request.headers.get('origin')
        return new Response(new Uint8Array(bytes), {
          headers: { 'Content-Type': 'video/webm', 'Content-Length': String(bytes.length) },
        })
      })
    },
    { legacySession, bytes: Array.from(sample) },
  )
  // 新页面使用旧后台协议处理器，避免复用上一页面已经绑定的协议工厂。
  await page.reload()
  await page.getByRole('button', { name: 'EMBY媒体库', exact: true }).click()
  await page.locator('.media-card').first().click()
  await page.getByRole('button', { name: '播放视频', exact: true }).click()
  await expect.poll(() => video.evaluate((v) => v.videoWidth)).toBe(320)
  expect(await video.getAttribute('crossorigin')).toBeNull()
  expect(await app.evaluate(() => globalThis.legacyMediaOrigin)).toBeNull()
  await expect(video.locator('track')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('完整退出并重新启动应用')
  await expect(page.getByRole('button', { name: '转码播放', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重试字幕', exact: true })).toHaveCount(0)
  await page.screenshot({ path: join(output, '开发模式-旧后台兼容.png'), scale: 'css' })
  console.log('开发模式播放验证通过：跨域视频解码、字幕加载与开关、可信来源限制。')
  console.log('旧后台兼容验证通过：视频继续播放，字幕明确提示重启，不误报解码失败。')
} finally {
  if (app) await closeDesktop(app)
  await server.close()
}
