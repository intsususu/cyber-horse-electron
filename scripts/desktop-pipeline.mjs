import { expect } from '@playwright/test'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export async function verifyPipeline(app, page, output) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'horse-desktop-pipeline-')))
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
    const path = join(tools, key + '.exe')
    await copyFile(program, path)
    if (key !== 'ffprobe') paths[key] = path
  }
  const original = '隔离文本样本，不是真实媒体'
  const run = (name) => page.getByRole('button', { name, exact: true }).click()
  const start = (steps, names) =>
    page.evaluate(
      async ({ steps, names }) => {
        const plan = await window.cyberHorse.previewPipeline({
          steps,
          source: 'preprocess',
          recursive: true,
          selection: { mode: 'selected', relativePaths: names },
        })
        return window.cyberHorse.startPipeline({ planId: plan.id })
      },
      { steps, names },
    )
  const finished = async () => {
    await expect
      .poll(async () => (await page.evaluate(() => window.cyberHorse.getPipelineState()))?.status, {
        timeout: 45000,
      })
      .not.toMatch(/^(running|cancelling)$/)
    return page.evaluate(() => window.cyberHorse.getPipelineState())
  }
  const view = async (id) =>
    (await page.evaluate(() => window.cyberHorse.listWorkspaceTasks())).tasks.find(
      (value) => value.task.id === id,
    )
  try {
    await page.evaluate(async (paths) => {
      const { settings } = await window.cyberHorse.getSettings()
      await window.cyberHorse.saveSettings({ ...settings, paths: { ...settings.paths, ...paths } })
    }, paths)
    await run('工作台')
    await writeFile(join(paths.preprocess, 'ABC-123.mp4'), original)
    await run('刷新')
    if (await page.getByRole('button', { name: '全选步骤', exact: true }).count())
      await run('全选步骤')
    await run('运行全部流程')
    await expect(page.getByRole('dialog', { name: '处理清单' })).toContainText('.work')
    await run('确认运行所选步骤')
    await expect(page.getByRole('checkbox', { name: '参与流程：元数据刮削' })).toBeDisabled()
    let result = await finished()
    expect(result.status, result.message).toBe('succeeded')
    expect(result.tasks.map((task) => task.completed)).toEqual([1, 1, 1, 1])
    expect(result.resultFiles.some((path) => path.endsWith('ABC-123-UC.mkv'))).toBe(true)
    expect(
      await readFile(
        result.resultFiles.find((path) => path.endsWith('.mkv')),
        'utf8',
      ),
    ).toBe(original)
    expect((await view(result.id)).directory).toBe('')
    for (const key of ['mdcOutput', 'videoOutput', 'whisperOutput'])
      expect(await readdir(paths[key])).toEqual([])
    await run('任务队列')
    await page.getByRole('tab', { name: /^已完成/ }).click()
    await expect(page.locator('.workspace-task-card').filter({ hasText: 'ABC-123' })).toContainText(
      '已完成',
    )
    for (const theme of ['初号机主题', '深色模式', '浅色模式', '钢铁侠主题']) {
      await run(theme)
      await page.screenshot({
        path: join(output, `任务隔离-完成-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
    }
    // 首项逐文件发布，第二项继续处理；进度来自真实工具替身输出，刷新页面仍可读取。
    for (const name of ['LIVE-001.mp4', 'LIVE-002.mp4'])
      await writeFile(join(paths.preprocess, name), original)
    await writeFile(join(tools, 'progress-jasna-LIVE-002.txt'), '等待验证')
    await start(['video'], ['LIVE-001.mp4', 'LIVE-002.mp4'])
    await page.reload()
    await run('工作台')
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.cyberHorse.getPipelineState())).tasks[0].completed,
        { timeout: 15000 },
      )
      .toBe(1)
    expect(await readFile(join(paths.preprocess, 'LIVE-001-U.mkv'), 'utf8')).toBe(original)
    await expect(page.locator('.workbench-step-status.running')).toHaveText('视频处理 42%')
    await page.reload()
    await expect(page.locator('.workbench-step-status.running')).toHaveText('视频处理 42%')
    await run('任务队列')
    await page.getByRole('tab', { name: /^进行中/ }).click()
    await expect(page.getByRole('progressbar', { name: '视频破解当前阶段进度' })).toHaveAttribute(
      'value',
      '42',
    )
    await rm(join(tools, 'progress-jasna-LIVE-002.txt'))
    expect((await finished()).status).toBe('succeeded')
    await writeFile(join(paths.preprocess, 'PART-003.mp4'), original)
    await start(['video', 'archive'], ['PART-003.mp4'])
    result = await finished()
    expect(result.tasks.map((task) => task.id)).toEqual(['video', 'archive'])
    expect(result.status).toBe('succeeded')
    // 失败输入在独立目录中；取消恢复弹窗不执行，确认后只重跑未完成步骤。
    await writeFile(join(paths.preprocess, 'REC-001.mp4'), original)
    await writeFile(join(tools, 'mode.txt'), '失败')
    await start(['video'], ['REC-001.mp4'])
    result = await finished()
    expect(result.status).toBe('failed')
    const residual = await view(result.id)
    expect(
      await readFile(join(residual.directory, residual.task.files[0].sources[0].target), 'utf8'),
    ).toBe(original)
    await run('任务队列')
    await page.getByRole('tab', { name: /^未完成/ }).click()
    const card = page.locator('.workspace-task-card').filter({ hasText: 'REC-001' })
    await card.getByRole('button', { name: '恢复任务', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '恢复任务预览' })).toContainText(
      '已完成步骤不重跑',
    )
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async (theme) => {
        const { settings } = await window.cyberHorse.getSettings()
        await window.cyberHorse.saveSettings({ ...settings, theme })
      }, theme)
      await page.screenshot({
        path: join(output, `任务隔离-恢复-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
    }
    await page.keyboard.press('Escape')
    await expect(card.getByRole('button', { name: '恢复任务', exact: true })).toBeFocused()
    await rm(join(tools, 'mode.txt'))
    await card.getByRole('button', { name: '恢复任务', exact: true }).click()
    await run('确认恢复任务')
    await expect
      .poll(
        async () => {
          const recovered = await view(result.id)
          return { state: recovered.task.state, active: recovered.active }
        },
        { timeout: 30000 },
      )
      .toEqual({ state: 'completed', active: false })
    // MDC 标签校验与单文件失败边界；成功文件归档，失败文件保留供确认恢复。
    await writeFile(join(paths.preprocess, 'CLUB-494-UC_1.mkv'), original)
    await writeFile(join(tools, 'mode.txt'), '丢标签')
    await start(['scrape', 'archive'], ['CLUB-494-UC_1.mkv'])
    result = await finished()
    expect(result.status).toBe('failed')
    expect(result.failures[0].reason).toContain('缺少任务要求')
    expect(result.tasks.find((task) => task.id === 'archive').status).toBe('skipped')
    await rm(join(tools, 'mode.txt'))
    for (const name of ['PART-001.mp4', 'PART-002.mp4'])
      await writeFile(join(paths.preprocess, name), original)
    await writeFile(join(tools, 'fail-mdc-PART-001.txt'), '模拟单文件失败')
    await start(['scrape', 'archive'], ['PART-001.mp4', 'PART-002.mp4'])
    result = await finished()
    expect(result.tasks[0]).toMatchObject({ status: 'failed', completed: 1, failed: 1, total: 2 })
    expect(result.tasks[1]).toMatchObject({ status: 'succeeded', completed: 1, total: 1 })
    await run('任务队列')
    await page.getByRole('tab', { name: /^未完成/ }).click()
    const failedCard = page.locator('.workspace-task-card').filter({ hasText: 'CLUB-494' })
    await failedCard.getByRole('button', { name: '永久删除任务文件' }).click()
    await expect(page.getByRole('button', { name: '确认永久删除任务文件' })).toBeDisabled()
    await run('暂不处理')
    await page.evaluate(() => window.cyberHorse.clearMediaTasks())
    await expect(failedCard).toBeVisible()
    for (const size of [
      [1060, 760],
      [1480, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
        size,
      )
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
        true,
      )
      await page.screenshot({
        path: join(output, `任务隔离-${size[0]}.png`),
        scale: 'css',
        animations: 'disabled',
      })
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await page.screenshot({
      path: join(output, '任务隔离-最大化.png'),
      scale: 'css',
      animations: 'disabled',
    })
    expect(
      await page.evaluate(async () => {
        try {
          await window.cyberHorse.previewWorkspaceAction({
            id: '../settings',
            action: 'delete',
            path: 'C:/',
          })
          return false
        } catch {
          return true
        }
      }),
    ).toBe(true)
    await writeFile(
      join(output, 'pipeline-desktop-result.json'),
      JSON.stringify(
        {
          result: '通过',
          isolatedWorkspace: true,
          all: true,
          partial: true,
          recovery: true,
          cleanup: true,
          realProgress: true,
          themes: 4,
        },
        null,
        2,
      ),
    )
  } finally {
    await page
      .evaluate(async (settings) => {
        await window.cyberHorse.cancelPipeline()
        await window.cyberHorse.saveSettings(settings)
      }, saved)
      .catch(() => {})
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.cyberHorse.getPipelineState()))?.status ?? 'none',
      )
      .not.toMatch(/^(running|cancelling)$/)
    if (
      !resolve(root).startsWith((await realpath(tmpdir())) + sep) ||
      !parse(root).base.startsWith('horse-desktop-pipeline-')
    )
      throw new Error('测试目录越界')
    await rm(root, { recursive: true, force: true })
  }
}
