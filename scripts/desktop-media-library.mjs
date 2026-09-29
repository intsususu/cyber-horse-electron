import { expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, realpath, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { playbackSample } from './fixtures/playback-sample.mjs'
import { verifyPlayerControls } from './desktop-player-controls.mjs'

export async function verifyMediaLibrary(app, page, output) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'horse-desktop-media-')))
  const saved = await page.evaluate(async () => (await window.cyberHorse.getSettings()).settings)
  const paths = {}
  for (const key of [
    'download',
    'preprocess',
    'whisperOutput',
    'videoOutput',
    'mdcOutput',
    'nas',
  ]) {
    paths[key] = join(root, key)
    await mkdir(paths[key])
  }
  const payload = Buffer.from('隔离文本样本，不是真实媒体')
  const playbackVideo = await playbackSample(page)
  const originalFolder = join(paths.nas, '影片')
  await mkdir(originalFolder)
  const original = join(originalFolder, 'ABC-123.mp4')
  await writeFile(original, payload)
  await writeFile(join(originalFolder, '备注.txt'), '不得修改的用户备注')
  const tools = join(root, '工具')
  await mkdir(tools)
  const program = join(tools, '替身.exe')
  await promisify(execFile)(
    join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    [
      '/nologo',
      '/r:System.Web.Extensions.dll',
      '/out:' + program,
      resolve('scripts/fixtures/pipeline-tool.cs'),
    ],
    { windowsHide: true },
  )
  for (const key of ['whisper', 'mkvmerge', 'jasna', 'mdc', 'ffprobe']) {
    const file = join(tools, key + '.exe')
    await copyFile(program, file)
    if (key !== 'ffprobe') paths[key] = file
  }
  const calls = []
  const favorites = new Set(['v2'])
  const deleted = new Set()
  let denyFavorite = false
  let slow = false
  let authCount = 0
  let rejectDirectPlayback = false
  let subtitleFailures = 0
  let delayPlaybackDetail = false
  let queueDetailGate = null
  const item = (id) => ({
    Id: id,
    Name:
      id === 'v1'
        ? '测试影片 ABC-123'
        : id === 'v42'
          ? '东营文化：测试影片 42'
          : `测试影片 ${id.slice(1)}`,
    ProductionYear: 2024,
    RunTimeTicks: 72 * 600000000,
    Overview:
      id === 'v8'
        ? ''
        : '这是隔离服务器返回的测试简介，用于验证中文详情、筛选、收藏与文件保护。影片讲述了一段从城市出发、沿着山路与海岸行进的旅程，人们在不同的风景中相遇，也在一次次告别中重新认识彼此。镜头记录清晨的街道、午后的车站和傍晚的海边，让日常生活中的细节慢慢展开。这段较长的简介用于检查默认摘要、展开阅读和收起后的页面位置，所有内容与图片均为隔离验证样本。',
    DateCreated: '2026-09-01T08:00:00Z',
    Path: '/test/影片/ABC-123.mp4',
    Genres: ['剧情'],
    People: [{ Id: 12, Name: '测试演员', Role: '主角' }],
    Studios: [{ Name: '测试制作公司' }],
    UserData: { IsFavorite: favorites.has(id) },
    MediaSources: [
      {
        Id: 'source1',
        Name: '原始版本',
        Path: '/test/影片/ABC-123.mp4',
        Container: 'webm',
        Size: payload.length,
        DefaultSubtitleStreamIndex: 2,
        MediaStreams: [
          {
            Type: 'Subtitle',
            Index: 2,
            DisplayTitle:
              'Chinese Simplified (默认 ASS) 超长字幕轨道名称用于验证菜单内换行和边界保护',
            Language: 'zho',
            Codec: 'srt',
            IsTextSubtitleStream: true,
          },
          {
            Type: 'Subtitle',
            Index: 3,
            DisplayTitle: '英语',
            Language: 'eng',
            Codec: 'srt',
            IsTextSubtitleStream: true,
          },
          {
            Type: 'Subtitle',
            Index: 4,
            DisplayTitle: '图像字幕',
            Language: 'zho',
            Codec: 'pgs',
            IsTextSubtitleStream: false,
          },
        ],
      },
      {
        Id: 'source2',
        Name: '备用版本',
        Path: '/test/备用.mp4',
        Container: 'mp4',
        Size: payload.length,
      },
    ],
    Chapters:
      id === 'v1'
        ? [
            { Name: '片头', StartPositionTicks: 0, ImageTag: 'preview' },
            { Name: '第二章', StartPositionTicks: 600000000, ImageTag: 'preview' },
          ]
        : [],
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    calls.push({
      path: url.pathname,
      method: req.method,
      query: Object.fromEntries(url.searchParams),
    })
    const json = (value) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(value))
    }
    if (url.pathname.endsWith('/AuthenticateByName')) {
      authCount++
      json({
        AccessToken: 'fixture-token',
        ServerId: 'fixture-server',
        User: { Id: 'u1', Policy: { EnableContentDeletion: true } },
      })
      return
    }
    if (req.headers['x-emby-token'] !== 'fixture-token') {
      res.writeHead(401)
      res.end()
      return
    }
    if (url.pathname.endsWith('/Views')) {
      json({
        Items: [
          { Id: 'lib1', Name: '电影' },
          { Id: 'lib2', Name: '剧集' },
          { Id: 'lib3', Name: '动画与纪录片' },
          { Id: 'lib4', Name: '音乐现场' },
          { Id: 'lib5', Name: '家庭影像' },
          { Id: 'lib6', Name: '长名称媒体库与特别收藏' },
        ],
      })
      return
    }
    if (url.pathname.includes('/Images/')) {
      if (url.pathname.includes('/v1/') || url.pathname.endsWith('/v2/Images/Thumb')) {
        res.setHeader('Content-Type', 'image/png')
        res.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1kAAAAASUVORK5CYII=',
            'base64',
          ),
        )
        return
      }
      res.writeHead(404)
      res.end()
      return
    }
    if (url.pathname.includes('/FavoriteItems/')) {
      if (denyFavorite) {
        res.writeHead(403)
        res.end()
        return
      }
      const id = url.pathname.split('/').at(-1)
      if (req.method === 'DELETE') favorites.delete(id)
      else favorites.add(id)
      json({ IsFavorite: favorites.has(id) })
      return
    }
    if (url.pathname.endsWith('/Refresh')) {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'DELETE' && url.pathname.endsWith('/Items')) {
      deleted.add(url.searchParams.get('Ids'))
      res.writeHead(204)
      res.end()
      return
    }
    if (/\/Subtitles\/\d+\/Stream\.vtt$/.test(url.pathname)) {
      if (subtitleFailures > 0) {
        subtitleFailures--
        res.writeHead(503)
        res.end()
        return
      }
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8')
      res.end(
        'WEBVTT\n\n00:00:30.000 --> 00:01:30.000\n' +
          (url.pathname.includes('/2/') ? '中文字幕测试' : 'English subtitle test') +
          '\n',
      )
      return
    }
    if (url.pathname.endsWith('/stream.webm') || url.pathname.endsWith('/stream.mp4')) {
      if (rejectDirectPlayback && !url.searchParams.has('VideoCodec')) {
        res.setHeader('Content-Type', 'video/webm')
        res.end('无法解码的隔离样本')
        return
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Number(range[2]) : playbackVideo.length - 1
      const body = playbackVideo.subarray(start, end + 1)
      res.setHeader('Content-Type', 'video/webm')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Length', body.length)
      if (range) {
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${playbackVideo.length}`)
      }
      res.end(body)
      return
    }
    if (url.pathname.endsWith('/stream')) {
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Content-Length', payload.length)
      if (!slow) res.end(payload)
      else {
        res.write(payload.subarray(0, 3))
        const timer = setTimeout(() => res.end(payload.subarray(3)), 10000)
        res.on('close', () => clearTimeout(timer))
      }
      return
    }
    if (url.pathname.endsWith('/Similar')) {
      json({
        Items: Array.from({ length: 8 }, (_, index) => ({
          ...item(`v${index + 2}`),
          Name: `ABC-${456 + index} 测试影片 ${index + 2}`,
        })),
      })
      return
    }
    if (/\/Items\/v\d+$/.test(url.pathname)) {
      const id = url.pathname.split('/').at(-1)
      if (id === 'v3' && queueDetailGate) await queueDetailGate
      if (delayPlaybackDetail) await new Promise((resolve) => setTimeout(resolve, 350))
      json(item(id))
      return
    }
    if (url.pathname.endsWith('/Items')) {
      let items = Array.from({ length: 42 }, (_, i) => item(`v${i + 1}`)).filter(
        (v) => !deleted.has(v.Id),
      )
      if (url.searchParams.has('SearchTerm')) items = []
      if (url.searchParams.get('IsFavorite') === 'true')
        items = items.filter((v) => favorites.has(v.Id))
      if (url.searchParams.has('PersonIds') || url.searchParams.has('Genres'))
        items = items.slice(0, 2)
      const start = Number(url.searchParams.get('StartIndex') || 0),
        limit = Number(url.searchParams.get('Limit') || 20)
      json({ Items: items.slice(start, start + limit), TotalRecordCount: items.length })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/emby`
  const run = (name) => page.getByRole('button', { name, exact: true }).click()
  const wall = () => page.locator('.media-card')
  const checkLayout = async () => {
    expect(
      await page.evaluate(() => {
        const main = document.querySelector('.main-scroll')
        return [main.scrollHeight - main.clientHeight, main.scrollWidth - main.clientWidth]
      }),
    ).toEqual([0, 0])
  }
  try {
    await page.evaluate(
      async ({ url, paths }) => {
        const { settings } = await window.cyberHorse.getSettings()
        await window.cyberHorse.saveSettings({
          ...settings,
          paths,
          mediaServer: { serverUrl: url, username: '测试用户', downloadDirectory: '' },
          privacyCover: { defaultEyeOpen: true, posterPath: '', thumbPath: '' },
        })
      },
      { url, paths },
    )
    await app.evaluate(({ dialog, shell }, original) => {
      globalThis.mediaOriginalDialog = dialog.showOpenDialog
      globalThis.mediaOriginalMessage = dialog.showMessageBox
      globalThis.mediaOriginalOpenExternal = shell.openExternal
      globalThis.mediaOpenedLinks = []
      shell.openExternal = async (url) => {
        if (globalThis.mediaLinkFailure) throw new Error('浏览器替身失败')
        globalThis.mediaOpenedLinks.push(url)
      }
      globalThis.mediaFileDialogCount = 0
      dialog.showOpenDialog = async () => {
        globalThis.mediaFileDialogCount++
        return { canceled: false, filePaths: [original] }
      }
      dialog.showMessageBox = async () => ({
        response: globalThis.confirmMediaDelete ?? 0,
        checkboxChecked: false,
      })
    }, original)
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w.isMaximized()) w.unmaximize()
      w.setSize(1480, 900)
    })
    await run('任务队列')
    if (await page.getByRole('button', { name: '清空记录' }).isEnabled()) {
      await run('清空记录')
      await expect(page.getByRole('button', { name: '清空记录' })).toBeDisabled()
    }
    await run('EMBY媒体库')
    // 已保存配置每次进入自动连接，不能依赖额外点击。
    await expect(wall()).toHaveCount(30)
    expect(authCount).toBe(1)
    const requestsAfterEntry = calls.filter((call) => call.path.endsWith('/Views')).length
    await run('任务队列')
    await run('EMBY媒体库')
    await expect(wall()).toHaveCount(30)
    await expect
      .poll(() => calls.filter((call) => call.path.endsWith('/Views')).length)
      .toBe(requestsAfterEntry + 1)
    for (const name of ['重新连接', '连接媒体库', '下载任务', '服务器配置', '搜索媒体库'])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
    await expect(page.getByLabel('搜索媒体', { exact: true })).toHaveCount(0)
    const libraryPicker = page.getByRole('button', { name: '选择媒体库' })
    const libraryOptions = page.getByRole('listbox', { name: '媒体库' })
    await libraryPicker.click()
    await expect(libraryOptions.getByRole('option')).toHaveCount(6)
    const menuAlignment = await page.evaluate(() => {
      const trigger = document
        .querySelector('.media-library-picker-trigger')
        .getBoundingClientRect()
      const menu = document.querySelector('.media-library-options').getBoundingClientRect()
      return {
        left: Math.abs(trigger.left - menu.left),
        right: Math.abs(trigger.right - menu.right),
        seam: Math.abs(trigger.bottom - menu.top),
      }
    })
    expect(menuAlignment.left).toBeLessThanOrEqual(1)
    expect(menuAlignment.right).toBeLessThanOrEqual(1)
    expect(menuAlignment.seam).toBeLessThanOrEqual(1)
    await expect(libraryOptions.getByRole('option', { name: '电影' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.keyboard.press('End')
    await expect(
      libraryOptions.getByRole('option', { name: '长名称媒体库与特别收藏' }),
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(wall()).toHaveCount(30)
    expect(calls.some((call) => call.query.ParentId === 'lib6')).toBe(true)
    await run('搜索当前媒体库')
    await expect(page.getByText('搜索范围：长名称媒体库与特别收藏')).toBeVisible()
    const searchInput = page.getByRole('searchbox', { name: '搜索媒体关键词' })
    await expect(searchInput).toBeFocused()
    await expect(wall()).toHaveCount(0)
    await searchInput.fill(' 东营文化 ')
    const searchCalls = calls.length
    await page.locator('.media-search-form').getByRole('button', { name: '搜索' }).click()
    await expect(wall()).toHaveCount(1)
    await expect(wall().first()).toContainText('东营文化')
    expect(
      calls
        .slice(searchCalls)
        .filter((call) => call.path.endsWith('/Items'))
        .every((call) => call.query.ParentId === 'lib6' && !call.query.SearchTerm),
    ).toBe(true)
    await run('查看详情：东营文化：测试影片 42')
    await expect(page.locator('.media-detail h2')).toHaveText('东营文化：测试影片 42')
    await run('返回')
    await expect(wall()).toHaveCount(1)
    await searchInput.fill('不存在的影片')
    await searchInput.press('Enter')
    await expect(page.getByText('没有匹配的媒体')).toBeVisible()
    await run('返回')
    await expect(wall()).toHaveCount(30)
    await libraryPicker.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    await expect(libraryOptions.getByRole('option', { name: '电影' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(wall()).toHaveCount(30)
    await expect(page.locator('.media-card .media-cover img')).toHaveCount(1)
    await libraryPicker.click()
    await page.keyboard.press('Escape')
    await expect(libraryOptions).toHaveCount(0)
    await expect(libraryPicker).toBeFocused()
    await libraryPicker.click()
    await page.locator('.media-scroll').click({ position: { x: 8, y: 8 } })
    await expect(libraryOptions).toHaveCount(0)
    await expect(wall()).toHaveCount(30)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    if (await page.getByRole('button', { name: '关闭提示' }).isVisible()) await run('关闭提示')
    const firstCard = wall().first()
    const contextMenu = page.getByRole('dialog', { name: '快捷操作：测试影片 ABC-123' })
    await firstCard.click({ button: 'right' })
    await expect(contextMenu).toBeVisible()
    await expect(contextMenu.getByRole('button')).toHaveText([
      '中文字幕',
      '视频破解',
      '下载',
      '关注',
      '删除媒体',
    ])
    await expect(contextMenu.getByRole('button', { name: '中文字幕' })).toBeEnabled()
    await expect(contextMenu.getByLabel('快捷操作使用的媒体版本')).toHaveValue('source1')
    await contextMenu.getByLabel('快捷操作使用的媒体版本').selectOption('source2')
    await expect(contextMenu.getByLabel('快捷操作使用的媒体版本')).toHaveValue('source2')
    await page.keyboard.press('Escape')
    await expect(contextMenu).toHaveCount(0)
    await expect(
      firstCard.getByRole('button', { name: '查看详情：测试影片 ABC-123' }),
    ).toBeFocused()
    await firstCard.click({ button: 'right' })
    await contextMenu.getByRole('button', { name: '关注', exact: true }).click()
    await expect(contextMenu).toHaveCount(0)
    await expect(
      firstCard.getByRole('button', { name: '取消收藏：测试影片 ABC-123' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await firstCard.click({ button: 'right' })
    await expect(contextMenu.getByRole('button', { name: '取消关注' })).toBeVisible()
    await contextMenu.getByRole('button', { name: '取消关注' }).click()
    await expect(firstCard.getByRole('button', { name: '收藏：测试影片 ABC-123' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    for (const theme of ['初号机主题', '深色模式', '浅色模式', '跟随系统']) {
      await run(theme)
      await expect(page.getByRole('button', { name: theme, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await checkLayout()
      await page.screenshot({
        path: join(output, `媒体库-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
      await firstCard.click({ button: 'right' })
      await expect(contextMenu.getByRole('button', { name: '中文字幕' })).toBeEnabled()
      const menuBounds = await contextMenu.boundingBox()
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      expect(menuBounds.x).toBeGreaterThanOrEqual(0)
      expect(menuBounds.y).toBeGreaterThanOrEqual(0)
      expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width)
      expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height)
      await page.screenshot({
        path: join(output, `媒体库-右键菜单-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
      await page.keyboard.press('Escape')
      await libraryPicker.click()
      const selectedOption = libraryOptions.getByRole('option', { name: '电影' })
      const selectedColor = await selectedOption.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      )
      await page.locator('.media-scroll').hover({ position: { x: 8, y: 8 } })
      await expect(selectedOption).toHaveCSS('background-color', selectedColor)
      await page.screenshot({
        path: join(output, `媒体库-选择菜单-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
      await page.keyboard.press('Escape')
      await run('搜索当前媒体库')
      await page.getByRole('searchbox', { name: '搜索媒体关键词' }).fill('东营文化')
      await page.getByRole('searchbox', { name: '搜索媒体关键词' }).press('Enter')
      await expect(wall()).toHaveCount(1)
      await checkLayout()
      await page.screenshot({
        path: join(output, `媒体库-搜索-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
      if (theme === '初号机主题') {
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setSize(1060, 760),
        )
        await checkLayout()
        await expect(page.getByRole('searchbox', { name: '搜索媒体关键词' })).toBeInViewport()
        await page.screenshot({
          path: join(output, '媒体库-搜索-最小窗口.png'),
          animations: 'disabled',
          scale: 'css',
        })
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
        await checkLayout()
        await expect(page.getByRole('searchbox', { name: '搜索媒体关键词' })).toBeInViewport()
        await app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.unmaximize()
          window.setSize(1480, 900)
        })
      }
      await run('返回')
      await expect(wall()).toHaveCount(30)
    }
    await run('隐藏所有封面')
    await expect(page.getByText('封面已隐藏')).toHaveCount(30)
    await run('显示所有封面')
    await page.locator('.media-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(wall()).toHaveCount(42)
    await page.locator('.media-scroll').evaluate((el) => {
      el.scrollTop = 0
    })
    await run('查看详情：测试影片 ABC-123')
    await expect(page.locator('.media-detail h2')).toHaveText('测试影片 ABC-123')
    await run('EMBY媒体库')
    await expect(page.locator('.media-detail')).toHaveCount(0)
    await expect(wall()).toHaveCount(30)
    await expect(libraryPicker).toContainText('电影')
    await run('查看详情：测试影片 ABC-123')
    await expect(page.locator('.media-detail h2')).toHaveText('测试影片 ABC-123')
    await expect(page.locator('.media-file-size')).toHaveText('文件大小0.00 GiB')
    await page.locator('.media-more-actions > summary').click()
    await expect(page.getByLabel('选择媒体版本').locator('option')).toHaveCount(2)
    await expect(page.getByLabel('选择媒体版本').locator('option')).toHaveText([
      '版本 1 · 0.00 GiB',
      '版本 2 · 0.00 GiB',
    ])
    await expect(page.getByRole('region', { name: '影片信息' })).toBeVisible()
    await expect(page.getByRole('button', { name: '剧情', exact: true })).toBeVisible()
    await expect(page.locator('.media-info-section summary')).toHaveCount(0)
    await expect(page.locator('.media-download')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '下载', exact: true })).toBeVisible()
    await page.locator('.media-detail h2').click()
    await expect(page.getByRole('button', { name: '下载', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: '打开 JavBus 详情' })).toHaveCount(0)
    await run('打开 Emby 视频详情')
    expect(await app.evaluate(() => globalThis.mediaOpenedLinks.at(-1))).toBe(
      `${url}/web/index.html#!/item?id=v1&serverId=fixture-server`,
    )
    const invalidLink = await page.evaluate(async () => {
      try {
        await window.cyberHorse.openMediaLink({ id: 'v1', target: 'emby', url: 'file:///C:/' })
        return false
      } catch {
        return true
      }
    })
    expect(invalidLink).toBe(true)
    await run('偏好配置')
    await page.getByRole('tab', { name: '媒体服务器', exact: true }).click()
    await page.getByLabel('JavBus 地址（可选）', { exact: true }).fill('https://www.javbus.com')
    await run('保存配置')
    await expect(page.getByRole('status')).toContainText('配置已保存')
    expect(
      (await page.evaluate(() => window.cyberHorse.getSettings())).settings.mediaServer.javbusUrl,
    ).toBe('https://www.javbus.com')
    await page
      .getByLabel('JavBus 地址（可选）', { exact: true })
      .fill('https://www.javbus.com/VDD-209')
    await run('保存配置')
    await expect(page.getByRole('status')).toContainText('配置已保存')
    expect(
      (await page.evaluate(() => window.cyberHorse.getSettings())).settings.mediaServer.javbusUrl,
    ).toBe('https://www.javbus.com/VDD-209')
    await run('EMBY媒体库')
    await run('查看详情：测试影片 ABC-123')
    await page.getByRole('button', { name: '打开 JavBus 详情' }).focus()
    await page.keyboard.press('Enter')
    await expect
      .poll(() => app.evaluate(() => globalThis.mediaOpenedLinks.at(-1)))
      .toBe('https://www.javbus.com/ABC-123')
    await app.evaluate(() => {
      globalThis.mediaLinkFailure = true
    })
    await run('打开 Emby 视频详情')
    await expect(page.locator('.media-error')).toContainText('无法打开浏览器')
    await app.evaluate(() => {
      globalThis.mediaLinkFailure = false
    })
    await run('打开 Emby 视频详情')
    await expect(page.locator('.media-error')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /第二章.*00:01:00/ })).toBeVisible()
    const related = page.locator('.media-card-compact').first()
    await expect(related.locator('.media-thumb img')).toBeVisible()
    await expect(related.locator('strong')).toHaveText('ABC-456')
    await expect(related.locator('.media-related-name')).toHaveText('测试影片 2')
    const relatedLayout = await related.evaluate((element) => {
      const image = element.querySelector('.media-thumb')
      const number = element.querySelector('strong')
      const name = element.querySelector('.media-related-name')
      return {
        imageBottom: image.getBoundingClientRect().bottom,
        numberTop: number.getBoundingClientRect().top,
        nameTop: name.getBoundingClientRect().top,
      }
    })
    expect(relatedLayout.numberTop).toBeGreaterThan(relatedLayout.imageBottom)
    expect(relatedLayout.nameTop).toBeGreaterThan(relatedLayout.numberTop)
    expect(calls.some((call) => call.path.endsWith('/v2/Images/Thumb'))).toBe(true)
    await related.click({ button: 'right' })
    const relatedContext = page.getByRole('dialog', { name: '快捷操作：ABC-456 测试影片 2' })
    await expect(relatedContext.getByRole('button', { name: '中文字幕' })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '视频破解', exact: true })).toBeHidden()
    await expect(
      related.getByRole('button', { name: '查看详情：ABC-456 测试影片 2' }),
    ).toBeFocused()
    const moreActions = page.locator('.media-more-actions > summary')
    await moreActions.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: '视频破解', exact: true })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('选择媒体版本')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(moreActions).toBeFocused()
    await expect(page.getByRole('button', { name: '视频破解', exact: true })).toBeHidden()
    await moreActions.click()
    await page.locator('.media-detail h2').click()
    await expect(page.getByRole('button', { name: '视频破解', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: '剧情', exact: true })).toBeVisible()
    await run('展开简介')
    await expect(page.getByRole('button', { name: '收起简介' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await run('收起简介')
    await run('收藏')
    await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toHaveText('已收藏')
    await run('取消收藏')
    await run('播放视频')
    await verifyPlayerControls(app, page, output)
    await expect(page.getByRole('button', { name: '返回详情' })).toBeVisible()
    await expect(page.getByRole('button', { name: '暂停播放', exact: true })).toBeEnabled()
    await expect
      .poll(() => calls.filter((call) => call.path.endsWith('/stream.webm')).length)
      .toBeGreaterThan(0)
    const player = page.locator('.media-player')
    const video = page.locator('.media-video')
    const playbackUrl = await video.getAttribute('src')
    const subtitleSelect = page.getByRole('button', { name: '选择字幕', exact: true })
    await expect(subtitleSelect).toContainText('中文简体')
    await expect.poll(() => video.evaluate((element) => element.textTracks[0]?.mode)).toBe('hidden')
    await expect
      .poll(() => video.evaluate((element) => element.textTracks[0]?.cues?.length))
      .toBe(1)
    await video.evaluate((element) => {
      element.currentTime = 0
    })
    await expect(page.locator('.media-player-subtitle-hint')).toHaveText('首条字幕 0:30')
    await expect(page.locator('.media-player-subtitles')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 760))
    await expect(page.getByRole('button', { name: '全屏', exact: true })).toBeInViewport()
    expect(
      await page
        .locator('.media-player-buttons')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 900))
    await video.evaluate((element) => {
      element.currentTime = 45
    })
    await expect(page.locator('.media-player-subtitles')).toHaveText('中文字幕测试')
    expect(calls.some((call) => call.path.endsWith('/Subtitles/2/Stream.vtt'))).toBe(true)
    await subtitleSelect.click()
    await page.getByRole('option', { name: '英语', exact: true }).click()
    await expect
      .poll(() => video.evaluate((element) => element.textTracks[0]?.cues?.[0]?.text))
      .toBe('English subtitle test')
    await expect(page.locator('.media-player-subtitles')).toHaveText('English subtitle test')
    await subtitleSelect.click()
    await page.getByRole('option', { name: '字幕关闭', exact: true }).click()
    await expect(video.locator('track')).toHaveCount(0)
    await expect(page.locator('.media-player-subtitles')).toHaveCount(0)
    await subtitleSelect.click()
    await page.getByRole('option', { name: /中文简体/ }).click()
    const bounds = await page.evaluate(() => {
      const library = document.querySelector('.media-library').getBoundingClientRect()
      const player = document.querySelector('.media-player').getBoundingClientRect()
      const video = document.querySelector('.media-video').getBoundingClientRect()
      return {
        panelGap: library.height - player.height,
        videoGap: player.height - video.height,
        widthGap: library.width - video.width,
      }
    })
    expect(bounds.panelGap).toBeLessThanOrEqual(2)
    expect(bounds.videoGap).toBeLessThanOrEqual(2)
    expect(bounds.widthGap).toBeLessThanOrEqual(2)
    await expect(page.getByRole('region', { name: '下载视频' })).toBeHidden()
    await player.focus()
    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((el) => el.paused)).toBe(true)
    await video.evaluate((el) => {
      el.currentTime = 30
    })
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => video.evaluate((el) => Math.round(el.currentTime))).toBe(45)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => video.evaluate((el) => Math.round(el.currentTime))).toBe(30)
    await video.evaluate((el) => {
      el.currentTime = 5
    })
    await run('后退 15 秒')
    await expect.poll(() => video.evaluate((el) => el.currentTime)).toBe(0)
    await run('快进 15 秒')
    await expect.poll(() => video.evaluate((el) => Math.round(el.currentTime))).toBe(15)
    await player.focus()
    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((el) => el.paused)).toBe(false)
    await player.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    // 等待全屏事件同步到控件后再退出，避免连续按键早于原生全屏事件。
    await expect(page.getByRole('button', { name: '退出全屏', exact: true })).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
    await expect(player).toBeVisible()
    await page.screenshot({ path: join(output, '媒体播放-面板.png'), scale: 'css' })
    await page.keyboard.press('Escape')
    await expect(player).toHaveCount(0)
    await expect(page.getByRole('button', { name: '播放视频', exact: true })).toBeFocused()
    await expect
      .poll(() => page.evaluate(async (url) => (await fetch(url)).status, playbackUrl))
      .toBe(403)
    subtitleFailures = 2
    await run('播放视频')
    await expect(page.getByRole('button', { name: '重试字幕' })).toBeVisible()
    await run('重试字幕')
    await expect(page.locator('.media-player-subtitle-hint')).toHaveText('首条字幕 0:30')
    await expect(page.getByRole('button', { name: '重试字幕' })).toHaveCount(0)
    await run('返回详情')
    await page.evaluate(async () => {
      const settings = (await window.cyberHorse.getSettings()).settings
      await window.cyberHorse.saveSettings({ ...settings, player: { startMuted: false } })
    })
    await run('播放视频')
    await expect.poll(() => video.evaluate((element) => element.muted)).toBe(false)
    await run('返回详情')
    await page.evaluate(async () => {
      const settings = (await window.cyberHorse.getSettings()).settings
      await window.cyberHorse.saveSettings({ ...settings, player: { startMuted: true } })
    })
    await page.getByRole('button', { name: /第二章.*00:01:00/ }).click()
    await expect
      .poll(() => video.evaluate((el) => Math.floor(el.currentTime)))
      .toBeGreaterThanOrEqual(60)
    await player.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(player).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
    await expect(page.getByRole('button', { name: '播放视频' })).toBeVisible()
    await expect(page.getByRole('button', { name: /第二章.*00:01:00/ })).toBeFocused()
    await run('隐藏所有封面')
    await expect(page.locator('.media-chapter-image img')).toHaveCount(0)
    await expect(page.locator('.media-card-compact .media-thumb img')).toHaveCount(0)
    await expect(page.locator('.media-chapter-image')).toContainText(['预览已隐藏', '预览已隐藏'])
    await run('显示所有封面')
    await page.locator('.media-more-actions > summary').click()
    await page.getByLabel('选择媒体版本').selectOption('source2')
    await page.locator('.media-detail h2').click()
    await run('播放视频')
    await expect
      .poll(
        () => calls.filter((call) => call.path.endsWith('/stream.mp4')).at(-1)?.query.MediaSourceId,
      )
      .toBe('source2')
    await expect(page.getByRole('button', { name: '选择字幕', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '选择字幕', exact: true })).toHaveText(
      '无独立字幕轨',
    )
    await player.focus()
    await page.keyboard.press('Escape')
    await page.locator('.media-more-actions > summary').click()
    await expect(page.getByLabel('选择媒体版本')).toHaveValue('source2')
    await page.getByLabel('选择媒体版本').selectOption('source1')
    await page.locator('.media-detail h2').click()

    // 直接解码失败后转码；15 秒跳转沿用章节的绝对时间。
    rejectDirectPlayback = true
    await page.getByRole('button', { name: /第二章.*00:01:00/ }).click()
    await expect(page.getByRole('alert')).toContainText('视频无法直接播放')
    await run('转码播放')
    await expect(page.getByRole('button', { name: '暂停播放', exact: true })).toBeEnabled()
    await player.focus()
    await page.keyboard.press('Space')
    await video.evaluate((el) => {
      el.currentTime = 10
    })
    await page.keyboard.press('ArrowLeft')
    await expect
      .poll(() => calls.filter((call) => call.query.VideoCodec).at(-1)?.query.StartTimeTicks)
      .toBe('550000000')
    await run('返回详情')
    rejectDirectPlayback = false

    // 准备期间退出不能由迟到的请求重新打开播放器。
    delayPlaybackDetail = true
    await run('播放视频')
    await player.focus()
    await page.keyboard.press('Escape')
    await expect(player).toHaveCount(0)
    delayPlaybackDetail = false
    await run('播放视频')
    await expect(page.getByRole('button', { name: '暂停播放', exact: true })).toBeEnabled()
    const beforeLeaveUrl = await video.getAttribute('src')
    await run('任务队列')
    await expect(player).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(async (url) => (await fetch(url)).status, beforeLeaveUrl))
      .toBe(403)
    await run('EMBY媒体库')
    await expect(wall()).toHaveCount(30)
    const mediaScroll = page.locator('.media-scroll')
    await mediaScroll.evaluate((element) => {
      element.scrollTop = 320
    })
    await page.getByRole('button', { name: '查看详情：测试影片 8' }).scrollIntoViewIfNeeded()
    const savedScroll = await mediaScroll.evaluate((element) => element.scrollTop)
    expect(savedScroll).toBeGreaterThan(0)
    await run('查看详情：测试影片 8')
    await expect(page.locator('.media-detail h2')).toHaveText('测试影片 8')
    await expect(page.locator('.media-overview-block')).toHaveCount(0)
    await expect(page.getByText('暂无简介')).toHaveCount(0)
    await run('返回')
    await expect(wall()).toHaveCount(30)
    await expect
      .poll(() => mediaScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThanOrEqual(savedScroll - 2)
    expect(await mediaScroll.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(
      savedScroll + 2,
    )
    await run('查看详情：测试影片 ABC-123')
    const backBounds = await page.getByRole('button', { name: '返回', exact: true }).boundingBox()
    expect(backBounds.width).toBeGreaterThanOrEqual(48)
    expect(backBounds.height).toBeGreaterThanOrEqual(48)
    await page.mouse.click(
      backBounds.x + backBounds.width - 3,
      backBounds.y + backBounds.height / 2,
    )
    await expect(page.locator('.media-detail')).toHaveCount(0)
    await expect(libraryPicker).toContainText('电影')
    await run('查看详情：测试影片 ABC-123')
    await run('剧情')
    await expect(wall()).toHaveCount(2)
    expect(calls.at(-1)?.path).not.toBe('')
    expect(calls.some((v) => v.query.ParentId === 'lib1' && v.query.Genres === '剧情')).toBe(true)
    await run('返回')
    await expect(page.locator('.media-detail h2')).toHaveText('测试影片 ABC-123')
    await run('测试演员 · 主角')
    await expect(wall()).toHaveCount(2)
    expect(calls.some((v) => v.query.ParentId === 'lib1' && v.query.PersonIds === '12')).toBe(true)
    await run('我的收藏')
    await expect(wall()).toHaveCount(1)
    await wall().hover()
    await run('取消收藏：测试影片 2')
    await expect(page.getByRole('heading', { name: '当前媒体库暂无收藏' })).toBeVisible()
    await libraryPicker.click()
    await libraryOptions.getByRole('option', { name: '电影' }).click()
    await expect(wall()).toHaveCount(30)
    denyFavorite = true
    await wall().first().hover()
    await run('收藏：测试影片 ABC-123')
    await expect(page.getByRole('alert')).toContainText('权限')
    await expect(
      page.getByRole('button', { name: '收藏：测试影片 ABC-123', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false')
    denyFavorite = false
    await run('收藏：测试影片 ABC-123')
    await expect(page.getByRole('button', { name: '取消收藏：测试影片 ABC-123' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    for (const [name, sort] of [
      ['播放日期', 'DatePlayed'],
      ['播放次数', 'PlayCount'],
      ['加入日期', 'DateCreated'],
    ]) {
      await run(name)
      await expect(wall()).toHaveCount(30)
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      const request = calls
        .filter((call) => call.path.endsWith('/Items') && call.query.ParentId)
        .at(-1)
      expect(request.query.SortBy).toBe(sort)
      expect(request.query.SearchTerm).toBeUndefined()
    }
    await libraryPicker.click()
    await libraryOptions.getByRole('option', { name: '电影' }).click()
    await wall().first().click({ button: 'right' })
    await contextMenu.getByRole('button', { name: '下载', exact: true }).click()
    await run('任务队列')
    await page.getByRole('tab', { name: /^已完成/ }).click()
    await expect(page.locator('.media-download-task')).toContainText('下载完成')
    await expect(page.locator('.task-panel')).toBeVisible()
    await expect(page.getByRole('tab', { name: /^已完成/ }).locator('.count-label')).toHaveText(
      String(await page.locator('.queue-card').count()),
    )
    await expect(page.getByRole('button', { name: '清空记录' })).toBeEnabled()
    for (const theme of ['深色模式', '浅色模式']) {
      await run(theme)
      await page.screenshot({
        path: join(output, `媒体任务-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
    }
    await run('跟随系统')
    const jobs = await page.evaluate(() => window.cyberHorse.getMediaDownloads())
    expect(await readFile(jobs.at(-1).path)).toEqual(payload)
    await run('EMBY媒体库')
    await expect(wall()).toHaveCount(30)
    let releaseQueueDetail
    queueDetailGate = new Promise((resolve) => {
      releaseQueueDetail = resolve
    })
    await page
      .getByRole('button', { name: '查看详情：测试影片 3', exact: true })
      .click({ button: 'right' })
    const queuedMenu = page.getByRole('dialog', { name: '快捷操作：测试影片 3', exact: true })
    await expect(queuedMenu.getByRole('button', { name: '视频破解' })).toBeEnabled()
    await queuedMenu.getByRole('button', { name: '视频破解' }).click()
    await expect(queuedMenu).toHaveCount(0)
    await expect(page.locator('.toast')).toContainText('已加入队列')
    await page
      .getByRole('button', { name: '查看详情：测试影片 4', exact: true })
      .click({ button: 'right' })
    const nextMenu = page.getByRole('dialog', { name: '快捷操作：测试影片 4', exact: true })
    await expect(nextMenu.getByRole('button', { name: '中文字幕' })).toBeEnabled()
    await nextMenu.getByRole('button', { name: '中文字幕' }).click()
    await expect(page.locator('.toast')).toContainText('已加入队列')
    const queued = await page.evaluate(async () => {
      const records = await window.cyberHorse.getMediaProcesses()
      const duplicate = await window.cyberHorse.enqueueMediaProcess({
        id: 'v3',
        sourceId: 'source2',
        kind: 'subtitle',
        name: '测试影片 3',
      })
      return { records, duplicate }
    })
    expect(
      queued.records.filter((record) => ['pending', 'running'].includes(record.status)),
    ).toHaveLength(2)
    expect(queued.duplicate).toEqual({
      id: queued.records.find((record) => record.itemId === 'v3').id,
      alreadyQueued: true,
    })
    await page.evaluate(
      async (ids) => {
        for (const id of ids) await window.cyberHorse.cancelMediaProcess(id)
      },
      queued.records.map((record) => record.id),
    )
    releaseQueueDetail()
    queueDetailGate = null
    await expect
      .poll(
        async () => (await page.evaluate(() => window.cyberHorse.getMediaQueueSummary())).active,
      )
      .toBe(0)
    await page.evaluate(() => window.cyberHorse.clearMediaTasks())
    await run('查看详情：测试影片 ABC-123')
    slow = true
    await page.locator('.media-more-actions > summary').click()
    await run('下载')
    await run('任务队列')
    await expect(page.getByRole('button', { name: '清空记录' })).toBeDisabled()
    await run('取消下载')
    await page.getByRole('tab', { name: /^未完成/ }).click()
    await expect(page.locator('.media-download-task')).toContainText('下载已取消')
    slow = false
    await run('EMBY媒体库')
    await expect(wall()).toHaveCount(30)
    await run('查看详情：测试影片 ABC-123')
    const progressMarker = join(tools, 'progress-jasna.txt')
    await writeFile(progressMarker, '')
    await page.locator('.media-cover-play').click({ button: 'right' })
    await contextMenu.getByRole('button', { name: '视频破解' }).click()
    await expect(page.locator('.media-detail h2')).toHaveText('测试影片 ABC-123')
    await expect(contextMenu).toHaveCount(0)
    await expect(page.locator('.toast')).toContainText('可继续浏览')
    await related.click({ button: 'right' })
    await expect(relatedContext.getByRole('button', { name: '下载' })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(page.locator('.nav-count')).toHaveText('1')
    expect(await page.evaluate(() => window.cyberHorse.getMediaQueueSummary())).toEqual({
      active: 1,
    })
    await run('任务队列')
    await expect(page.locator('.media-download-task')).toContainText('视频破解', {
      timeout: 30000,
    })
    await expect(page.locator('.task-bottom')).toContainText('正在运行')
    await expect(page.getByRole('progressbar', { name: '视频破解当前阶段进度' })).toHaveAttribute(
      'value',
      '42',
    )
    await expect(page.locator('.media-download-task')).toContainText('已完成 0/1 个文件')
    await run('展开运行日志')
    await expect(page.getByRole('log', { name: '运行日志' })).toContainText(
      '媒体库 · 测试影片 ABC-123',
    )
    await expect(page.getByText('处理日志与执行记录')).toHaveCount(0)
    expect(await app.evaluate(() => globalThis.mediaFileDialogCount)).toBe(0)
    for (const theme of ['深色模式', '浅色模式']) {
      await run(theme)
      await page.screenshot({
        path: join(output, `媒体库-自动处理队列-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
    }
    await run('跟随系统')
    await unlink(progressMarker)
    await page.getByRole('tab', { name: /^已完成/ }).click()
    await expect(
      page.locator('.media-download-task').filter({ hasText: '视频破解' }),
    ).toContainText('媒体处理与回写完成', { timeout: 45000 })
    const processes = await page.evaluate(() => window.cyberHorse.getMediaProcesses())
    expect(processes[0].status).toBe('completed')
    await expect(page.locator('.nav-count')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '清空记录' })).toBeEnabled()
    await run('清空记录')
    await expect(page.locator('.media-download-task')).toHaveCount(0)
    expect(await page.evaluate(() => window.cyberHorse.getMediaDownloads())).toEqual([])
    expect(await page.evaluate(() => window.cyberHorse.getMediaProcesses())).toEqual([])
    expect(await readFile(jobs.at(-1).path)).toEqual(payload)
    await expect(readFile(join(originalFolder, 'ABC-123.mp4'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(originalFolder, '备注.txt'), 'utf8')).toBe('不得修改的用户备注')
    await run('EMBY媒体库')
    await expect(wall()).toHaveCount(30)
    await run('查看详情：测试影片 ABC-123')
    if (await page.getByRole('button', { name: '关闭提示' }).isVisible()) await run('关闭提示')
    const chapters = page.locator('.media-chapters')
    await chapters.scrollIntoViewIfNeeded()
    await chapters.evaluate((element) => {
      element.style.width = '320px'
    })
    await expect
      .poll(() => chapters.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeGreaterThan(0)
    await page.locator('.media-chapter-section h3').hover()
    await page.mouse.wheel(0, 320)
    await expect.poll(() => chapters.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    await page.mouse.wheel(0, -320)
    await expect.poll(() => chapters.evaluate((element) => element.scrollLeft)).toBe(0)
    await chapters.evaluate((element) => {
      element.style.removeProperty('width')
    })
    const relatedList = page.locator('.media-related-list')
    await relatedList.scrollIntoViewIfNeeded()
    await expect
      .poll(() => relatedList.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeGreaterThan(0)
    await page.locator('.media-related-section h3').hover()
    const verticalBefore = await page
      .locator('.media-scroll')
      .evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, 320)
    await expect
      .poll(() => relatedList.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)
    expect(await page.locator('.media-scroll').evaluate((element) => element.scrollTop)).toBe(
      verticalBefore,
    )
    await relatedList.hover()
    await page.mouse.wheel(0, -320)
    await expect.poll(() => relatedList.evaluate((element) => element.scrollLeft)).toBe(0)
    await page.mouse.wheel(200, 0)
    await expect
      .poll(() => relatedList.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)
    await relatedList.evaluate((element) => {
      element.scrollLeft = 0
    })
    await page.mouse.wheel(0, -240)
    await expect
      .poll(() => page.locator('.media-scroll').evaluate((element) => element.scrollTop))
      .toBeLessThan(verticalBefore)
    for (const theme of ['初号机主题', '深色模式', '浅色模式', '跟随系统']) {
      await run(theme)
      await page.locator('.media-scroll').evaluate((element) => {
        element.scrollTop = 0
      })
      await page.screenshot({
        path: join(output, `媒体详情-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
      await page.locator('.media-chapter-section').scrollIntoViewIfNeeded()
      await page.screenshot({
        path: join(output, `媒体章节-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
      await page.locator('.media-related-list').scrollIntoViewIfNeeded()
      await page.screenshot({
        path: join(output, `媒体相关推荐-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 760))
    await checkLayout()
    await page.locator('.media-scroll').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.screenshot({ path: join(output, '媒体详情-最小窗口.png'), scale: 'css' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await checkLayout()
    await page.screenshot({ path: join(output, '媒体详情-最大化.png'), scale: 'css' })
    await run('展开简介')
    await page.screenshot({ path: join(output, '媒体详情-展开信息.png'), scale: 'css' })
    await page.locator('.media-more-actions > summary').click()
    await page.screenshot({ path: join(output, '媒体详情-更多操作.png'), scale: 'css' })
    await run('删除媒体')
    expect(deleted.size).toBe(0)
    await app.evaluate(() => {
      globalThis.confirmMediaDelete = 1
    })
    await page.locator('.media-more-actions > summary').click()
    await run('删除媒体')
    await expect(wall()).toHaveCount(30)
    expect(deleted.has('v1')).toBe(true)
    const deleteCard = page.getByRole('button', { name: '查看详情：测试影片 3', exact: true })
    const deleteMenu = page.getByRole('dialog', { name: '快捷操作：测试影片 3', exact: true })
    await app.evaluate(() => {
      globalThis.confirmMediaDelete = 0
    })
    await deleteCard.click({ button: 'right' })
    await expect(deleteMenu.getByRole('button', { name: '删除媒体' })).toBeEnabled()
    await deleteMenu.getByRole('button', { name: '删除媒体' }).click()
    await expect(deleteCard).toBeVisible()
    expect(deleted.has('v3')).toBe(false)
    await app.evaluate(() => {
      globalThis.confirmMediaDelete = 1
    })
    await deleteCard.click({ button: 'right' })
    await deleteMenu.getByRole('button', { name: '删除媒体' }).click()
    await expect(deleteCard).toHaveCount(0)
    await expect.poll(() => deleted.has('v3')).toBe(true)
    await expect(page.locator('.media-detail')).toHaveCount(0)
    await run('刷新媒体库')
    await expect(page.getByRole('status')).toContainText('提交刷新请求')
    const invalid = await page.evaluate(async () => {
      try {
        await window.cyberHorse.getMediaDetail('../secret')
        return false
      } catch {
        return true
      }
    })
    expect(invalid).toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (window.isMaximized()) window.unmaximize()
      window.setSize(1060, 760)
    })
    await checkLayout()
    await page.screenshot({
      path: join(output, '媒体库-已连接-最小窗口.png'),
      scale: 'css',
      animations: 'disabled',
    })
    await libraryPicker.click()
    await expect(libraryOptions).toBeVisible()
    await checkLayout()
    await page.screenshot({
      path: join(output, '媒体库-选择菜单-最小窗口.png'),
      scale: 'css',
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await checkLayout()
    await page.screenshot({
      path: join(output, '媒体库-已连接-最大化.png'),
      scale: 'css',
      animations: 'disabled',
    })
    await libraryPicker.click()
    await expect(libraryOptions).toBeVisible()
    await checkLayout()
    await page.screenshot({
      path: join(output, '媒体库-选择菜单-最大化.png'),
      scale: 'css',
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await writeFile(
      join(output, 'media-library-result.json'),
      JSON.stringify(
        {
          result: '通过',
          authCount,
          calls,
          processes,
          downloads: await page.evaluate(() => window.cyberHorse.getMediaDownloads()),
        },
        null,
        2,
      ),
    )
  } catch (error) {
    await page.screenshot({ path: join(output, '媒体交互-失败现场.png'), scale: 'css' })
    await writeFile(
      join(output, '媒体交互-失败.txt'),
      String(error) + '\n' + (await page.locator('body').innerText()),
    )
    throw error
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate((settings) => window.cyberHorse.saveSettings(settings), saved)
    await app.evaluate(({ dialog, shell }) => {
      dialog.showOpenDialog = globalThis.mediaOriginalDialog
      dialog.showMessageBox = globalThis.mediaOriginalMessage
      shell.openExternal = globalThis.mediaOriginalOpenExternal
    })
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}
