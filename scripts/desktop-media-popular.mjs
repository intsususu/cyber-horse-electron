import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installPopularServer } from './fixtures/popular-server.mjs'

// 隔离配置与服务器响应，验证真实跨进程扫描、索引和媒体读取链路。
const output = resolve('test-results/media-popular')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'profile-'))
const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: ['.'], env })
const errors = []
const layouts = []
try {
  const page = await app.firstWindow()
  await installPopularServer(app)
  await page.getByRole('heading', { name: '工作台', exact: true }).waitFor()
  await page.evaluate(async () => {
    const { settings } = await window.cyberHorse.getSettings()
    settings.mediaServer.serverUrl = 'http://popular.invalid'
    settings.mediaServer.username = '测试用户'
    await window.cyberHorse.saveSettings(settings)
  })
  page.on('pageerror', (error) => errors.push(error.message))
  const nav = page.getByRole('navigation', { name: '主导航' })
  await expect(nav.getByRole('button')).toHaveText(['工作台', 'EMBY媒体库', '热门推荐'])
  await nav.getByRole('button', { name: '热门推荐', exact: true }).click()
  await expect(page.getByRole('heading', { name: '热门推荐', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '更新榜单', exact: true })).toBeEnabled({
    timeout: 15000,
  })
  await expect(page.getByRole('region', { name: '热门系列榜单' }).getByRole('button')).toHaveCount(
    15,
  )
  const seriesTab = page.getByRole('tab', { name: '热门系列', exact: true })
  const actorsTab = page.getByRole('tab', { name: '热门演员', exact: true })
  await expect(seriesTab).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.locator('.popular-series-card').first().locator('.media-cover img'),
  ).toHaveCount(4)
  const coverPaths = await app.evaluate(() => globalThis.popularImagePaths)
  expect(coverPaths).toContain('/Items/v1/Images/Primary')
  expect(coverPaths).toContain('/Items/v4/Images/Primary')
  await page.getByRole('button', { name: '隐藏热门封面', exact: true }).click()
  await expect(page.locator('.popular-series-art img')).toHaveCount(0)
  await page.getByRole('button', { name: '显示热门封面', exact: true }).click()
  await seriesTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(actorsTab).toBeFocused()
  await expect(actorsTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: '热门系列榜单' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '热门演员榜单' }).getByRole('button')).toHaveCount(
    15,
  )
  await expect(page.locator('.media-card')).toHaveCount(0)
  await expect(page.locator('[data-group-id="p1"] .popular-actor-avatar img')).toBeVisible()
  await expect(page.locator('[data-group-id="p3"] .popular-actor-avatar img')).toHaveCount(0)
  await page.getByRole('button', { name: '隐藏热门封面', exact: true }).click()
  await expect(page.locator('.popular-actor-avatar img')).toHaveCount(0)
  await page.getByRole('button', { name: '显示热门封面', exact: true }).click()
  await page.getByRole('button', { name: /陈序/ }).click()
  await expect(page.getByRole('heading', { name: '陈序', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '返回热门推荐', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '返回热门推荐', exact: true }).click()
  await expect(page.getByRole('button', { name: /陈序/ })).toBeFocused()
  await expect(actorsTab).toHaveAttribute('aria-selected', 'true')
  await seriesTab.click()
  await page.getByRole('button', { name: /一日之间/ }).click()
  await page.getByRole('button', { name: '返回热门推荐', exact: true }).click()
  await expect(page.getByRole('button', { name: /一日之间/ })).toBeFocused()
  expect(
    await page.getByLabel('系列排名', { exact: true }).evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0)
  const seriesScroll = await page
    .getByLabel('系列排名', { exact: true })
    .evaluate((el) => el.scrollTop)
  await actorsTab.click()
  await seriesTab.click()
  expect(await page.getByLabel('系列排名', { exact: true }).evaluate((el) => el.scrollTop)).toBe(
    seriesScroll,
  )
  await page.getByLabel('榜单统计说明', { exact: true }).click()
  await expect(page.getByText(/应用运行时每 6 小时更新/)).toBeVisible()
  await page.getByLabel('榜单统计说明', { exact: true }).click()
  await page.getByLabel('系列排名', { exact: true }).evaluate((el) => {
    el.scrollTop = 0
  })
  const themes = [
    ['eva', '初号机主题'],
    ['dark', '深色模式'],
    ['light', '浅色模式'],
    ['ironman', '钢铁侠主题'],
  ]
  for (const [theme, label] of themes) {
    await page.getByRole('button', { name: label, exact: true }).click()
    for (const size of ['default', 'minimum', 'maximized']) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        if (size === 'maximized') window.maximize()
        else window.setSize(...(size === 'minimum' ? [1060, 760] : [1480, 900]))
      }, size)
      await page.waitForTimeout(250)
      layouts.push({
        theme,
        size,
        ...(await page.evaluate(() => {
          const content = document.querySelector('.main-scroll')
          const panel = document.querySelector('.media-popular-page').getBoundingClientRect()
          const series = document.querySelector('.popular-series-grid')
          const card = series.querySelector('.popular-series-card').getBoundingClientRect()
          return {
            width: innerWidth,
            height: innerHeight,
            overflowX: content.scrollWidth - content.clientWidth,
            overflowY: content.scrollHeight - content.clientHeight,
            panelBottom: panel.bottom,
            seriesCardHeight: card.height,
            seriesViewportHeight: series.clientHeight,
            seriesColumns: getComputedStyle(series).gridTemplateColumns,
          }
        })),
      })
      await page.screenshot({ path: join(output, `${theme}-${size}.png`), animations: 'disabled' })
    }
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ironman')
  await page.screenshot({ path: join(output, 'ironman-system-change.png'), animations: 'disabled' })
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.unmaximize()
    window.setSize(1480, 900)
  })
  await page.getByRole('button', { name: '隐藏热门封面', exact: true }).click()
  await page.getByRole('button', { name: /01 山海之间/ }).click()
  await expect(page.getByText('封面已隐藏', { exact: true })).toHaveCount(30)
  await page.getByRole('button', { name: '加入日期', exact: true }).click()
  await expect(page.locator('.popular-video-grid .media-card-open').first()).toHaveAttribute(
    'aria-label',
    '查看详情：影片 31',
  )
  await page.getByRole('button', { name: '播放日期', exact: true }).click()
  await expect(page.locator('.popular-video-grid .media-card-open').first()).toHaveAttribute(
    'aria-label',
    '查看详情：影片 31',
  )
  await page.getByRole('button', { name: '播放次数', exact: true }).click()
  await expect(page.locator('.popular-video-grid .media-card-open').first()).toHaveAttribute(
    'aria-label',
    '查看详情：影片 01',
  )
  await page.getByRole('button', { name: '我的收藏', exact: true }).click()
  await expect(page.locator('.popular-video-grid .media-card')).toHaveCount(11)
  await page.getByRole('button', { name: '搜索当前关联视频', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索当前关联视频的名称' }).fill('影片 31')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('.popular-video-grid .media-card')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '查看详情：影片 31', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '搜索当前关联视频的名称' }).fill('影片 30')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByText('没有符合条件的视频', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await page.getByRole('button', { name: '关闭并清除搜索', exact: true }).click()
  await expect(page.locator('.popular-video-grid .media-card')).toHaveCount(30)
  for (const [theme, label] of themes) {
    await page.getByRole('button', { name: label, exact: true }).click()
    for (const [size, dimensions] of [
      ['minimum', [1060, 760]],
      ['default', [1480, 900]],
      ['maximized', [1920, 1032]],
    ]) {
      await app.evaluate(({ BrowserWindow }, dimensions) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        window.setSize(...dimensions)
      }, dimensions)
      await page.waitForTimeout(150)
      await page.screenshot({
        path: join(output, `list-${theme}-${size}.png`),
        animations: 'disabled',
      })
      const bounds = await page.evaluate(() => {
        const el = document.querySelector('.main-scroll')
        return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight }
      })
      expect(bounds).toEqual({ x: 0, y: 0 })
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 900))
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.getByText('封面已隐藏', { exact: true })).toHaveCount(31)
  await page.screenshot({ path: join(output, 'series-videos-dark.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '查看详情：影片 01', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: '影片 01', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '返回', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: /^选择媒体库：/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开 Emby 视频详情', exact: true })).toBeEnabled()
  await page.screenshot({ path: join(output, 'detail-hidden.png'), animations: 'disabled' })
  for (const [theme, label] of themes) {
    await page.getByRole('button', { name: label, exact: true }).click()
    for (const size of ['default', 'minimum', 'maximized']) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        if (size === 'maximized') window.maximize()
        else window.setSize(...(size === 'minimum' ? [1060, 760] : [1480, 900]))
      }, size)
      await page.waitForTimeout(150)
      await page.screenshot({
        path: join(output, `detail-${theme}-${size}.png`),
        animations: 'disabled',
      })
    }
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.unmaximize()
    window.setSize(1480, 900)
  })
  const media = page.getByRole('region', { name: 'Emby 媒体库', exact: true })
  // 热门直接详情没有媒体墙历史；首个库为空，不能用首库代替全部范围。
  await app.evaluate(() => {
    globalThis.popularFilterFailure = true
  })
  await media.getByRole('button', { name: '剧情', exact: true }).click()
  await expect(media.locator('.media-error')).toBeVisible()
  await app.evaluate(() => {
    globalThis.popularFilterFailure = false
  })
  await media.getByRole('button', { name: '重试', exact: true }).click()
  await expect(media.locator('.media-grid .media-card')).toHaveCount(16)
  await media.getByRole('button', { name: '返回', exact: true }).click()
  for (const [theme, label] of themes) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await media.getByRole('button', { name: '剧情', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(media.getByRole('button', { name: '类型：剧情 ×', exact: true })).toBeVisible()
    await expect(
      media.getByRole('button', { name: '选择媒体库：全部媒体库', exact: true }),
    ).toBeVisible()
    await expect(media.locator('.media-grid .media-card')).toHaveCount(16)
    const query = await app.evaluate(() => globalThis.popularMediaQueries.at(-1))
    expect(query.Genres).toBe('剧情')
    expect(query.ParentId).toBeUndefined()
    await page.screenshot({
      path: join(output, `genre-filter-${theme}.png`),
      animations: 'disabled',
    })
    await media.getByRole('button', { name: '返回', exact: true }).click()
    await expect(media.getByRole('heading', { name: '影片 01', exact: true })).toBeVisible()
  }
  await media.getByRole('button', { name: '剧情', exact: true }).click()
  await media.getByRole('button', { name: '刷新媒体库', exact: true }).click()
  await expect(media.locator('.media-grid .media-card')).toHaveCount(16)
  await expect(media.getByRole('button', { name: '类型：剧情 ×', exact: true })).toBeVisible()
  await media.getByRole('button', { name: '搜索当前媒体库', exact: true }).click()
  await expect(media.getByText('搜索范围：全部媒体库', { exact: true })).toBeVisible()
  await media.getByRole('searchbox', { name: '搜索媒体关键词', exact: true }).fill('影片 31')
  await media.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(media.locator('.media-grid .media-card')).toHaveCount(1)
  await expect(media.getByRole('button', { name: '查看详情：影片 31', exact: true })).toBeVisible()
  await media.getByRole('button', { name: '返回', exact: true }).click()
  await expect(media.locator('.media-grid .media-card')).toHaveCount(16)
  await media.getByRole('button', { name: '返回', exact: true }).click()
  await media.getByRole('button', { name: '林遥', exact: true }).click()
  await expect(media.getByRole('button', { name: '演职人员：林遥 ×', exact: true })).toBeVisible()
  await expect(media.locator('.media-grid .media-card')).toHaveCount(30)
  const personQuery = await app.evaluate(() => globalThis.popularMediaQueries.at(-1))
  expect(personQuery.PersonIds).toBe('p1')
  expect(personQuery.ParentId).toBeUndefined()
  await media.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(media.locator('.media-grid .media-card')).toHaveCount(31)
  await media.getByRole('button', { name: '查看详情：影片 02', exact: true }).click()
  await expect(media.getByRole('heading', { name: '影片 02', exact: true })).toBeVisible()
  await media.getByRole('button', { name: '返回', exact: true }).click()
  await expect(media.getByRole('button', { name: '演职人员：林遥 ×', exact: true })).toBeVisible()
  await expect(media.locator('.media-grid .media-card')).toHaveCount(31)
  await media.getByRole('button', { name: '返回', exact: true }).click()
  await expect(media.getByRole('heading', { name: '影片 01', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '查看详情：影片 01', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '显示热门封面', exact: true }).click()
  await page.getByRole('button', { name: '返回热门推荐', exact: true }).click()
  await actorsTab.click()
  await page.screenshot({ path: join(output, 'actors-home-dark.png'), animations: 'disabled' })
  for (const [theme, label] of themes) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    for (const [size, dimensions] of [
      ['default', [1480, 900]],
      ['minimum', [1060, 760]],
    ]) {
      await app.evaluate(({ BrowserWindow }, dimensions) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        window.setSize(...dimensions)
      }, dimensions)
      await page.waitForTimeout(150)
      await page.screenshot({
        path: join(output, `actors-home-${theme}-${size}.png`),
        animations: 'disabled',
      })
    }
  }
  await page.getByRole('button', { name: /01 林遥/ }).click()
  await page.getByRole('button', { name: '查看详情：影片 01', exact: true }).click()
  await media.getByRole('button', { name: '林遥', exact: true }).click()
  await expect(media.getByRole('button', { name: '演职人员：林遥 ×', exact: true })).toBeVisible()
  await media.getByRole('button', { name: '返回', exact: true }).click()
  await media.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.getByRole('button', { name: '查看详情：影片 01', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await page.screenshot({ path: join(output, 'actors-light.png'), animations: 'disabled' })
  await expect.poll(() => app.evaluate(() => globalThis.popularImageRequests)).toBeGreaterThan(0)
  await nav.getByRole('button', { name: 'EMBY媒体库', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'EMBY媒体库', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '刷新媒体库', exact: true })).toBeVisible()
  await media.getByRole('button', { name: '选择媒体库：空媒体库', exact: true }).click()
  await page.getByRole('option', { name: '隔离媒体库', exact: true }).click()
  await media.getByRole('button', { name: '查看详情：影片 01', exact: true }).click()
  await media.getByRole('button', { name: '剧情', exact: true }).click()
  await expect(media.locator('.media-grid .media-card')).toHaveCount(16)
  expect((await app.evaluate(() => globalThis.popularMediaQueries.at(-1))).ParentId).toBe('lib2')
  await expect(page.getByText('静态预览', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
  await writeFile(join(output, 'result.json'), JSON.stringify({ errors, layouts }, null, 2) + '\n')
  console.log(
    '热门分类、关联筛选、详情类型与人员跳转、全部及单库范围、分页、失败重试和逐级返回验证通过；四种主题与三种窗口截图已保存。',
  )
} finally {
  await closeDesktop(app)
}
