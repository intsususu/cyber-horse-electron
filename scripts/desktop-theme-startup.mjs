import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const output = resolve('test-results/theme-startup')
await mkdir(output, { recursive: true })
const results = []
let savedSettings
for (const theme of ['首次启动', 'light', 'dark', 'eva', 'ironman', '损坏配置']) {
  const profile = await mkdtemp(join(output, 'profile-'))
  if (theme === '损坏配置') await writeFile(join(profile, 'settings.json'), '{损坏配置')
  else if (savedSettings)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...savedSettings, theme }))
  const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({ args: ['scripts/fixtures/theme-startup.cjs'], env })
  try {
    const page = await app.firstWindow()
    const expected = ['首次启动', '损坏配置'].includes(theme) ? 'eva' : theme
    await expect(page.locator('html')).toHaveAttribute('data-theme', expected)
    await expect
      .poll(() => app.evaluate(() => globalThis.themeStartupProbe.shows[0]?.theme))
      .toBe(expected)
    const probe = await app.evaluate(() => globalThis.themeStartupProbe)
    expect(probe.shows).toHaveLength(1)
    expect(probe.shows[0].configured).toBe(true)
    expect(probe.shows[0].background).not.toBe('rgba(0, 0, 0, 0)')
    if (!savedSettings)
      savedSettings = await page.evaluate(
        async () => (await window.cyberHorse.getSettings()).settings,
      )
    if (theme === '损坏配置') await expect(page.getByRole('status')).toContainText('配置无法读取')
    await page.screenshot({
      path: join(output, `${theme}.png`),
      scale: 'css',
      animations: 'disabled',
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await page.evaluate(() => window.cyberHorse.windowReady())
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
    ).toBe(true)
    results.push({ theme, ...probe })
  } finally {
    await closeDesktop(app)
  }
}
await writeFile(join(output, 'result.json'), JSON.stringify(results, null, 2))
console.log(
  '主题启动验证通过：慢配置首次显示、新配置初号机、四主题恢复、坏配置回退、重复就绪不唤回最小化窗口。',
)
