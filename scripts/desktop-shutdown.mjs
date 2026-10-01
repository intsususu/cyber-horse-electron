import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const output = resolve('test-results')
await mkdir(output, { recursive: true })
const dataDirectory = await mkdtemp(join(output, 'shutdown-profile-'))
const environment = { ...process.env, CYBER_HORSE_DATA_DIR: dataDirectory }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.ELECTRON_RENDERER_URL
let app
let page
const errors = []
const layouts = []
async function launch() {
  app = await electron.launch({
    args: ['.', '--disable-background-timer-throttling'],
    env: environment,
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  await expect.poll(async () => (await state()).testMode).toBe(true)
}
const state = () => page.evaluate(() => window.cyberHorse.getShutdownState())
async function capture(name) {
  const layout = await page
    .getByRole('dialog', { name: '定时关机', exact: true })
    .evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
        overflow: dialog.scrollHeight - dialog.clientHeight,
      }
    })
  expect(layout.left).toBeGreaterThanOrEqual(0)
  expect(layout.right).toBeLessThanOrEqual(layout.width)
  expect(layout.top).toBeGreaterThanOrEqual(0)
  expect(layout.bottom).toBeLessThanOrEqual(layout.height)
  expect(layout.overflow).toBeLessThanOrEqual(1)
  layouts.push({ name, ...layout })
  await page.screenshot({
    path: join(output, `定时关机-${name}.png`),
    animations: 'disabled',
    scale: 'css',
  })
}
const open = () => page.getByRole('button', { name: '定时关机', exact: true }).click()
const allTasks = () =>
  page.getByRole('radio', { name: '所有任务结束后关机（包含失败）', exact: true }).check()
async function enqueueFailure(id) {
  return page.evaluate(
    async (id) =>
      window.cyberHorse.enqueueMediaProcess({ id, kind: 'subtitle', name: '关机测试：预检失败' }),
    id,
  )
}
try {
  await launch()
  const rejected = await page.evaluate(async () => {
    const results = await Promise.allSettled([
      window.cyberHorse.startShutdown({ mode: 'timer', minutes: 0 }),
      window.cyberHorse.startShutdown({ mode: 'tasks', command: '任意命令' }),
    ])
    return results.every((result) => result.status === 'rejected')
  })
  expect(rejected).toBe(true)
  for (const [name, button] of [
    ['初号机', '初号机主题'],
    ['深色', '深色模式'],
    ['浅色', '浅色模式'],
    ['钢铁侠', '钢铁侠主题'],
  ]) {
    await page.getByRole('button', { name: button, exact: true }).click()
    await open()
    await allTasks()
    await expect(page.getByRole('dialog')).toContainText('不会执行系统关机')
    await capture(name)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '定时关机', exact: true })).toBeFocused()
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 760))
  await open()
  await allTasks()
  await capture('最小窗口')
  await page.getByRole('radio', { name: '按时间倒计时', exact: true }).check()
  await capture('最小窗口-按时间')
  await page.getByRole('spinbutton', { name: '倒计时时长' }).fill('0')
  await expect(page.getByRole('button', { name: '开始倒计时', exact: true })).toBeDisabled()
  await page.getByRole('spinbutton', { name: '倒计时时长' }).fill('1')
  await page.getByRole('button', { name: '开始倒计时', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消倒计时', exact: true })).toBeVisible()
  expect((await state()).mode).toBe('timer')
  await page.getByRole('button', { name: '取消倒计时', exact: true }).click()
  expect((await state()).phase).toBe('idle')
  await page.evaluate(() => window.cyberHorse.startShutdown({ mode: 'timer', minutes: 1 }))
  await enqueueFailure('shutdown-timer-failed')
  await expect.poll(async () => (await state()).phase).toBe('failed')
  expect((await state()).message).toContain('任务失败，已取消')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
  await page.emulateMedia({ colorScheme: 'light' })
  await open()
  await allTasks()
  await capture('最大化')
  await page.getByRole('button', { name: '开启任务结束后关机', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消任务结束后关机', exact: true })).toBeVisible()
  await expect.poll(async () => (await state()).phase).toBe('waiting')
  // 未配置服务器的复合任务只经过失败预检，不触碰媒体或外部工具。
  const failures = await Promise.all([
    enqueueFailure('shutdown-failed-1'),
    enqueueFailure('shutdown-failed-2'),
  ])
  await expect
    .poll(async () => {
      const jobs = await page.evaluate(() => window.cyberHorse.getMediaProcesses())
      return jobs
        .filter((job) => failures.some((result) => result.id === job.id))
        .map((job) => job.status)
    })
    .toEqual(['failed', 'failed'])
  await expect.poll(async () => (await state()).phase).toBe('countdown')
  expect((await state()).remainingSeconds).toBeGreaterThan(50)
  const another = await enqueueFailure('shutdown-failed-3')
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.cyberHorse.getMediaProcesses())).find(
          (job) => job.id === another.id,
        )?.status,
    )
    .toBe('failed')
  await expect.poll(async () => (await state()).remainingSeconds).toBeGreaterThan(55)
  await page.getByRole('button', { name: '取消倒计时', exact: true }).click()
  expect((await state()).phase).toBe('idle')
  // 旧失败记录不能让重新开启的空队列立即关机。
  await page.evaluate(() => window.cyberHorse.startShutdown({ mode: 'tasks' }))
  expect((await state()).phase).toBe('waiting')
  await enqueueFailure('shutdown-failed-4')
  await expect.poll(async () => (await state()).phase).toBe('countdown')
  // 仅推进隔离进程内时钟；适配器已通过状态确认是替身。
  await app.evaluate(() => {
    globalThis.shutdownOriginalNow = Date.now
    const original = Date.now
    Date.now = () => original() + 61000
  })
  await expect.poll(async () => (await state()).phase).toBe('requested')
  await app.evaluate(() => {
    Date.now = globalThis.shutdownOriginalNow
  })
  const requests = (await readFile(join(dataDirectory, 'shutdown-test.jsonl'), 'utf8'))
    .trim()
    .split('\n')
  expect(requests).toHaveLength(1)
  expect(JSON.parse(requests[0]).event).toBe('关机请求')
  await closeDesktop(app)
  app = null
  await launch()
  expect((await state()).phase).toBe('idle')
  await page.evaluate(() => window.cyberHorse.startShutdown({ mode: 'timer', minutes: 1 }))
  await closeDesktop(app)
  app = null
  await launch()
  expect((await state()).phase).toBe('idle')
  expect(
    (await readFile(join(dataDirectory, 'shutdown-test.jsonl'), 'utf8')).trim().split('\n'),
  ).toHaveLength(1)
  expect(errors).toEqual([])
  await writeFile(
    join(output, 'desktop-shutdown-result.json'),
    JSON.stringify({ result: '通过', errors, layouts, requests: requests.length }, null, 2),
  )
  console.log(
    '定时关机桌面验证通过：时间模式、所有任务结束包含失败、新任务重置、取消、重启、四种主题与窗口尺寸；系统关机仅使用替身。',
  )
} finally {
  if (app) await closeDesktop(app)
}
