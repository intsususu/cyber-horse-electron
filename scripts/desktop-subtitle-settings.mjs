import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function verifySubtitleSettings(app, page, output, checkLayout) {
  await page.getByRole('tab', { name: '字幕', exact: true }).click()
  await page.getByRole('button', { name: '点击预览 15 秒字幕视频' }).click()
  const previewPlayer = page.getByRole('region', { name: '字幕预览播放器' })
  await expect(previewPlayer).toBeVisible()
  await expect(previewPlayer.getByRole('alert')).toContainText('未找到字幕预览工具')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '点击预览 15 秒字幕视频' })).toBeFocused()
  await page.getByLabel('字体名称', { exact: true }).click()
  await page
    .getByRole('listbox', { name: '字幕字体', exact: true })
    .getByRole('option', { name: '楷体', exact: true })
    .click()
  await expect(page.locator('.subtitle-preview-text')).toHaveCSS('font-family', /KaiTi/)
  await page.getByLabel('字体名称', { exact: true }).press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('字体名称', { exact: true })).toBeFocused()
  await page.getByLabel('字号', { exact: true }).fill('64')
  await page.getByLabel('粗体', { exact: true }).uncheck()
  await page.getByLabel('斜体', { exact: true }).check()
  await expect(page.locator('.subtitle-preview-text')).toHaveText('午后的风，轻轻吹过窗边。')
  await expect(page.locator('.subtitle-preview-text')).toHaveCSS('font-size', '38.4px')
  await expect(page.locator('.subtitle-preview-text')).toHaveCSS('font-style', 'italic')
  await page.getByRole('button', { name: 'SRT', exact: true }).click()
  await expect(page.getByText(/SRT 不保存字体样式/)).toBeVisible()
  await page.getByRole('button', { name: 'ASS', exact: true }).click()
  await expect(page.getByLabel('字体名称', { exact: true })).toHaveValue('楷体')
  await page.getByLabel('字号', { exact: true }).fill('')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('请检查字幕样式')
  await page.getByLabel('字号', { exact: true }).fill('64')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.cyberHorse.getSettings())).settings.subtitle.fontSize,
    )
    .toBe(64)
  const saved = await page.evaluate(() => window.cyberHorse.getSettings())
  expect(saved.settings.subtitle).toMatchObject({
    fontName: 'KaiTi',
    fontSize: 64,
    bold: false,
    italic: true,
  })

  await page.getByRole('button', { name: '最大化或还原', exact: true }).click()
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
    .toBe(true)
  await checkLayout(page, '字幕样式-最大化')
  await page.screenshot({ path: join(output, '字幕样式-最大化.png'), scale: 'css' })
  await page.getByRole('button', { name: '最大化或还原', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 760))
  await checkLayout(page, '字幕样式-最小窗口')
  await page.getByRole('button', { name: '点击预览 15 秒字幕视频' }).focus()
  await page.locator('.subtitle-preview-stage').scrollIntoViewIfNeeded()
  await expect(page.locator('.subtitle-preview-text')).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: join(output, '字幕样式-最小窗口.png'), scale: 'css' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 900))
  await page.getByRole('button', { name: '钢铁侠主题', exact: true }).click()
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ironman')
    await checkLayout(page, `字幕样式-钢铁侠-系统切换-${colorScheme}`)
    await page.locator('.subtitle-preview-stage').scrollIntoViewIfNeeded()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: join(output, `字幕样式-钢铁侠-系统切换-${colorScheme}.png`),
      scale: 'css',
    })
  }
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await expect(page.getByLabel('字号', { exact: true })).toHaveValue('64')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve('test-results')
  await mkdir(output, { recursive: true })
  const profile = await mkdtemp(join(output, 'subtitle-profile-'))
  const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let app
  const errors = []
  const layouts = []
  const checkLayout = async (page, label) => {
    const overflow = await page.locator('.main-scroll').evaluate((node) => ({
      horizontal: node.scrollWidth - node.clientWidth,
      vertical: node.scrollHeight - node.clientHeight,
    }))
    expect(overflow.horizontal, label).toBeLessThanOrEqual(1)
    expect(overflow.vertical, label).toBeLessThanOrEqual(1)
    layouts.push({ label, ...overflow })
  }
  const launch = async () => {
    app = await electron.launch({ args: ['.'], env })
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: '偏好配置', exact: true }).click()
    await page.getByRole('tab', { name: '字幕', exact: true }).click()
    return page
  }
  try {
    let page = await launch()
    await expect(page.getByLabel('字体名称', { exact: true })).toHaveValue('微软雅黑')
    await expect(page.getByLabel('字号', { exact: true })).toHaveValue('56')
    await expect(page.getByLabel('描边宽度', { exact: true })).toHaveValue('3')
    await verifySubtitleSettings(app, page, output, checkLayout)
    for (const theme of ['浅色模式', '深色模式', '初号机主题', '钢铁侠主题']) {
      await page.getByRole('button', { name: theme, exact: true }).click()
      await page.locator('.subtitle-preview-stage').scrollIntoViewIfNeeded()
      await expect(page.locator('.subtitle-preview-text')).toBeInViewport({ ratio: 1 })
      await page.evaluate(() => document.fonts.ready)
      // 等待主题切换后的合成帧，避免截到字体尚未重绘的画面。
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
      await checkLayout(page, `字幕样式-${theme}`)
      await page.screenshot({
        path: join(output, `字幕样式-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
      await page.getByLabel('字体名称', { exact: true }).click()
      await expect(page.getByRole('listbox', { name: '字幕字体' })).toBeInViewport({ ratio: 1 })
      await page.screenshot({
        path: join(output, `字体下拉框-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
      await page.keyboard.press('Escape')
    }
    await closeDesktop(app)
    page = await launch()
    await expect(page.getByLabel('字体名称', { exact: true })).toHaveValue('楷体')
    await expect(page.getByLabel('字号', { exact: true })).toHaveValue('64')
    await expect(page.getByLabel('斜体', { exact: true })).toBeChecked()
    await page.getByRole('button', { name: '恢复默认样式', exact: true }).click()
    await expect(page.getByLabel('字号', { exact: true })).toHaveValue('56')
    await expect(page.getByLabel('字体名称', { exact: true })).toHaveValue('微软雅黑')
    await expect(page.getByLabel('粗体', { exact: true })).toBeChecked()
    await page.getByLabel('字体名称', { exact: true }).fill('我的自定义字体')
    await page.getByLabel('字体名称', { exact: true }).press('Tab')
    await expect(page.getByRole('listbox', { name: '字幕字体' })).toHaveCount(0)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.cyberHorse.getSettings())).settings.subtitle.fontName,
      )
      .toBe('我的自定义字体')
    expect(errors).toEqual([])
    await writeFile(
      join(output, 'subtitle-settings-result.json'),
      JSON.stringify({ result: '通过', errors, layouts }, null, 2),
    )
    console.log(
      '字幕页桌面验证通过：实时预览、样式保存、格式切换、输入校验、默认恢复、重启持久化、四种主题和窗口布局。',
    )
  } finally {
    await closeDesktop(app)
  }
}
