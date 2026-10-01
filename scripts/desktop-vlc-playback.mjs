import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { playbackSample } from './fixtures/playback-sample.mjs'
import { closeDesktop } from './fixtures/close-desktop.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// 使用合成视频与替身 Emby，实际加载本机 libVLC，不读取真实媒体和个人配置。
const output = resolve('test-results')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'vlc-profile-'))
const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
try {
  app = await electron.launch({ args: ['.', '--disable-background-timer-throttling'], env })
  const mainPid = await app.evaluate(() => process.pid)
  const hostCount = async () =>
    Number(
      (
        await promisify(execFile)(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid} AND Name='vlc-host.exe'").Count`,
          ],
          { windowsHide: true },
        )
      ).stdout.trim(),
    )
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  expect((await page.evaluate(() => window.cyberHorse.getVlcAvailability())).available).toBe(true)
  const sample = await playbackSample(page, { frameRate: 30 })
  await app.evaluate((_, bytes) => {
    const sample = Buffer.from(bytes)
    const item = {
      Id: 'v1',
      Name: 'VLC 内嵌播放验证',
      MediaSources: [
        {
          Id: 's1',
          Container: 'avi',
          MediaStreams: [
            { Type: 'Subtitle', Index: 2, Language: 'zho', Codec: 'srt', DisplayTitle: '中文' },
          ],
        },
      ],
    }
    globalThis.vlcFixtureRequests = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(input)
      const path = url.pathname
      globalThis.vlcFixtureRequests.push(path)
      if (path.endsWith('/AuthenticateByName'))
        return Response.json({ AccessToken: 'fixture-token', User: { Id: 'u1' } })
      if (path.endsWith('/Views')) return Response.json({ Items: [{ Id: 'lib1', Name: '测试库' }] })
      if (path.endsWith('/Items')) return Response.json({ Items: [item], TotalRecordCount: 1 })
      if (path.endsWith('/Items/v1')) return Response.json(item)
      if (path.endsWith('/Similar')) return Response.json({ Items: [] })
      if (path.endsWith('/Stream.vtt'))
        return new Response('WEBVTT\n\n00:00:00.000 --> 00:01:30.000\nVLC 服务器字幕验证\n', {
          headers: { 'Content-Type': 'text/vtt' },
        })
      if (path.endsWith('/stream.avi')) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get('range') || '')
        const start = range ? Number(range[1]) : 0
        const end = Math.min(range?.[2] ? Number(range[2]) : sample.length - 1, sample.length - 1)
        if (start > end) return new Response(null, { status: 416 })
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
  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await page.getByRole('tab', { name: '媒体服务器', exact: true }).click()
  const checkbox = page.getByRole('checkbox', { name: '使用 VLC 内嵌播放', exact: true })
  await expect(checkbox).not.toBeChecked()
  await checkbox.check()
  await page.getByRole('button', { name: '检测 VLC', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已检测到 64 位 VLC' })).toBeVisible()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.cyberHorse.getSettings()).settings.player.useVlc),
    )
    .toBe(true)
  await page.screenshot({ path: join(output, 'VLC-配置.png'), scale: 'css' })
  expect(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).player.useVlc).toBe(
    true,
  )
  await page.getByRole('button', { name: 'EMBY媒体库', exact: true }).click()
  await page.locator('.media-card').first().click()
  await page.getByRole('button', { name: '播放视频', exact: true }).click()
  const player = page.locator('.media-player-vlc')
  await expect(player).toHaveAttribute('data-vlc-width', '320')
  await expect(player).toHaveAttribute('data-vlc-status', 'playing')
  expect(await page.locator('video').count()).toBe(0)
  const token = await player.getAttribute('data-vlc-token')
  await expect
    .poll(() =>
      page.evaluate(
        async (token) => (await window.cyberHorse.getVlcPlayback(token)).embedded,
        token,
      ),
    )
    .toBe(true)
  await expect
    .poll(() =>
      page.evaluate(
        async (token) => (await window.cyberHorse.getVlcPlayback(token)).surfaceVisible,
        token,
      ),
    )
    .toBe(true)
  expect(await hostCount()).toBe(1)
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await expect(player).toHaveAttribute('data-vlc-status', 'paused')
  const timeline = page.getByRole('slider', { name: '播放进度', exact: true })
  await timeline.focus()
  await page.keyboard.press('Home')
  await expect(timeline).toHaveValue('0')
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => Math.round(Number(await timeline.inputValue()))).toBe(15)
  await page.getByRole('button', { name: '快进 15 秒', exact: true }).click()
  await expect.poll(async () => Math.round(Number(await timeline.inputValue()))).toBe(30)
  await expect
    .poll(() =>
      page.evaluate(
        async (token) => Math.round((await window.cyberHorse.getVlcPlayback(token)).position),
        token,
      ),
    )
    .toBe(30)
  await page.getByRole('button', { name: '取消静音', exact: true }).click()
  await expect(page.getByRole('button', { name: '静音', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '静音', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消静音', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await expect(player).toHaveAttribute('data-vlc-status', 'playing')
  await page.getByRole('button', { name: '选择字幕', exact: true }).click()
  await page.getByRole('option', { name: /^中文/ }).click()
  // 实际字幕由 VLC 解码并画入原生视频，而非浏览器覆盖层。
  await expect
    .poll(() =>
      app.evaluate(() =>
        globalThis.vlcFixtureRequests.some((path) => path.endsWith('/Stream.vtt')),
      ),
    )
    .toBe(true)
  await page.waitForTimeout(750)
  await expect(player).toHaveAttribute('data-vlc-status', 'playing')
  await expect
    .poll(() =>
      page.evaluate(
        async (token) =>
          (await window.cyberHorse.getVlcPlayback(token)).subtitles.some(
            (track) => track.index < 100000,
          ),
        token,
      ),
    )
    .toBe(true)
  for (const [name, width, height] of [
    ['默认', 1480, 900],
    ['最小', 1060, 760],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()[0].setSize(width, height),
      { width, height },
    )
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight))
      .toBe(true)
    const boxes = await Promise.all([
      player.boundingBox(),
      page.locator('.media-player-heading').boundingBox(),
      page.locator('.media-player-controls').boundingBox(),
      page.locator('.vlc-video-surface').boundingBox(),
    ])
    expect(boxes[1].y + boxes[1].height).toBeLessThanOrEqual(boxes[3].y + 1)
    expect(boxes[3].y + boxes[3].height).toBeLessThanOrEqual(boxes[2].y + 1)
    await page.screenshot({ path: join(output, `VLC-${name}-控件.png`), scale: 'css' })
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(output, 'VLC-最大化-控件.png'), scale: 'css' })
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setAlwaysOnTop(true)
    window.show()
    window.moveTop()
    window.focus()
  })
  await page.waitForTimeout(300)
  await expect
    .poll(() =>
      page.evaluate(
        async (token) => (await window.cyberHorse.getVlcPlayback(token)).surfaceOnTop,
        token,
      ),
    )
    .toBe(true)
  const videoRegion = await page.locator('.vlc-video-surface').boundingBox()
  const nativeImage = await app.evaluate(
    async ({ desktopCapturer, BrowserWindow, screen }, region) => {
      const window = BrowserWindow.getAllWindows()[0]
      const bounds = window.getBounds()
      const display = screen.getDisplayMatching(bounds)
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: display.size.width * display.scaleFactor,
          height: display.size.height * display.scaleFactor,
        },
      })
      const source = sources.find((source) => source.display_id === String(display.id))
      if (!source) return null
      // 仅返回测试应用窗口，不保留整屏或其他应用内容；原生 GPU 画面需从屏幕合成结果取样。
      const size = source.thumbnail.getSize()
      const scale = size.width / display.size.width
      const x = Math.max(0, Math.round((bounds.x - display.bounds.x) * scale))
      const y = Math.max(0, Math.round((bounds.y - display.bounds.y) * scale))
      const captured = source.thumbnail.crop({
        x,
        y,
        width: Math.min(size.width - x, Math.round(bounds.width * scale)),
        height: Math.min(size.height - y, Math.round(bounds.height * scale)),
      })
      // 验证合成视频的实际像素，防止只凭解码尺寸把黑屏误判为成功。
      const bitmap = captured.getBitmap()
      const capturedSize = captured.getSize()
      const pixel =
        (Math.round((region.y + region.height / 3) * scale) * capturedSize.width +
          Math.round((region.x + region.width / 4) * scale)) *
        4
      const painted = Math.max(...bitmap.subarray(pixel, pixel + 3)) > 25
      return { bytes: Array.from(captured.toPNG()), painted }
    },
    videoRegion,
  )
  expect(nativeImage?.painted).toBe(true)
  await writeFile(join(output, 'VLC-原生画面.png'), Buffer.from(nativeImage.bytes))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false))
  await page.getByRole('button', { name: '选择字幕', exact: true }).click()
  await page.getByRole('option', { name: '字幕关闭', exact: true }).click()
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(player).toHaveCount(0)
  expect(await page.evaluate((token) => window.cyberHorse.getVlcPlayback(token), token)).toBeNull()
  await expect.poll(hostCount).toBe(0)
  await expect(page.getByRole('button', { name: '播放视频', exact: true })).toBeFocused()
  // 清理后立即再开，再由侧栏离开，验证会话和原生窗口不会留在下一页面。
  await page.getByRole('button', { name: '播放视频', exact: true }).click()
  await expect(player).toHaveAttribute('data-vlc-width', '320')
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(player).toHaveCount(0)
  await expect.poll(hostCount).toBe(0)
  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await page.getByRole('tab', { name: '媒体服务器', exact: true }).click()
  await expect(checkbox).toBeChecked()
  await checkbox.uncheck()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.cyberHorse.getSettings()).settings.player.useVlc),
    )
    .toBe(false)
  console.log(
    'VLC 定向桌面验证通过：配置保存、真实引擎解码、暂停、跳转、静音、字幕、三种窗口尺寸、全屏退出和页面清理。',
  )
} catch (error) {
  if (app) {
    const page = await app.firstWindow()
    await page.screenshot({ path: join(output, 'VLC-失败.png'), scale: 'css' }).catch(() => {})
    console.error(await page.locator('.media-player-message').allTextContents())
  }
  throw error
} finally {
  if (app) await closeDesktop(app)
}
