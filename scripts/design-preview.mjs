import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// 独立预览配置和文本样本，不读取或改写用户媒体与日常配置。
const output = resolve('test-results')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'design-preview-'))
const media = join(profile, '预处理目录')
const download = join(profile, '下载目录')
await mkdir(media)
await mkdir(download)
await writeFile(join(download, '待整理.mp4'), '预处理演示文本样本，不是真实视频。')
for (const name of ['示例视频 A.mp4', '示例视频 B.mkv', '示例视频 C.mov', '示例视频 D.mp4'])
  await writeFile(join(media, name), '界面验证文本样本，不是真实视频。')
const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: ['.'], env })
let keepOpen = false
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  await page.evaluate(
    async ({ media, download }) => {
      const { settings } = await window.cyberHorse.getSettings()
      await window.cyberHorse.saveSettings({
        ...settings,
        theme: 'eva',
        paths: { ...settings.paths, preprocess: media, download },
      })
    },
    { media, download },
  )
  await page.reload()
  await expect(page.locator('.input-file-row')).toHaveCount(4)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1608, 978),
  )
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(1600)
  // Windows 缩放可能让无边框窗口少一个逻辑像素，按实际视口补偿。
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  if (viewport.width !== 1608 || viewport.height !== 978)
    await app.evaluate(({ BrowserWindow }, viewport) => {
      BrowserWindow.getAllWindows()[0].setContentSize(3216 - viewport.width, 1956 - viewport.height)
    }, viewport)
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1608, 978])
  await page.screenshot({
    path: join(output, '工作台-初号机-设计对照.png'),
    scale: 'css',
    animations: 'disabled',
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 900))
  await page.screenshot({
    path: join(output, '工作台-初号机-效果.png'),
    scale: 'css',
    animations: 'disabled',
  })
  await page.locator('.step-selection').filter({ hasText: '字幕与封装' }).click()
  await page.locator('.step-selection').filter({ hasText: '元数据刮削' }).click()
  await expect(page.getByRole('button', { name: '运行所选 2 步', exact: true })).toBeEnabled()
  await page.getByRole('checkbox', { name: '勾选 示例视频 C.mov', exact: true }).uncheck()
  await page.getByRole('checkbox', { name: '勾选 示例视频 D.mp4', exact: true }).uncheck()
  await page.screenshot({
    path: join(output, '工作台-初号机-步骤选择.png'),
    scale: 'css',
    animations: 'disabled',
  })
  await writeFile(
    join(output, 'design-preview-result.json'),
    JSON.stringify({ profile, errors }, null, 2),
  )
  expect(errors).toEqual([])
  console.log('设计对照截图已保存，使用隔离配置与四个文本样本，性能数据来自本机。')
  keepOpen = process.argv.includes('--keep-open')
  if (keepOpen) await new Promise((resolve) => app.once('close', resolve))
} finally {
  if (!keepOpen) await closeDesktop(app)
}
