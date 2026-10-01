import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const output = resolve('test-results')
await mkdir(output, { recursive: true })
const dataDirectory = await mkdtemp(join(output, 'queue-profile-'))
const environment = { ...process.env, CYBER_HORSE_DATA_DIR: dataDirectory }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.ELECTRON_RENDERER_URL
const app = await electron.launch({
  args: ['.', '--disable-background-timer-throttling'],
  env: environment,
})
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const run = (name) => page.getByRole('button', { name, exact: true }).click()
const tab = (name) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
const layouts = []
async function capture(name) {
  const layout = await page.evaluate(() => {
    const main = document.querySelector('.main-scroll')
    const panel = document.querySelector('.task-panel').getBoundingClientRect()
    const logs = document.querySelector('.logs-panel').getBoundingClientRect()
    const bounds = main.getBoundingClientRect()
    return {
      name: '',
      horizontal: main.scrollWidth - main.clientWidth,
      vertical: main.scrollHeight - main.clientHeight,
      panelBottom: panel.bottom,
      logsTop: logs.top,
      logsBottom: logs.bottom,
      mainBottom: bounds.bottom,
    }
  })
  expect(layout.horizontal).toBeLessThanOrEqual(1)
  expect(layout.vertical).toBeLessThanOrEqual(1)
  expect(layout.panelBottom).toBeLessThan(layout.logsTop)
  expect(layout.logsBottom).toBeLessThan(layout.mainBottom)
  layouts.push({ ...layout, name })
  await page.screenshot({
    path: join(output, `队列改版-${name}.png`),
    scale: 'css',
    animations: 'disabled',
  })
}
try {
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  // 专用隔离进程中通过 IPC 替身投影混合任务，不运行工具或操作真实媒体。
  await app.evaluate(({ ipcMain }) => {
    const state = {
      pipeline: {
        id: 'queue-pipeline',
        status: 'succeeded',
        startedAt: '2026-09-29T02:00:00Z',
        endedAt: '2026-09-29T02:20:00Z',
        tasks: ['元数据刮削', '归档到 NAS'].map((title, index) => ({
          id: index ? 'archive' : 'metadata',
          title,
          status: 'succeeded',
          completed: 8,
          total: 8,
          skipped: 0,
          progress: 100,
          message: '已完成 8 个文件。',
          startedAt: '2026-09-29T02:00:00Z',
          endedAt: '2026-09-29T02:20:00Z',
        })),
        files: Array.from({ length: 8 }, (_, index) => ({
          path: `验证文件-${index}.mp4`,
          name: `验证文件-${index}.mp4`,
          relativePath: `验证文件-${index}.mp4`,
          size: 1024,
          modifiedAt: 0,
        })),
        source: '',
        mode: 'all',
        logs: [],
        message: '所选步骤处理完成。',
        journal: '验证执行记录.jsonl',
        outputs: [],
        resultFiles: [],
      },
      processes: Array.from({ length: 18 }, (_, index) => ({
        id: `process-${index}`,
        itemId: `movie-${index}`,
        sourceId: 'source',
        name:
          index === 1
            ? '示例影片 02 · 当前正在处理的视频'
            : `示例影片 ${String(index + 1).padStart(2, '0')} · 测试队列文件`,
        kind: 'video',
        original: '',
        affected: [],
        steps: ['视频破解', '元数据刮削'],
        status:
          index === 0 ? 'completed' : index === 1 ? 'running' : index === 17 ? 'failed' : 'pending',
        message:
          index === 1
            ? '正在处理视频，完成后继续元数据刮削。'
            : index === 0
              ? '媒体处理与回写完成。'
              : index === 17
                ? '测试工具返回失败，源文件已保留。'
                : '等待串行处理。',
        pipeline:
          index === 1
            ? {
                id: 'process-pipeline',
                status: 'running',
                startedAt: '2026-09-29T02:21:00Z',
                tasks: [
                  {
                    id: 'video',
                    title: '视频破解',
                    status: 'running',
                    progress: 0,
                    completed: 0,
                    total: 1,
                    skipped: 0,
                    current: { phase: 'restore', percent: 42, fps: 35, etaSeconds: 126 },
                    message: '处理视频中。',
                  },
                  {
                    id: 'metadata',
                    title: '元数据刮削',
                    status: 'pending',
                    progress: 0,
                    completed: 0,
                    total: 1,
                    skipped: 0,
                    message: '等待执行。',
                  },
                ],
                logs: [
                  {
                    id: 1,
                    time: '10:21:00',
                    level: 'info',
                    text: '测试工具报告真实阶段进度 42%。',
                  },
                ],
                files: [],
                source: '',
                mode: 'selected',
                message: '处理中。',
                journal: '',
                outputs: [],
                resultFiles: [],
              }
            : null,
        downloadId: index === 1 ? 'child-download' : '',
        journal: `验证记录-${index}.jsonl`,
      })),
      downloads: [
        {
          id: 'child-download',
          itemId: 'movie-1',
          sourceId: 'source',
          name: '已合并的下载子项',
          status: 'completed',
          received: 1024,
          total: 1024,
          path: '',
          temporary: '',
          message: '下载完成。',
          started: '2026-09-29T02:20:00Z',
          ended: '2026-09-29T02:21:00Z',
        },
      ],
      failRead: false,
      cancellations: [],
    }
    const completed = state.processes[0]
    completed.startedAt = '2026-09-29T02:00:00Z'
    completed.endedAt = '2026-09-29T02:20:00Z'
    completed.downloadId = 'completed-download'
    state.downloads.push({
      ...state.downloads[0],
      id: 'completed-download',
      itemId: completed.itemId,
      name: '已完成任务的下载子项',
      started: '2026-09-29T02:00:00Z',
      ended: '2026-09-29T02:01:00Z',
    })
    completed.pipeline = {
      ...state.processes[1].pipeline,
      status: 'succeeded',
      startedAt: '2026-09-29T02:01:00Z',
      endedAt: '2026-09-29T02:14:00Z',
      tasks: state.processes[1].pipeline.tasks.map((task, index) => ({
        ...task,
        status: 'succeeded',
        current: undefined,
        progress: 100,
        completed: 1,
        startedAt: index ? '2026-09-29T02:06:00Z' : '2026-09-29T02:01:00Z',
        endedAt: index ? '2026-09-29T02:14:00Z' : '2026-09-29T02:06:00Z',
        message: '处理完成。',
      })),
    }
    const active = state.processes[1]
    active.startedAt = new Date(Date.now() - 180000).toISOString()
    active.pipeline.tasks[0].startedAt = new Date(Date.now() - 120000).toISOString()
    globalThis.queueFixture = state
    const bind = (channel, handler) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    bind('pipeline:state', () => state.pipeline)
    bind('media:downloads', () => state.downloads)
    bind('media:queue-summary', () => ({
      active: state.processes.filter((task) => ['running', 'pending'].includes(task.status)).length,
    }))
    bind('media:processes', () => {
      if (state.failRead) throw new Error('测试读取失败')
      return state.processes
    })
    bind('media:cancel-process', (_event, id) => {
      state.cancellations.push(id)
      const task = state.processes.find((item) => item.id === id)
      task.status = 'cancelled'
      task.message = '已取消等待。'
    })
    bind('media:clear-tasks', () => {
      state.processes = []
      state.downloads = []
      state.pipeline = null
    })
  })
  await page.reload()
  await run('任务队列')
  if (await page.getByRole('button', { name: '关闭提示' }).isVisible()) await run('关闭提示')
  await expect(tab('进行中')).toHaveAttribute('aria-selected', 'true')
  await expect(tab('进行中')).toContainText('16')
  await expect(page.locator('.nav-count')).toHaveText('16')
  await expect(tab('已完成')).toContainText('3')
  await expect(tab('未完成')).toContainText('1')
  await expect(page.getByRole('log', { name: '运行日志' })).toBeHidden()
  await expect(page.getByRole('button', { name: '展开运行日志' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  const current = page.getByRole('region', { name: '正在执行' })
  const waiting = page.getByRole('region', { name: '等待执行' })
  await expect(current.locator('strong')).toHaveText('示例影片 02 · 当前正在处理的视频')
  await expect(waiting.locator('strong').first()).toContainText('示例影片 03')
  await expect(page.getByRole('tabpanel')).not.toContainText('所选步骤处理完成')
  await expect(page.getByText('已合并的下载子项')).toHaveCount(0)
  await expect(current.getByRole('progressbar')).toHaveAttribute('value', '42')
  const overallTiming = current.locator('.queue-card-summary .queue-duration')
  await expect(overallTiming).toContainText('已运行：')
  const initialTiming = await overallTiming.innerText()
  await expect.poll(() => overallTiming.innerText()).not.toBe(initialTiming)
  await expect(page.getByRole('button', { name: '清空记录' })).toBeDisabled()
  for (const theme of ['浅色模式', '深色模式', '初号机主题', '钢铁侠主题']) {
    await run(theme)
    await capture(theme)
  }
  await run('钢铁侠主题')
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ironman')
    await capture(`钢铁侠-系统切换-${scheme}`)
  }
  await run('初号机主题')
  await run('展开运行日志')
  await expect(page.getByRole('log')).toContainText('测试工具报告真实阶段进度')
  await page.getByRole('button', { name: '筛选日志', exact: true }).click()
  await page.getByRole('option', { name: '仅提示', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('测试工具返回失败')
  await capture('日志展开')
  await run('收起运行日志')
  await expect(page.getByRole('button', { name: '展开运行日志' })).toBeFocused()
  await tab('进行中').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab('已完成')).toBeFocused()
  await expect(page.getByRole('tabpanel').locator('.queue-card')).toHaveCount(3)
  await expect(page.getByRole('heading', { name: '已完成任务', exact: true })).toHaveCount(0)
  const completedCard = page.locator('.queue-card').filter({ hasText: '示例影片 01' })
  await expect(completedCard.locator('.queue-card-summary .queue-duration')).toContainText(
    '总耗时：20 分',
  )
  await completedCard.locator(':scope > details > summary').click()
  const steps = completedCard.locator('.media-process-step')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toContainText('下载原文件')
  await expect(steps.nth(0)).toContainText('耗时：1 分')
  await expect(steps.nth(1)).toContainText('耗时：5 分')
  await expect(steps.nth(2)).toContainText('耗时：8 分')
  await expect(completedCard.locator('.queue-records .queue-timing').first()).toBeHidden()
  await steps.last().scrollIntoViewIfNeeded()
  await expect(steps.nth(1).getByText('耗时：5 分')).toBeInViewport()
  await expect(steps.nth(2).getByText('耗时：8 分')).toBeInViewport()
  for (const theme of ['深色模式', '浅色模式']) {
    await run(theme)
    await capture(`执行时间-${theme}`)
  }
  await run('初号机主题')
  const recordsToggle = completedCard.getByText('起止时间与执行记录', { exact: true })
  await recordsToggle.focus()
  await page.keyboard.press('Enter')
  await expect(completedCard.locator('.queue-records time').first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(completedCard.locator('.queue-records time').first()).toBeHidden()
  await tab('已完成').focus()
  await capture('已完成')
  await page.keyboard.press('End')
  await expect(tab('未完成')).toBeFocused()
  await expect(page.getByRole('heading', { name: '失败、取消与跳过', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tabpanel')).toContainText('源文件已保留')
  await page.keyboard.press('Home')
  await expect(tab('进行中')).toBeFocused()
  await waiting.getByRole('button', { name: '取消媒体处理' }).first().click()
  await expect(tab('进行中')).toContainText('15')
  await expect(page.locator('.nav-count')).toHaveText('15')
  expect(await app.evaluate(() => globalThis.queueFixture.cancellations)).toEqual(['process-2'])
  await tab('未完成').click()
  await expect(page.getByRole('tabpanel')).toContainText('已取消等待')
  await tab('进行中').click()
  await app.evaluate(() => {
    globalThis.queueFixture.processes[1].pipeline.tasks[0].current.percent = null
  })
  await expect(current.getByRole('progressbar')).not.toHaveAttribute('value')
  await expect(current).toContainText('视频处理中…')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 760))
  await capture('最小窗口')
  await run('展开运行日志')
  await capture('最小窗口-日志展开')
  await run('收起运行日志')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
  await capture('最大化')
  await app.evaluate(() => {
    const task = globalThis.queueFixture.processes[1]
    task.status = 'completed'
    task.message = '媒体处理与回写完成。'
  })
  await expect(current).toHaveCount(0)
  await expect(tab('已完成')).toContainText('4')
  await tab('已完成').click()
  await expect(page.getByRole('tabpanel').locator('.queue-card')).toHaveCount(4)
  await tab('进行中').click()
  await app.evaluate(() => {
    globalThis.queueFixture.failRead = true
  })
  await expect(page.getByRole('alert')).toContainText('媒体库任务读取失败')
  await expect(page.getByRole('button', { name: '清空记录' })).toBeDisabled()
  await app.evaluate(() => {
    globalThis.queueFixture.failRead = false
    for (const task of globalThis.queueFixture.processes)
      if (task.status === 'pending') task.status = 'cancelled'
  })
  await expect(page.getByRole('heading', { name: '当前没有进行中的任务' })).toBeVisible()
  await expect(page.getByRole('button', { name: '清空记录' })).toBeEnabled()
  await run('清空记录')
  await page
    .getByRole('dialog', { name: '清空全部已结束记录' })
    .getByRole('button', { name: '确认清空全部记录', exact: true })
    .click()
  await expect(tab('已完成').locator('.count-label')).toHaveText('0')
  await expect(tab('未完成').locator('.count-label')).toHaveText('0')
  await expect(page.getByRole('button', { name: '清空记录' })).toBeDisabled()
  expect(errors).toEqual([])
  await writeFile(
    join(output, 'task-queue-result.json'),
    JSON.stringify({ result: '通过', errors, layouts }, null, 2),
  )
  console.log(
    '任务队列验证通过：混合任务归类、执行优先、等待顺序、完成移出、取消、读取失败恢复、键盘标签切换、日志折叠、主题与窗口布局。',
  )
} catch (error) {
  await page.screenshot({ path: join(output, '队列改版-失败.png'), scale: 'css' })
  await writeFile(
    join(output, '队列改版-失败.txt'),
    String(error) + '\n' + (await page.locator('body').innerText()),
  )
  throw error
} finally {
  await closeDesktop(app)
}
