import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// 只切换主题与窗口，使用隔离配置和文本样本，不运行媒体处理或关机。
const output = resolve('test-results/themes')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'profile-'))
const media = join(profile, '预处理')
await mkdir(media)
for (const name of ['示例视频 A.mp4', '示例视频 B.mkv'])
  await writeFile(join(media, name), '界面验证文本样本，不是真实媒体。')
const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const themes = [
  ['light', '浅色模式'],
  ['dark', '深色模式'],
  ['eva', '初号机主题'],
  ['ironman', '钢铁侠主题'],
]
const errors = []
const layouts = []
let app
try {
  app = await electron.launch({ args: ['.'], env })
  let page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  await page.evaluate(async (media) => {
    const { settings } = await window.cyberHorse.getSettings()
    await window.cyberHorse.saveSettings({
      ...settings,
      paths: { ...settings.paths, preprocess: media },
    })
  }, media)
  await page.reload()
  await expect(page.locator('.input-file-row')).toHaveCount(2)
  const picker = page.getByRole('group', { name: '外观模式' })
  expect(
    await picker
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
  ).toEqual(themes.map(([, label]) => label))
  await expect(page.getByRole('button', { name: '跟随系统', exact: true })).toHaveCount(0)
  for (const [theme, label] of themes) {
    const choice = picker.getByRole('button', { name: label, exact: true })
    await choice.focus()
    await page.keyboard.press('Enter')
    await expect(choice).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect
      .poll(async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).theme)
      .toBe(theme)
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    }
    for (const size of ['默认', '最小', '最大化']) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        if (size === '最大化') window.maximize()
        else window.setSize(...(size === '最小' ? [1060, 760] : [1480, 900]))
      }, size)
      for (const name of ['工作台', '任务队列', '偏好配置']) {
        await page.getByRole('button', { name, exact: true }).click()
        await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        )
        const layout = await page.evaluate(() => {
          const main = document.querySelector('.main-scroll')
          return {
            horizontal: main.scrollWidth - main.clientWidth,
            vertical: main.scrollHeight - main.clientHeight,
          }
        })
        expect(layout.horizontal).toBeLessThanOrEqual(1)
        expect(layout.vertical).toBeLessThanOrEqual(1)
        layouts.push({ theme, size, page: name, ...layout })
        await page.screenshot({
          path: join(output, `${theme}-${size}-${name}.png`),
          scale: 'css',
          animations: 'disabled',
        })
        if (size === '默认' && name === '工作台') {
          await page.getByRole('checkbox', { name: '勾选 示例视频 A.mp4', exact: true }).uncheck()
          await expect(page.getByRole('checkbox', { name: '全选文件', exact: true })).toBeChecked({
            indeterminate: true,
          })
          await page.getByRole('checkbox', { name: '含子目录', exact: true }).focus()
          await page.keyboard.press('Shift+Tab')
          await page.keyboard.press('Tab')
          await expect(page.getByRole('checkbox', { name: '含子目录', exact: true })).toBeFocused()
          await page.screenshot({
            path: join(output, `${theme}-勾选与键盘焦点.png`),
            scale: 'css',
            animations: 'disabled',
          })
          await page.getByRole('checkbox', { name: '全选文件', exact: true }).check()
          await expect(page.locator('.input-file-row input:checked')).toHaveCount(2)
        }
        if (size === '默认' && name === '偏好配置') {
          await page.getByRole('tab', { name: '字幕', exact: true }).click()
          await page.getByLabel('字体名称', { exact: true }).click()
          await expect(page.getByRole('listbox', { name: '字幕字体' })).toBeVisible()
          await page.screenshot({
            path: join(output, `${theme}-下拉选中与设置勾选.png`),
            scale: 'css',
            animations: 'disabled',
          })
          await page.keyboard.press('Escape')
          await page.getByRole('tab', { name: '路径与工具', exact: true }).click()
        }
      }
    }
  }
  await closeDesktop(app)
  app = await electron.launch({ args: ['.'], env })
  page = await app.firstWindow()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ironman')
  await expect(page.getByRole('button', { name: '钢铁侠主题', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(errors).toEqual([])
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ layouts, errors, restartTheme: 'ironman' }, null, 2),
  )
  console.log(
    '主题专项通过：四主题顺序、键盘切换、即时保存、系统配色独立、钢铁侠重启恢复及 36 个窗口布局检查。',
  )
} finally {
  await closeDesktop(app)
}
