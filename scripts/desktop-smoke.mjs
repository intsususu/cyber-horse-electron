import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rename, utimes, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { verifyEnvironmentRecovery, verifyInitialEnvironment } from './desktop-environment.mjs'
import { verifyPreparation } from './desktop-preparation.mjs'
import { verifyPipeline } from './desktop-pipeline.mjs'
import { verifyMediaLibrary } from './desktop-media-library.mjs'
import { verifySingleInstance } from './desktop-single-instance.mjs'

const output = resolve('test-results')
await mkdir(output, { recursive: true })
const dataDirectory = await mkdtemp(join(output, 'desktop-profile-'))
const errors = []
const layouts = []
const pages = ['工作台', 'EMBY媒体库', '任务队列', '偏好配置']
const environment = { ...process.env, CYBER_HORSE_DATA_DIR: dataDirectory }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.ELECTRON_RENDERER_URL
let app
let performanceSample
async function launch() {
  // 计时演示验证不受其他桌面窗口遮挡后的后台节流影响，生产启动不带此参数。
  app = await electron.launch({
    args: ['.', '--disable-background-timer-throttling'],
    env: environment,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button')).toHaveCount(2)
  await expect(page.getByRole('navigation', { name: '底部导航' }).getByRole('button')).toHaveText([
    '任务队列',
    '偏好配置',
  ])
  await expect(page.getByRole('button', { name: '标准流程', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '特殊任务', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '深色模式', exact: true })).toBeEnabled()
  return page
}
async function checkLayout(page, label) {
  const layout = await page.evaluate(() => {
    const main = document.querySelector('.main-scroll')
    const content = document.querySelector('.page-content')
    const bounds = main.getBoundingClientRect()
    const statusbar = document.querySelector('.app-statusbar').getBoundingClientRect()
    const panels = [
      ...document.querySelectorAll('.workspace-body .panel, .workspace-body.panel'),
    ].filter((node) => node.getClientRects().length)
    const flow = document.querySelector('.flow-list, .workbench-steps')
    const body = [...document.querySelectorAll('.workspace-body')].find(
      (node) => node.getClientRects().length,
    )
    return {
      width: innerWidth,
      height: innerHeight,
      horizontalOverflow: main.scrollWidth - main.clientWidth,
      verticalOverflow: main.scrollHeight - main.clientHeight,
      contentOverflow: content.scrollHeight - content.clientHeight,
      flowOverflow: flow ? flow.scrollHeight - flow.clientHeight : 0,
      pageBottomInset: parseFloat(getComputedStyle(content).paddingBottom),
      bodyBottomGap: body ? bounds.bottom - body.getBoundingClientRect().bottom : null,
      statusbarBottomGap: innerHeight - statusbar.bottom,
      statusbarOverlap: bounds.bottom - statusbar.top,
      clippedPanels: panels
        .filter((panel) => {
          const rect = panel.getBoundingClientRect()
          return (
            rect.bottom > bounds.bottom + 1 || rect.right > bounds.right + 1 || rect.height < 40
          )
        })
        .map((panel) => panel.className),
    }
  })
  layouts.push({ label, ...layout })
  expect(layout.horizontalOverflow, label).toBeLessThanOrEqual(1)
  expect(layout.verticalOverflow, label).toBeLessThanOrEqual(1)
  expect(layout.contentOverflow, label).toBeLessThanOrEqual(1)
  expect(layout.flowOverflow, label).toBeLessThanOrEqual(1)
  expect(layout.clippedPanels, label).toEqual([])
  expect(Math.abs(layout.statusbarBottomGap), label).toBeLessThanOrEqual(1)
  expect(layout.statusbarOverlap, label).toBeLessThanOrEqual(1)
  await expect(page.getByRole('contentinfo', { name: '应用状态栏' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '查看网络性能' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^查看目录与工具检测/ })).toBeVisible()
}
try {
  let page = await launch()
  await verifySingleInstance(app, environment)
  await verifyInitialEnvironment(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eva')
  const security = await app.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    }
  })
  expect(security).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined')
  expect(await page.evaluate(() => Object.keys(window.cyberHorse).sort())).toEqual(
    [
      'getMediaLibraries',
      'getMediaPage',
      'getMediaDetail',
      'getMediaSimilar',
      'getMediaImage',
      'openMediaLink',
      'openMediaPlayback',
      'closeMediaPlayback',
      'reportMediaPlaybackError',
      'setMediaFavorite',
      'refreshMediaItem',
      'deleteMediaItem',
      'startMediaDownload',
      'getMediaDownloads',
      'cancelMediaDownload',
      'previewMediaProcess',
      'startMediaProcess',
      'enqueueMediaProcess',
      'getMediaProcesses',
      'getMediaQueueSummary',
      'cancelMediaProcess',
      'clearMediaTasks',
      'previewPreparation',
      'startPreparation',
      'getPreparationState',
      'cancelPreparation',
      'previewPipeline',
      'startPipeline',
      'getPipelineState',
      'cancelPipeline',
      'checkPaths',
      'choosePreferencePath',
      'choosePath',
      'chooseInputs',
      'refreshInputs',
      'openWorkDirectory',
      'getPerformance',
      'getCredentialStatus',
      'getSettings',
      'getSettingsLocation',
      'openSettingsFile',
      'onSettingsChanged',
      'saveCredential',
      'saveSettings',
      'windowControl',
    ].sort(),
  )

  await expect(page.getByRole('button', { name: '运行全部流程', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '打开预处理目录' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '打开NAS 媒体目录' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '打开NAS 媒体目录' })).toHaveAttribute(
    'title',
    '请先设置NAS 媒体目录',
  )
  await page.getByRole('button', { name: '运行说明', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '运行说明' })).toContainText(
    '工作台的独立预处理与四步流程已接入实际处理',
  )
  await page
    .getByRole('dialog', { name: '运行说明' })
    .getByRole('button', { name: '关闭弹窗' })
    .click()
  await expect(page.getByRole('button', { name: '配置预处理目录' })).toContainText('配置预处理')
  await page.getByRole('button', { name: '配置预处理目录' }).click()
  await expect(page.getByRole('heading', { name: '偏好配置', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '偏好设置', exact: true })).toHaveCount(0)
  await expect(page.locator('.settings-page').getByText('外观模式')).toHaveCount(0)
  // 使用系统打开文件能力的替身，验证固定目标和错误提示，不启动真实编辑器。
  await app.evaluate(({ shell }) => {
    shell.openPath = async (file) => {
      globalThis.openedSettingsFile = file
      return globalThis.openSettingsError || ''
    }
  })
  await page.getByLabel('下载目录', { exact: true }).fill(dataDirectory)
  await page.getByRole('button', { name: '打开配置文件', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已打开配置文件')
  expect(await app.evaluate(() => globalThis.openedSettingsFile)).toBe(
    join(dataDirectory, 'settings.json'),
  )
  expect(
    JSON.parse(await readFile(join(dataDirectory, 'settings.json'), 'utf8')).paths.download,
  ).toBe('')
  await expect(page.getByLabel('下载目录', { exact: true })).toHaveValue(dataDirectory)
  await app.evaluate(() => {
    globalThis.openSettingsError = '验证打开失败'
  })
  await page.getByRole('button', { name: '打开配置文件', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('无法打开配置文件')
  await app.evaluate(() => {
    globalThis.openSettingsError = ''
  })

  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.locator('.step-controls input:checked')).toHaveCount(4)
  await expect
    .poll(
      async () => {
        performanceSample = await page.evaluate(() => window.cyberHorse.getPerformance())
        return (
          performanceSample.cpu.usage !== null &&
          performanceSample.gpu.state !== 'loading' &&
          performanceSample.network.state !== 'loading'
        )
      },
      { timeout: 25000, intervals: [1000] },
    )
    .toBe(true)
  expect(performanceSample.cpu.usage).toBeGreaterThanOrEqual(0)
  expect(performanceSample.cpu.usage).toBeLessThanOrEqual(100)
  expect(performanceSample.memory.total).toBeGreaterThan(0)
  for (const metric of [performanceSample.gpu, performanceSample.network])
    expect(['ready', 'unavailable']).toContain(metric.state)
  await page.getByRole('button', { name: '查看 CPU 性能', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '本机性能' })).toBeVisible()
  await expect(page.locator('.metric-card')).toHaveCount(4)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^查看目录与工具检测/ }).click()
  await expect(page.getByRole('dialog', { name: '路径与工具检测' })).toContainText('10 项待处理')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '深色模式', exact: true }).click()

  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await page.getByLabel('下载目录', { exact: true }).fill(dataDirectory)
  await expect(page.getByRole('textbox', { name: 'MDC 工具日志目录（可留空）' })).toHaveCount(0)
  await page.getByRole('tab', { name: '字幕', exact: true }).click()
  await page.getByRole('button', { name: 'ASS', exact: true }).click()
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.cyberHorse.getSettings())).settings.subtitle.format,
    )
    .toBe('ass')
  await page.getByRole('tab', { name: '路径与工具' }).click()
  await expect(page.getByLabel('下载目录', { exact: true })).toHaveValue(dataDirectory)
  expect(
    JSON.parse(await readFile(join(dataDirectory, 'settings.json'), 'utf8')).paths.download,
  ).toBe(dataDirectory)
  expect(
    JSON.parse(await readFile(join(dataDirectory, 'settings.json'), 'utf8')).paths,
  ).not.toHaveProperty('mdcLogDirectory')
  await page.getByRole('tab', { name: '媒体服务器' }).click()
  await expect(page.getByLabel('播放时默认静音')).toBeChecked()
  await page.getByLabel('播放时默认静音').uncheck()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(join(dataDirectory, 'settings.json'), 'utf8')).player.startMuted,
    )
    .toBe(false)
  await page.getByLabel('播放时默认静音').check()
  await page.getByRole('textbox', { name: '服务器地址' }).fill('https://example.test:8096')
  await page.getByRole('textbox', { name: '用户名' }).fill('测试用户')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.cyberHorse.getSettings())).settings.mediaServer.username,
    )
    .toBe('测试用户')
  await page.getByRole('textbox', { name: '媒体服务器密码' }).fill('临时验证口令')
  await page.getByRole('button', { name: '保存密码' }).click()
  await expect(page.getByText('已在本机安全保存')).toBeVisible()
  expect(await page.evaluate(() => window.cyberHorse.getCredentialStatus())).toBe(true)
  expect(await readFile(join(dataDirectory, 'media-server-credential.bin'), 'utf8')).not.toContain(
    '临时验证口令',
  )
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect(page.getByText('尚未设置')).toBeVisible()
  expect(await page.evaluate(() => window.cyberHorse.getCredentialStatus())).toBe(false)
  // 文件在外部保存后直接推送到当前表单，不依赖刷新或重新进入页面。
  const settingsFile = join(dataDirectory, 'settings.json')
  const beforeExternal = JSON.parse(await readFile(settingsFile, 'utf8'))
  await page.getByRole('textbox', { name: '用户名' }).fill('表单中的旧草稿')
  const external = structuredClone(beforeExternal)
  external.mediaServer.username = '文件更新的用户'
  external.subtitle.format = 'srt'
  external.privacyCover.defaultEyeOpen = false
  external.paths.nas = dataDirectory
  external.theme = 'eva'
  await writeFile(settingsFile + '.editor', JSON.stringify(external))
  await rename(settingsFile + '.editor', settingsFile)
  await expect(page.getByRole('textbox', { name: '用户名' })).toHaveValue('文件更新的用户')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eva')
  await page.getByRole('tab', { name: '字幕', exact: true }).click()
  await expect(page.getByRole('button', { name: 'SRT', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('tab', { name: '隐私封面' }).click()
  await expect(page.getByLabel('默认显示原始封面')).not.toBeChecked()
  await page.getByRole('tab', { name: '路径与工具' }).click()
  await expect(page.getByLabel('NAS 媒体目录', { exact: true })).toHaveValue(dataDirectory)
  await page.getByLabel('视频输出目录', { exact: true }).fill(dataDirectory)
  await writeFile(settingsFile, '{ 无效')
  await expect(page.getByRole('alert')).toContainText('上一次有效配置')
  await page.getByRole('button', { name: '打开配置文件', exact: true }).click()
  expect(await readFile(settingsFile, 'utf8')).toBe('{ 无效')
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('主题保存失败')
  expect(await readFile(settingsFile, 'utf8')).toBe('{ 无效')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eva')
  await writeFile(settingsFile, JSON.stringify(external))
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('视频输出目录', { exact: true })).toHaveValue(dataDirectory)
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('配置已保存')
  expect(JSON.parse(await readFile(settingsFile, 'utf8')).paths.videoOutput).toBe(dataDirectory)
  await page.getByRole('tab', { name: '路径与工具' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: '字幕', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('tab', { name: '隐私封面' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({
    path: join(output, '工作台-深色.png'),
    animations: 'disabled',
    scale: 'css',
  })
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.screenshot({
    path: join(output, '工作台-浅色.png'),
    animations: 'disabled',
    scale: 'css',
  })

  const persistentStatusbar = await page.locator('.app-statusbar').elementHandle()
  for (const theme of ['初号机', '深色', '浅色']) {
    await page
      .getByRole('button', {
        name: theme === '初号机' ? '初号机主题' : `${theme}模式`,
        exact: true,
      })
      .click()
    for (const name of pages) {
      await page.getByRole('button', { name, exact: true }).click()
      // 导航保持同一状态栏实例，采样与趋势不会随页面卸载重置。
      expect(await persistentStatusbar.evaluate((node) => node.isConnected)).toBe(true)
      await page.getByRole('button', { name: '查看 CPU 性能' }).click()
      await expect(page.getByRole('dialog', { name: '本机性能', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '查看 CPU 性能' })).toBeFocused()
      await page.getByRole('button', { name: /^查看目录与工具检测/ }).click()
      await expect(page.getByRole('dialog', { name: '路径与工具检测' })).toBeVisible()
      await page.keyboard.press('Escape')
      if (name === '偏好配置') {
        await page.getByRole('tab', { name: '路径与工具' }).click()
        await page.getByLabel('下载目录', { exact: true }).focus()
      }
      await checkLayout(page, `默认窗口-${theme}-${name}`)
      await expect(page.getByRole('tablist', { name: '任务状态' })).toHaveCount(
        name === '任务队列' ? 1 : 0,
      )
      await expect(page.getByRole('button', { name: '展开运行日志', exact: true })).toHaveCount(
        name === '任务队列' ? 1 : 0,
      )
      await page.screenshot({
        path: join(output, `${name}-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
    }
    for (const tabName of ['字幕', '媒体服务器', '隐私封面']) {
      await page.getByRole('tab', { name: tabName }).click()
      await checkLayout(page, `默认窗口-${theme}-${tabName}`)
      await page.screenshot({
        path: join(output, `配置-${tabName}-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
    }
  }
  await page.getByRole('button', { name: '最大化或还原', exact: true }).click()
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
    .toBe(true)
  for (const name of pages) {
    await page.getByRole('button', { name, exact: true }).click()
    await checkLayout(page, `最大化-${name}`)
    await page.screenshot({
      path: join(output, `${name}-最大化.png`),
      animations: 'disabled',
      scale: 'css',
    })
  }
  await page.getByRole('button', { name: '最大化或还原', exact: true }).click()
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
    .toBe(false)
  await page.getByRole('button', { name: '工作台', exact: true }).click()

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('button', { name: '跟随系统', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: '深色模式', exact: true }).click()

  const mediaDirectory = join(dataDirectory, '验证视频')
  await mkdir(join(mediaDirectory, '子目录'), { recursive: true })
  const videoA = join(mediaDirectory, '影片 A.mp4')
  const videoB = join(mediaDirectory, '影片 B.mkv')
  const downloadDirectory = join(dataDirectory, '验证下载')
  await mkdir(downloadDirectory)
  const downloadedVideo = join(downloadDirectory, '待预处理.mp4')
  await writeFile(downloadedVideo, '下载源文件保持不变')
  await writeFile(videoA, '只读测试文件 A')
  const modifiedAt = new Date(2025, 0, 2, 3, 4, 5)
  await utimes(videoA, modifiedAt, modifiedAt)
  await writeFile(videoB, '只读测试文件 B')
  await writeFile(join(mediaDirectory, '子目录', '影片 C.mov'), '只读测试文件 C')
  await writeFile(join(mediaDirectory, '说明.txt'), '非媒体文件')
  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await page.getByLabel('预处理目录', { exact: true }).fill(mediaDirectory)
  await page.getByLabel('下载目录', { exact: true }).fill(downloadDirectory)
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('配置已保存')
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.locator('.directory-trigger')).toHaveAttribute('title', mediaDirectory)
  await expect(page.locator('.directory-trigger + .input-refresh')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '工作目录选项' })).toHaveCount(0)
  await page.getByRole('button', { name: '打开预处理目录' }).click()
  expect(await app.evaluate(() => globalThis.openedSettingsFile)).toBe(mediaDirectory)
  await expect(page.getByRole('dialog', { name: '工作目录' })).toHaveCount(0)
  await expect(page.locator('.input-selection-status')).toContainText('3 个视频')
  const configuredPaths = (await page.evaluate(() => window.cyberHorse.getSettings())).settings
    .paths
  await expect(page.locator('.workbench-step .step-action')).toHaveCount(4)
  for (const [label, key] of [
    ['打开字幕工作目录', 'whisperOutput'],
    ['打开视频输出目录', 'videoOutput'],
    ['打开MDC 输出目录', 'mdcOutput'],
    ['打开NAS 媒体目录', 'nas'],
  ]) {
    const button = page.getByRole('button', { name: label })
    await expect(button).toHaveAttribute(
      'title',
      configuredPaths[key] || `请先设置${label.slice(2)}`,
    )
  }
  await expect(page.getByLabel('含子目录', { exact: true })).toBeChecked()
  await expect(page.getByRole('button', { name: '开始预处理', exact: true })).toContainText(
    '开始预处理',
  )
  await page.getByRole('button', { name: '关闭提示', exact: true }).click()
  for (const theme of ['初号机', '深色', '浅色']) {
    await page
      .getByRole('button', {
        name: theme === '初号机' ? '初号机主题' : `${theme}模式`,
        exact: true,
      })
      .click()
    await checkLayout(page, `工作目录已载入-${theme}`)
    await page.screenshot({
      path: join(output, `工作台-已载入-${theme}.png`),
      animations: 'disabled',
      scale: 'css',
    })
  }
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.getByRole('button', { name: '手动选择', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '选择处理文件' })).toBeVisible()
  await expect(page.locator('.file-selection-toolbar')).toContainText('已选 0 / 3 个')
  await page.getByRole('button', { name: '全选全部文件', exact: true }).click()
  await page.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect(page.getByRole('button', { name: '打开NAS 媒体目录' })).toHaveAttribute(
    'title',
    configuredPaths.nas || '请先设置NAS 媒体目录',
  )
  await expect(page.locator('.directory-trigger')).toHaveAttribute('title', mediaDirectory)
  await expect(page.getByRole('button', { name: '打开视频输出目录' })).toHaveAttribute(
    'title',
    configuredPaths.videoOutput || '请先设置视频输出目录',
  )
  await page.getByLabel('含子目录', { exact: true }).uncheck()
  await expect(page.locator('.input-selection-status')).toContainText('2 个视频')
  await page.getByLabel('含子目录', { exact: true }).check()
  await expect(page.locator('.input-selection-status')).toContainText('3 个视频')
  const fileRow = page.locator('.input-file-row').filter({ hasText: '影片 A.mp4' })
  await expect(fileRow.locator('.file-size')).toHaveText('20 B')
  await expect(fileRow.locator('.file-modified')).toHaveText('2025-01-02 03:04:05')
  await page.getByRole('button', { name: '文件操作：影片 A.mp4', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '仅选此文件', exact: true }).click()
  await expect(page.locator('.input-selection-status')).toContainText('已选 1 /')
  await page.getByRole('checkbox', { name: '勾选 影片 B.mkv', exact: true }).check()
  await expect(page.locator('.input-selection-status')).toContainText('已选 2 /')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.locator('.input-selection-status')).toContainText('已选 2 /')
  await page.getByLabel('含子目录', { exact: true }).uncheck()
  await expect(page.locator('.input-selection-status')).toContainText('已选 2 /')
  await page.getByLabel('含子目录', { exact: true }).check()
  await expect(page.locator('.input-selection-status')).toContainText('已选 2 / 3 个')

  // 步骤范围独立于文件范围；空选择不能启动。各输出目录仍须单独配置。
  const stepNames = ['字幕与封装', '视频破解', '元数据刮削', '归档到 NAS']
  const stepChoice = (name) =>
    page.getByRole('checkbox', { name: `参与流程：${name}`, exact: true })
  for (const name of stepNames) await stepChoice(name).uncheck()
  await expect(page.getByRole('button', { name: '请选择步骤', exact: true })).toBeDisabled()
  await expect(page.locator('.input-selection-status')).toContainText('已选 2 / 3 个')
  await expect(page.getByRole('button', { name: '打开MDC 输出目录' })).toHaveAttribute(
    'title',
    configuredPaths.mdcOutput || '请先设置MDC 输出目录',
  )
  await expect(page.locator('.step-controls input:checked')).toHaveCount(0)
  await stepChoice('元数据刮削').check()
  await page.getByRole('button', { name: '运行所选 1 步', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('不能处理系统、应用数据或项目目录')
  await stepChoice('元数据刮削').uncheck()
  await stepChoice('归档到 NAS').check()
  await stepChoice('视频破解').focus()
  await page.keyboard.press('Space')
  await expect(stepChoice('视频破解')).toBeChecked()
  await expect(page.getByRole('button', { name: '运行所选 2 步' })).toContainText('运行所选 2 步')
  for (const theme of ['初号机', '深色', '浅色']) {
    await page
      .getByRole('button', {
        name: theme === '初号机' ? '初号机主题' : `${theme}模式`,
        exact: true,
      })
      .click()
    await checkLayout(page, `部分步骤与部分文件-${theme}`)
    await page.screenshot({
      path: join(output, `工作台-部分流程-${theme}.png`),
      scale: 'css',
      animations: 'disabled',
    })
  }
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.getByRole('button', { name: '运行所选 2 步' }).click()
  await expect(page.getByRole('status')).toContainText('不能处理系统、应用数据或项目目录')
  await expect(stepChoice('视频破解')).toBeChecked()
  await expect(stepChoice('归档到 NAS')).toBeChecked()
  await expect(page.locator('.input-selection-status')).toContainText('已选 2 / 3 个')
  await page.getByRole('button', { name: '全选步骤', exact: true }).click()
  await expect(page.locator('.step-controls input:checked')).toHaveCount(4)
  await expect(page.getByRole('button', { name: '运行全部流程' })).toBeEnabled()

  await page.getByRole('button', { name: /查看并勾选文件/ }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /查看并勾选文件/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '仅选 影片 A.mp4', exact: true }).click()
  await expect(page.locator('.file-selection-toolbar')).toContainText('已选 1 / 3 个')
  await page.getByRole('checkbox', { name: '选择文件 影片 B.mkv', exact: true }).check()
  await expect(page.locator('.file-selection-toolbar')).toContainText('已选 2 / 3 个')
  await page.getByRole('textbox', { name: '筛选文件' }).fill('影片 A')
  await expect(page.locator('.file-selection-row')).toHaveCount(1)
  await expect(page.locator('.file-selection-toolbar')).toContainText('已选 2 / 3 个')
  await page.getByRole('textbox', { name: '筛选文件' }).fill('')
  await page.getByRole('button', { name: '取消全选', exact: true }).click()
  await expect(page.locator('.file-selection-toolbar')).toContainText('已选 0 / 3 个')
  await page.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect(page.getByRole('button', { name: '运行全部流程', exact: true })).toBeDisabled()
  await expect(page.locator('.input-selection-status')).toContainText('已选 0 /')
  await expect(page.getByRole('button', { name: '打开NAS 媒体目录' })).toHaveAttribute(
    'title',
    configuredPaths.nas || '请先设置NAS 媒体目录',
  )
  await page.getByRole('button', { name: /查看并勾选文件/ }).click()
  await page.getByRole('button', { name: '全选全部文件', exact: true }).click()
  await page.screenshot({
    path: join(output, '工作台-文件选择.png'),
    animations: 'disabled',
    scale: 'css',
  })
  await page.getByRole('button', { name: '完成选择', exact: true }).click()
  const videoD = join(mediaDirectory, '新放入 D.mp4')
  await writeFile(videoD, '运行前新增视频')
  await page.getByRole('button', { name: '运行全部流程', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('不能处理系统、应用数据或项目目录')
  await expect(page.locator('.input-selection-status')).toContainText('4 个视频')
  await writeFile(join(mediaDirectory, '运行中新增 E.mp4'), '隔离文件选择样本')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await checkLayout(page, '默认窗口-文件范围更新')
  expect(await readFile(videoA, 'utf8')).toBe('只读测试文件 A')
  await page.getByRole('button', { name: '文件操作：影片 A.mp4', exact: true }).click()
  await page.getByRole('button', { name: '仅选此文件', exact: true }).click()
  await expect(page.locator('.input-selection-status')).toContainText('已选 1 / 5 个')
  await rename(videoA, join(mediaDirectory, '影片 A 已移动.mp4'))
  for (const name of stepNames.filter((name) => name !== '归档到 NAS'))
    await stepChoice(name).uncheck()
  await page.getByRole('button', { name: '运行所选 1 步', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('部分选中文件已不在工作目录中')
  await expect(page.locator('.input-selection-status')).toContainText('已选 0 /')
  await expect(page.getByRole('button', { name: '停止演示', exact: true })).toHaveCount(0)
  await rename(join(mediaDirectory, '影片 A 已移动.mp4'), videoA)
  await page.getByRole('button', { name: '目录全部', exact: true }).click()
  await page.getByRole('button', { name: '开始预处理', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('系统或应用目录')
  await expect(page.locator('.directory-trigger')).toHaveAttribute('title', mediaDirectory)
  expect(await readFile(downloadedVideo, 'utf8')).toBe('下载源文件保持不变')

  const invalidRefresh = await page.evaluate(async () => {
    try {
      await window.cyberHorse.refreshInputs({ source: 'preprocess', recursive: true, path: 'C:/' })
      return false
    } catch {
      return true
    }
  })
  expect(invalidRefresh).toBe(true)
  expect(
    await page.evaluate(async () => {
      try {
        await window.cyberHorse.openWorkDirectory('C:/')
        return false
      } catch {
        return true
      }
    }),
  ).toBe(true)
  await page.getByRole('button', { name: '全选步骤', exact: true }).click()

  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await page.getByLabel('预处理目录', { exact: true }).fill(join(dataDirectory, '不存在的目录'))
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.locator('.input-error')).toContainText('无法读取工作目录')
  await expect(page.locator('.input-file-row')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '运行全部流程', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await page.getByLabel('预处理目录', { exact: true }).fill(mediaDirectory)
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.locator('.input-selection-status')).toContainText('5 个视频')

  const emptyDirectory = join(dataDirectory, '空工作目录')
  await mkdir(emptyDirectory)
  await page.evaluate(async (directory) => {
    const { settings } = await window.cyberHorse.getSettings()
    await window.cyberHorse.saveSettings({
      ...settings,
      paths: { ...settings.paths, preprocess: directory },
    })
  }, emptyDirectory)
  await expect(page.locator('.input-selection-status')).toContainText('0 个视频')
  await page.getByRole('button', { name: '运行全部流程', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('当前范围没有支持的视频文件')
  await expect(page.getByRole('button', { name: '停止演示', exact: true })).toHaveCount(0)
  await page.evaluate(async (directory) => {
    const { settings } = await window.cyberHorse.getSettings()
    await window.cyberHorse.saveSettings({
      ...settings,
      paths: { ...settings.paths, preprocess: directory },
    })
  }, mediaDirectory)
  await expect(page.locator('.input-selection-status')).toContainText('5 个视频')

  await expect(page.getByRole('button', { name: '搜索功能' })).toHaveCount(0)
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: '快速查找' })).toHaveCount(0)
  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '偏好配置', exact: true })).toBeVisible()
  await page.getByLabel('下载目录', { exact: true }).fill(dataDirectory)
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('配置已保存')
  const health = await page.evaluate(() => window.cyberHorse.checkPaths())
  expect(health.find((item) => item.key === 'download').status).toBe('ready')
  expect(
    JSON.parse(await readFile(join(dataDirectory, 'settings.json'), 'utf8')).paths.download,
  ).toBe(dataDirectory)
  const rejected = await page.evaluate(async () => {
    try {
      await window.cyberHorse.saveSettings({ version: 99 })
      return false
    } catch {
      return true
    }
  })
  expect(rejected).toBe(true)
  await page.getByRole('button', { name: '定时关机', exact: false }).click()
  await expect(page.getByRole('dialog')).toContainText('不会执行系统关机')
  await page.getByRole('button', { name: '开始倒计时演示' }).click()
  await expect(page.getByRole('button', { name: /取消倒计时/ })).toBeVisible()
  await page.getByRole('button', { name: /取消倒计时/ }).click()
  await page.getByRole('button', { name: '工作台', exact: true }).click()

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 760))
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(1058)
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(1060)
  const overflow = await page.evaluate(
    () =>
      document.querySelector('.main-scroll').scrollWidth >
      document.querySelector('.main-scroll').clientWidth,
  )
  expect(overflow).toBe(false)
  for (const name of pages) {
    await page.getByRole('button', { name, exact: true }).click()
    if (name === '偏好配置') {
      // 长表单只在面板内滚动，末项与保存区都要能操作。
      await page.getByLabel('视频输出目录', { exact: true }).focus()
      await expect(page.getByLabel('视频输出目录', { exact: true })).toBeInViewport()
      await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeInViewport()
      await page.getByLabel('下载目录', { exact: true }).focus()
      await expect(page.getByLabel('下载目录', { exact: true })).toBeInViewport()
    }
    await checkLayout(page, `最小窗口-${name}`)
    await page.screenshot({
      path: join(output, `${name}-最小窗口.png`),
      animations: 'disabled',
      scale: 'css',
    })
  }
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 6000 })
  await page.screenshot({
    path: join(output, '工作台-最小窗口.png'),
    animations: 'disabled',
    scale: 'css',
  })
  await page.getByRole('button', { name: '初号机主题', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eva')
  await checkLayout(page, '最小窗口-初号机')
  await page.screenshot({
    path: join(output, '工作台-初号机-最小窗口.png'),
    animations: 'disabled',
    scale: 'css',
  })
  await stepChoice('字幕与封装').uncheck()
  await stepChoice('元数据刮削').uncheck()
  await checkLayout(page, '最小窗口-部分步骤')
  await page.screenshot({
    path: join(output, '工作台-部分流程-最小窗口.png'),
    scale: 'css',
    animations: 'disabled',
  })
  await app.close()
  app = null
  page = await launch()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eva')
  await expect(page.locator('.directory-trigger')).toHaveAttribute('title', mediaDirectory)
  await expect(page.locator('.input-selection-status')).toContainText('5 个视频')
  await expect(page.locator('.step-controls input:checked')).toHaveCount(4)
  await page.getByRole('button', { name: '偏好配置', exact: true }).click()
  await expect(page.getByLabel('下载目录', { exact: true })).toHaveValue(dataDirectory)
  await verifyPreparation(app, page, output)
  await verifyPipeline(app, page, output)
  await verifyMediaLibrary(app, page, output)
  await verifyEnvironmentRecovery(app, page, dataDirectory, output)
  expect(errors).toEqual([])
  await writeFile(
    join(output, 'desktop-smoke-result.json'),
    JSON.stringify(
      { result: '通过', security, errors, layouts, performanceSample, dataDirectory },
      null,
      2,
    ),
  )
  console.log(
    '桌面验证通过：统一配置、外部文件同步与无效文件保护、进程隔离、初号机及深浅主题、系统跟随、流程完成和取消、全局搜索移除与文件筛选、配置持久化、无效输入拒绝、路径检查、倒计时、最小窗口及重启恢复。',
  )
} catch (error) {
  if (app) {
    const page = await app.firstWindow()
    await page
      .screenshot({ path: join(output, '桌面验证-失败现场.png'), scale: 'css' })
      .catch(() => {})
    const state = await page
      .evaluate(() => ({
        visibility: document.visibilityState,
        heading: document.querySelector('h1')?.textContent,
        tasks: [...document.querySelectorAll('.task-status')].map((node) => node.textContent),
        progress: [...document.querySelectorAll('.task-progress > span')].map((node) =>
          node.getAttribute('style'),
        ),
      }))
      .catch(() => null)
    await writeFile(
      join(output, 'desktop-smoke-failure.json'),
      JSON.stringify({ error: String(error), state, errors, layouts }, null, 2),
    )
  }
  throw error
} finally {
  if (app) await app.close()
}
