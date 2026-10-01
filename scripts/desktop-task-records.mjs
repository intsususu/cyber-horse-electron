import { closeDesktop } from './fixtures/close-desktop.mjs'
import { _electron as electron, expect } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// 定向验证：实际任务服务仅操作隔离的文本替身，不连接服务器或运行媒体工具。
const output = resolve('test-results')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'task-records-profile-'))
const serviceBundle = join(profile, 'services.cjs')
await build({
  stdin: {
    contents:
      "export { WorkspaceTasks, taskConfiguration } from './src/main/services/workspace-tasks'; export { defaultSettings } from './src/shared/contracts';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: serviceBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
})
const env = { ...process.env, CYBER_HORSE_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: ['.'], env })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  await app.evaluate(
    async ({ ipcMain }, { serviceBundle, profile }) => {
      const require = process.getBuiltinModule('module').createRequire(serviceBundle)
      const { WorkspaceTasks, taskConfiguration, defaultSettings } = require(serviceBundle)
      const { mkdir, writeFile, readFile } = require('node:fs/promises')
      const { join } = require('node:path')
      const { randomUUID } = require('node:crypto')
      const settings = structuredClone(defaultSettings)
      for (const key of ['download', 'preprocess', 'nas']) {
        settings.paths[key] = join(profile, key)
        await mkdir(settings.paths[key])
      }
      const data = join(profile, 'fixture-data')
      let tasks = new WorkspaceTasks(data, [], async () => settings)
      const downloads = []
      const histories = []
      for (const [index, name] of ['合并影片甲', '合并影片乙'].entries()) {
        const path = join(settings.paths.download, `TEST-${100 + index}.mp4`)
        const content = '隔离媒体替身'
        await writeFile(path, content)
        const job = {
          id: randomUUID(),
          itemId: `item-${index}`,
          sourceId: 'source',
          name,
          status: 'completed',
          received: Buffer.byteLength(content),
          total: Buffer.byteLength(content),
          path,
          temporary: '',
          message: '下载完成。',
          started: '2026-09-28T10:00:00.000Z',
          ended: '2026-09-28T10:01:00.000Z',
        }
        downloads.push(job)
        const id = await tasks.enqueue(
          settings,
          {
            origin: 'media-library',
            steps: ['archive'],
            files: [{ path }],
            destination: { kind: 'nas', root: settings.paths.nas },
            context: {
              configuration: taskConfiguration(settings),
              replacements: [],
              sync: null,
              ...(index ? { media: { processId: randomUUID(), downloadId: job.id, name } } : {}),
            },
          },
          [settings.paths.download],
        )
        if ((await tasks.wait(id)).state !== 'completed') throw new Error('隔离发布未完成')
        const history = join(data, 'workspace-tasks', id + '.json')
        histories.push({ path: history, content: await readFile(history, 'utf8') })
      }
      const source = join(settings.paths.preprocess, 'TEST-999.mp4')
      await writeFile(source, '待删除任务的外部来源，必须保留')
      const pending = await tasks.workspaces.create(
        settings.paths.download,
        {
          origin: 'workbench',
          steps: ['archive'],
          files: [{ path: source }],
          destination: { kind: 'nas', root: settings.paths.nas },
        },
        [settings.paths.preprocess],
      )
      tasks = new WorkspaceTasks(data, [], async () => settings)
      await tasks.list()
      const state = { clearCalls: 0, confirmCalls: 0, failConfirm: false }
      globalThis.taskRecordsFixture = {
        state,
        histories,
        verify: async () => {
          for (const history of histories)
            if ((await readFile(history.path, 'utf8')) !== history.content)
              throw new Error('其他历史被修改')
          if ((await readFile(source, 'utf8')) !== '待删除任务的外部来源，必须保留')
            throw new Error('外部来源被修改')
          const restarted = new WorkspaceTasks(data, [], async () => settings)
          return (await restarted.list()).tasks.map((view) => view.task.state)
        },
      }
      const bind = (name, handler) => {
        ipcMain.removeHandler(name)
        ipcMain.handle(name, handler)
      }
      bind('pipeline:state', () => null)
      bind('media:downloads', () => downloads)
      bind('media:processes', () => []) // 模拟重启后会话复合记录为空。
      bind('media:queue-summary', () => ({ active: 0, unified: true }))
      bind('tasks:list', () => tasks.list())
      bind('tasks:preview-action', (_event, request) =>
        tasks.previewAction(request.id, request.action),
      )
      bind('tasks:confirm-action', (_event, request) => {
        state.confirmCalls++
        if (state.failConfirm) throw new Error('隔离测试：文件变化，请重新预览。')
        return tasks.confirmAction(request.planId, request.revision)
      })
      bind('media:clear-tasks', async () => {
        state.clearCalls++
        await tasks.clearHistory()
        downloads.length = 0
      })
      if (!pending.task.id) throw new Error('未创建隔离任务')
    },
    { serviceBundle, profile },
  )
  await page.reload()
  await page.getByRole('button', { name: '任务队列', exact: true }).click()
  const tab = (name) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
  const clear = page.getByRole('button', { name: '清空记录', exact: true })
  await tab('已完成').click()
  await expect(page.locator('.queue-card')).toHaveCount(2)
  await expect(page.getByText('合并影片甲', { exact: true })).toBeVisible()
  await expect(page.getByText('合并影片乙', { exact: true })).toBeVisible()
  await page.locator('.queue-card').first().locator('summary').click()
  await expect(page.locator('.queue-card').first()).toContainText('下载：')
  await page.screenshot({ path: join(output, '任务记录-合并.png') })
  await tab('未完成').click()
  const remove = page.getByRole('button', { name: '永久删除任务文件', exact: true })
  await remove.click()
  let dialog = page.getByRole('dialog')
  await expect(clear).toBeDisabled()
  await expect(
    dialog.getByRole('button', { name: '确认永久删除任务文件', exact: true }),
  ).toBeDisabled()
  await dialog.getByRole('button', { name: '暂不处理', exact: true }).click()
  expect(await app.evaluate(() => globalThis.taskRecordsFixture.state)).toMatchObject({
    clearCalls: 0,
    confirmCalls: 0,
  })
  await remove.click()
  await app.evaluate(() => {
    globalThis.taskRecordsFixture.state.failConfirm = true
  })
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: '确认永久删除任务文件', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('文件变化')
  expect(await app.evaluate(() => globalThis.taskRecordsFixture.verify())).toEqual(
    expect.arrayContaining(['completed', 'completed', 'queued']),
  )
  await app.evaluate(() => {
    globalThis.taskRecordsFixture.state.failConfirm = false
  })
  await dialog.getByRole('button', { name: '确认永久删除任务文件', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await app.evaluate(() => globalThis.taskRecordsFixture.verify())).toEqual(
    expect.arrayContaining(['completed', 'completed', 'removed']),
  )
  expect(await app.evaluate(() => globalThis.taskRecordsFixture.state.clearCalls)).toBe(0)
  await tab('已完成').click()
  await expect(page.getByText('合并影片甲', { exact: true })).toBeVisible()
  await expect(page.getByText('合并影片乙', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '任务队列', exact: true }).click()
  await tab('已完成').click()
  await expect(page.locator('.queue-card')).toHaveCount(2)
  await tab('未完成').click()
  await expect(page.locator('.queue-card')).toHaveCount(0)
  await tab('已完成').click()
  await page.screenshot({ path: join(output, '任务记录-删除后保留.png') })
  await clear.click()
  dialog = page.getByRole('dialog', { name: '清空全部已结束记录' })
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  expect(await app.evaluate(() => globalThis.taskRecordsFixture.state.clearCalls)).toBe(0)
  await clear.click()
  await dialog.getByRole('button', { name: '确认清空全部记录', exact: true }).click()
  await expect(page.locator('.queue-card')).toHaveCount(0)
  expect(await app.evaluate(() => globalThis.taskRecordsFixture.state.clearCalls)).toBe(1)
  expect(errors).toEqual([])
  console.log(
    '任务记录定向验证通过：重启合并、单项删除取消/失败/成功、历史原样保留、清空独立确认。',
  )
} catch (error) {
  await page.screenshot({ path: join(output, '任务记录-失败.png') })
  await writeFile(
    join(output, '任务记录-失败.txt'),
    String(error) + '\n' + (await page.locator('body').innerText()),
  )
  throw error
} finally {
  await closeDesktop(app)
}
