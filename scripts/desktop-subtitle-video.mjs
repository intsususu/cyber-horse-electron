import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// 只使用已配置的工具生成内置片段，不读取用户媒体或连接媒体服务器。
const project = JSON.parse(await readFile('config/default-settings.json', 'utf8'))
const output = resolve('test-results')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'subtitle-video-profile-'))
const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
const errors = []
try {
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await page.getByRole('tab', { name: '字幕', exact: true }).click()
  const trigger = page.getByRole('button', { name: '点击预览 15 秒字幕视频' })
  const player = page.getByRole('region', { name: '字幕预览播放器' })
  await trigger.click()
  await expect(player).toBeVisible()
  await expect(player.getByRole('alert')).toContainText('未找到字幕预览工具', { timeout: 15000 })
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()

  await page.evaluate(
    async (paths) => {
      const result = await window.cyberHorse.getSettings()
      for (const key of ['jasna', 'whisper', 'mkvmerge']) result.settings.paths[key] = paths[key]
      await window.cyberHorse.saveSettings(result.settings)
    },
    {
      jasna: project.pathsAndTools.jasnaToolPath,
      whisper: project.pathsAndTools.whisperToolPath,
      mkvmerge: project.pathsAndTools.mkvToolNixPath,
    },
  )
  await page.getByLabel('字体名称', { exact: true }).click()
  await page.getByRole('option', { name: '楷体', exact: true }).click()
  await page.getByLabel('字号', { exact: true }).fill('64')
  await page.getByLabel('描边宽度', { exact: true }).fill('4')

  await trigger.click()
  await expect(player).toBeVisible()
  const panelBounds = await page.locator('.settings-page').boundingBox()
  const playerBounds = await player.boundingBox()
  expect(playerBounds.width).toBeCloseTo(panelBounds.width, 0)
  expect(playerBounds.height).toBeCloseTo(panelBounds.height, 0)
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).not.toBeVisible()
  const video = player.locator('video')
  await expect
    .poll(
      async () => {
        if (await player.getByRole('alert').count())
          throw new Error(await player.getByRole('alert').innerText())
        return video.count() ? video.evaluate((node) => node.readyState) : 0
      },
      { timeout: 75000 },
    )
    .toBeGreaterThanOrEqual(2)
  await expect.poll(() => video.evaluate((node) => node.currentTime)).toBeGreaterThan(0)
  expect(await video.evaluate((node) => node.duration)).toBeCloseTo(15, 1)
  expect(await video.evaluate((node) => [node.videoWidth, node.videoHeight])).toEqual([1280, 720])
  expect(
    await page.evaluate(
      async () => (await window.cyberHorse.getSettings()).settings.subtitle.fontName,
    ),
  ).toBe('Microsoft YaHei')
  await video.evaluate((node) => {
    node.pause()
    node.currentTime = 1
  })
  await expect.poll(() => video.evaluate((node) => !node.seeking)).toBe(true)
  for (const theme of ['初号机主题', '深色模式', '浅色模式', '钢铁侠主题']) {
    await page.getByRole('button', { name: theme, exact: true }).click()
    await player.getByRole('button', { name: '返回字幕设置', exact: true }).focus()
    await page.screenshot({ path: join(output, `字幕视频-${theme}.png`), scale: 'css' })
  }
  await video.evaluate((node) => {
    node.currentTime = 12
  })
  await expect.poll(() => video.evaluate((node) => !node.seeking)).toBe(true)
  await page.screenshot({ path: join(output, '字幕视频-第四句.png'), scale: 'css' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 760))
  await expect(player).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: join(output, '字幕视频-最小窗口.png'), scale: 'css' })
  await page.getByRole('button', { name: '最大化或还原', exact: true }).click()
  await expect(player).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: join(output, '字幕视频-最大化.png'), scale: 'css' })
  await player.getByRole('button', { name: '全屏', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  await player.getByRole('button', { name: '退出全屏', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  await expect(player).toBeVisible()
  await video.evaluate((node) => {
    node.currentTime = 14.7
    void node.play()
  })
  await expect.poll(() => video.evaluate((node) => node.ended)).toBe(true)
  await player.getByRole('button', { name: '继续播放', exact: true }).click()
  await expect.poll(() => video.evaluate((node) => node.currentTime)).toBeLessThan(5)
  await page.keyboard.press('Escape')
  await expect(player).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(page.getByLabel('字体名称', { exact: true })).toHaveValue('楷体')
  await expect(page.getByLabel('字号', { exact: true })).toHaveValue('64')
  await expect.poll(() => readdir(join(profile, 'subtitle-preview'))).toEqual([])

  await trigger.click()
  await player.getByRole('button', { name: '返回字幕设置', exact: true }).click()
  await expect(player).toHaveCount(0)
  await expect.poll(() => trigger.getAttribute('aria-disabled'), { timeout: 15000 }).toBe('false')
  await expect.poll(() => readdir(join(profile, 'subtitle-preview'))).toEqual([])
  expect(errors).toEqual([])
  await writeFile(
    join(output, 'subtitle-video-result.json'),
    JSON.stringify({ result: '通过', duration: 15, size: [1280, 720], errors }, null, 2),
  )
  console.log(
    '字幕视频实机验证通过：自动展开、真实 ASS 与楷体渲染、15 秒自动播放与重播、全屏、四主题和窗口尺寸、返回保留草稿、取消清理。',
  )
} finally {
  await closeDesktop(app)
}
