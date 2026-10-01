import { _electron as electron, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// 只下载本机服务器生成的文本替身，不接触真实媒体或调用系统关机。
const output = resolve('test-results')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'exit-profile-'))
const downloads = await mkdtemp(join(tmpdir(), 'cyber-horse-exit-downloads-'))
let sent = 0
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path.endsWith('/stream')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '10000000' })
    const timer = setInterval(() => {
      res.write(Buffer.alloc(1024, 65))
      sent++
    }, 30)
    res.on('close', () => clearInterval(timer))
    return
  }
  res.setHeader('Content-Type', 'application/json')
  if (path.endsWith('/AuthenticateByName'))
    res.end(JSON.stringify({ AccessToken: 'fixture', ServerId: 'fixture', User: { Id: 'u1' } }))
  else if (path.endsWith('/Items/movie1'))
    res.end(
      JSON.stringify({
        Id: 'movie1',
        Name: '退出保护替身',
        Type: 'Movie',
        MediaSources: [
          { Id: 'source1', Path: '/fixture/TEST-001.mp4', Container: 'mp4', Size: 10000000 },
        ],
      }),
    )
  else res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
try {
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  await app.evaluate(({ dialog }) => {
    globalThis.exitDialogs = []
    dialog.showMessageBox = async (_window, options) => {
      globalThis.exitDialogs.push(options)
      return new Promise((done) => {
        globalThis.answerExit = (response) => done({ response })
      })
    }
  })
  const prompts = () => app.evaluate(() => globalThis.exitDialogs)
  const answer = (response) => app.evaluate((_, value) => globalThis.answerExit(value), response)
  await page.evaluate(() => window.cyberHorse.startShutdown({ mode: 'timer', minutes: 60 }))
  // 标题栏关闭及重复请求，只展示一次；取消不改变定时关机计划。
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await expect.poll(async () => (await prompts()).length).toBe(1)
  expect((await prompts())[0]).toMatchObject({
    message: '确定退出程序？',
    defaultId: 0,
    cancelId: 0,
  })
  await answer(0)
  expect((await page.evaluate(() => window.cyberHorse.getShutdownState())).phase).toBe('countdown')
  // 系统菜单／app.quit 也经过相同拦截，取消后窗口与采样仍可用。
  await app.evaluate(({ app }) => app.quit())
  await expect.poll(async () => (await prompts()).length).toBe(2)
  await answer(0)
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  await page.evaluate(
    async ({ url, downloads }) => {
      const { settings } = await window.cyberHorse.getSettings()
      settings.paths.download = downloads
      settings.mediaServer.serverUrl = url
      settings.mediaServer.username = '隔离测试'
      await window.cyberHorse.saveSettings(settings)
      await window.cyberHorse.startMediaDownload({ id: 'movie1', sourceId: 'source1' })
    },
    { url: `http://127.0.0.1:${server.address().port}/emby`, downloads },
  )
  await expect.poll(() => sent).toBeGreaterThan(2)
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await expect.poll(async () => (await prompts()).length).toBe(3)
  expect((await prompts())[2]).toMatchObject({
    type: 'warning',
    buttons: ['继续使用', '停止任务并退出'],
    defaultId: 0,
    cancelId: 0,
  })
  await answer(0)
  expect((await page.evaluate(() => window.cyberHorse.getMediaDownloads()))[0].status).toBe(
    'running',
  )
  const previous = sent
  await expect.poll(() => sent).toBeGreaterThan(previous)
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  await expect.poll(async () => (await prompts()).length).toBe(4)
  const closed = app.waitForEvent('close')
  await answer(1)
  await closed
  app = undefined
  const files = await readdir(downloads)
  expect(files.some((name) => name.endsWith('.mp4'))).toBe(false)
  expect(files.length).toBeGreaterThan(0)
  const record = JSON.parse(await readFile(join(profile, 'media-downloads.json'), 'utf8'))
  expect(JSON.stringify(record)).toContain('cancelled')
  console.log(
    '退出定向验证通过：空闲／运行中提示、重复关闭、取消保留任务与关机计划、系统退出拦截、确认后下载收尾并保留残留。',
  )
} finally {
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        globalThis.answerExit?.(1)
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
  }
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
