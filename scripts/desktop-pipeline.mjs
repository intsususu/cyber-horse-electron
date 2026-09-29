import { expect } from '@playwright/test'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
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
  const toolDirectory = join(root, '工具')
  await mkdir(toolDirectory)
  const program = join(toolDirectory, '替身.exe')
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
    const path = join(toolDirectory, key + '.exe')
    await copyFile(program, path)
    if (key !== 'ffprobe') paths[key] = path
  }
  const media = (name) => join(paths.preprocess, name)
  const original = '隔离文本样本，不是真实媒体'
  await writeFile(media('ABC-123.mp4'), original)
  await writeFile(media('DEF-456.mp4'), original)
  const stepNames = ['字幕与封装', '视频破解', '元数据刮削', '归档到 NAS']
  const choice = (name) => page.getByRole('checkbox', { name: `参与流程：${name}`, exact: true })
  const dialog = () => page.getByRole('dialog', { name: '处理清单', exact: true })
  const run = (name) => page.getByRole('button', { name, exact: true }).click()
  const runStep = async (name) => {
    for (const step of stepNames) {
      if (step === name) await choice(step).check()
      else await choice(step).uncheck()
    }
    await run('运行所选 1 步')
  }
  const resize = async (width, height) => {
    await app.evaluate(
      async ({ BrowserWindow }, { width, height }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window.isMaximized())
          await new Promise((done) => {
            window.once('unmaximize', done)
            window.unmaximize()
          })
        window.setSize(width, height)
      },
      { width, height },
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(width - 2)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(width)
  }
  const selectOnly = async (name) => {
    await run(`文件操作：${name}`)
    await run('仅选此文件')
  }
  const finish = async (count) => {
    await run('任务队列')
    await page.getByRole('tab', { name: /^已完成/ }).click()
    await expect(page.locator('.task-status.succeeded')).toHaveCount(count, { timeout: 45000 })
    await expect(page.getByRole('button', { name: '停止处理', exact: true })).toHaveCount(0)
    await run('工作台')
  }
  try {
    await resize(1480, 900)
    await page.evaluate(async (paths) => {
      const { settings } = await window.cyberHorse.getSettings()
      await window.cyberHorse.saveSettings({ ...settings, paths: { ...settings.paths, ...paths } })
    }, paths)
    await run('工作台')
    await expect(page.locator('.directory-trigger')).toHaveAttribute('title', paths.preprocess)
    await expect(page.locator('.input-selection-status')).toContainText('2 个视频')
    await app.evaluate(({ shell }) => {
      shell.openPath = async (directory) => {
        globalThis.lastOpenedWorkDirectory = directory
        return ''
      }
    })
    for (const [label, key] of [
      ['打开字幕工作目录', 'whisperOutput'],
      ['打开视频输出目录', 'videoOutput'],
      ['打开MDC 输出目录', 'mdcOutput'],
      ['打开NAS 媒体目录', 'nas'],
    ]) {
      await expect(page.getByRole('button', { name: label })).toHaveAttribute('title', paths[key])
      await run(label)
      expect(await app.evaluate(() => globalThis.lastOpenedWorkDirectory)).toBe(paths[key])
    }
    await expect(page.locator('.step-controls input:checked')).toHaveCount(4)
    // 四种主题的预览、返回焦点与最小窗口。
    for (const theme of ['初号机主题', '深色模式', '浅色模式', '跟随系统']) {
      await run(theme)
      await run('运行全部流程')
      await expect(dialog()).toContainText('2 个视频')
      await expect(dialog().getByRole('button', { name: '确认运行所选步骤' })).toBeInViewport()
      await page.screenshot({
        path: join(output, `四步清单-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '运行全部流程', exact: true })).toBeFocused()
    }
    await resize(1060, 760)
    await run('运行全部流程')
    await expect(dialog().getByRole('button', { name: '确认运行所选步骤' })).toBeInViewport()
    await page.screenshot({
      path: join(output, '四步清单-最小窗口.png'),
      scale: 'css',
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await run('运行全部流程')
    await expect(dialog().getByRole('button', { name: '确认运行所选步骤' })).toBeInViewport()
    await page.screenshot({
      path: join(output, '四步清单-最大化.png'),
      scale: 'css',
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await resize(1480, 900)
    // 零步骤禁止运行；仅选一步后可运行该步骤。
    for (const name of stepNames) await choice(name).uncheck()
    await expect(page.getByRole('button', { name: '请选择步骤' })).toBeDisabled()
    await selectOnly('ABC-123.mp4')
    await runStep('元数据刮削')
    await expect(dialog()).toContainText('仅选中文件 · 1 个视频')
    await run('确认运行所选步骤')
    for (const name of stepNames) await expect(choice(name)).toBeDisabled()
    const concurrent = await page.evaluate(async () => {
      try {
        await window.cyberHorse.previewPreparation()
        return false
      } catch {
        return true
      }
    })
    expect(concurrent).toBe(true)
    await finish(1)
    await expect(page.locator('.step-controls input:checked')).toHaveCount(1)
    expect(await readFile(join(paths.preprocess, 'ABC-123', 'ABC-123.mp4'), 'utf8')).toBe(original)
    await expect(page.locator('.input-selection-status')).toContainText('已选 1 / 2')
    await runStep('归档到 NAS')
    await expect(dialog()).toContainText('仅选中文件 · 1 个视频')
    await run('确认运行所选步骤')
    await finish(1)
    expect(await readFile(join(paths.nas, 'ABC-123', 'ABC-123.mp4'), 'utf8')).toBe(original)
    // 部分组合按固定顺序；未选字幕和 MDC 不参与。
    await choice('元数据刮削').uncheck()
    await choice('归档到 NAS').check()
    await choice('视频破解').check()
    await selectOnly('DEF-456.mp4')
    await writeFile(join(toolDirectory, 'progress-jasna.txt'), '等待进度界面验证')
    await run('运行所选 2 步')
    await run('确认运行所选步骤')
    await expect(page.locator('.workbench-step-status.running')).toHaveText('视频处理 42%')
    for (const theme of ['初号机主题', '深色模式', '浅色模式', '跟随系统']) {
      await run(theme)
      await page.screenshot({
        path: join(output, `工具进度-工作台-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
    }
    await resize(1060, 760)
    await expect(page.locator('.workbench-step-status.running')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
      true,
    )
    await page.screenshot({
      path: join(output, '工具进度-最小窗口.png'),
      scale: 'css',
      animations: 'disabled',
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await expect(page.locator('.workbench-step-status.running')).toBeInViewport()
    await page.screenshot({
      path: join(output, '工具进度-最大化.png'),
      scale: 'css',
      animations: 'disabled',
    })
    await resize(1480, 900)
    await run('任务队列')
    const videoRow = page
      .locator('.task-row')
      .filter({ has: page.locator('strong', { hasText: '视频破解' }) })
    await expect(videoRow).toContainText('已完成 0/1 个文件')
    await expect(videoRow).toContainText('35.0 帧/秒')
    await expect(videoRow.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    for (const theme of ['深色模式', '浅色模式']) {
      await run(theme)
      await page.screenshot({
        path: join(output, `工具进度-队列-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
    }
    await rm(join(toolDirectory, 'progress-jasna.txt'))
    await finish(2)
    expect(await readFile(join(paths.nas, 'DEF-456', 'DEF-456-U.mkv'), 'utf8')).toBe(original)
    await expect(choice('视频破解')).toBeChecked()
    await expect(choice('归档到 NAS')).toBeChecked()
    // 运行前新增纳入全部范围，预览后新增不进入快照。
    await writeFile(media('HIJ-789.mp4'), original)
    await run('目录全部')
    await run('全选步骤')
    await run('运行全部流程')
    await expect(dialog()).toContainText('1 个视频')
    await writeFile(media('新放入.mp4'), original)
    for (const stage of ['vad', 'transcribe', 'mux'])
      await writeFile(join(toolDirectory, `progress-${stage}.txt`), '等待进度界面验证')
    await run('确认运行所选步骤')
    await expect(dialog()).toHaveCount(0)
    await expect(page.getByRole('button', { name: '打开预处理目录' })).toBeEnabled()
    await expect(page.getByRole('button', { name: '工作目录选项' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '开始预处理', exact: true })).toBeDisabled()
    await expect(page.locator('.workbench-step-status.running')).toHaveText('语音检测 25%')
    await rm(join(toolDirectory, 'progress-vad.txt'))
    await expect(page.locator('.workbench-step-status.running')).toHaveText('字幕识别约 50%')
    await page.reload()
    await expect(page.locator('.workbench-step-status.running')).toHaveText('字幕识别约 50%')
    await expect(dialog()).toHaveCount(0)
    await rm(join(toolDirectory, 'progress-transcribe.txt'))
    await expect(page.locator('.workbench-step-status.running')).toHaveText('封装 100%')
    const duringMux = await page.evaluate(() => window.cyberHorse.getPipelineState())
    expect(duringMux.tasks[0].status).toBe('running')
    expect(duringMux.tasks[0].completed).toBe(0)
    await rm(join(toolDirectory, 'progress-mux.txt'))
    await finish(4)
    await expect(dialog()).toHaveCount(0)
    expect(await readFile(join(paths.nas, 'HIJ-789', 'HIJ-789-UC.mkv'), 'utf8')).toBe(original)
    expect(await readFile(media('新放入.mp4'), 'utf8')).toBe(original)
    await run('任务队列')
    await page.getByRole('tab', { name: /^已完成/ }).click()
    await expect(page.locator('.task-row')).toContainText(stepNames)
    for (const theme of ['深色模式', '浅色模式']) {
      await run(theme)
      await page.screenshot({
        path: join(output, `四步结果-${theme}.png`),
        scale: 'css',
        animations: 'disabled',
      })
    }
    await run('工作台')
    // 源码目录经真实 IPC 与外部 Python 入口替身通过命令行能力检测。
    const sourceRoot = join(root, 'Whisper源码')
    const sourcePackage = join(sourceRoot, 'src', 'faster_whisper_transwithai_chickenrice')
    const sourcePython = join(sourceRoot, '.venv', 'Scripts')
    await mkdir(sourcePackage, { recursive: true })
    await mkdir(sourcePython, { recursive: true })
    await mkdir(join(sourceRoot, 'models'))
    await copyFile(program, join(sourcePython, 'python.exe'))
    for (const path of [
      join(sourceRoot, 'infer.py'),
      join(sourceRoot, 'generation_config.json5'),
      join(sourcePackage, 'infer.py'),
      join(sourceRoot, 'models', 'config.json'),
      join(sourceRoot, 'models', 'model.bin'),
      join(sourceRoot, 'models', 'whisper_vad.onnx'),
      join(sourceRoot, 'models', 'whisper_vad_metadata.json'),
    ])
      await writeFile(path, '隔离的源码与模型替身')
    await page.evaluate(async (directory) => {
      const { settings } = await window.cyberHorse.getSettings()
      await window.cyberHorse.saveSettings({
        ...settings,
        paths: { ...settings.paths, whisper: directory },
      })
    }, sourceRoot)
    await runStep('字幕与封装')
    await expect(dialog()).toContainText('Whisper')
    await page.keyboard.press('Escape')
    const unavailableMarker = join(sourcePython, 'python-unavailable.txt')
    await writeFile(unavailableMarker, '模拟基础 Python 不可访问')
    await runStep('字幕与封装')
    await expect(page.locator('.toast')).toContainText('虚拟环境无法访问基础 Python（退出码 103）')
    await expect(dialog()).toHaveCount(0)
    expect(await readFile(media('新放入.mp4'), 'utf8')).toBe(original)
    await rm(unavailableMarker)
    await runStep('字幕与封装')
    await expect(dialog()).toContainText('Whisper')
    await page.keyboard.press('Escape')
    await page.evaluate(async (executable) => {
      const { settings } = await window.cyberHorse.getSettings()
      await window.cyberHorse.saveSettings({
        ...settings,
        paths: { ...settings.paths, whisper: executable },
      })
    }, paths.whisper)
    // 工具失败不能变成成功；失败后可重新预览、取消挂起任务。
    await writeFile(join(toolDirectory, 'mode.txt'), '失败')
    await runStep('字幕与封装')
    await run('确认运行所选步骤')
    await run('任务队列')
    await page.getByRole('tab', { name: /^未完成/ }).click()
    await expect(page.locator('.task-status.failed')).toHaveCount(1)
    expect(await readFile(media('新放入.mp4'), 'utf8')).toBe(original)
    await writeFile(join(toolDirectory, 'mode.txt'), '挂起')
    const previousCalls = await readFile(join(toolDirectory, 'calls.jsonl'), 'utf8')
    await run('工作台')
    await runStep('视频破解')
    await run('确认运行所选步骤')
    await expect
      .poll(async () =>
        (await readFile(join(toolDirectory, 'calls.jsonl'), 'utf8'))
          .slice(previousCalls.length)
          .includes('--post-export-action'),
      )
      .toBe(true)
    await run('停止处理')
    await run('任务队列')
    await page.getByRole('tab', { name: /^未完成/ }).click()
    await expect(page.locator('.task-status.cancelled')).toHaveCount(1)
    expect(await readFile(media('新放入.mp4'), 'utf8')).toBe(original)
    const state = await page.evaluate(() => window.cyberHorse.getPipelineState())
    expect(await readFile(state.journal, 'utf8')).not.toContain('不应显示')
    // 已选文件消失时不扩大范围，IPC 不接受任意目录或空选择。
    await run('工作台')
    await selectOnly('新放入.mp4')
    await rename(media('新放入.mp4'), media('已移动.mp4'))
    await runStep('归档到 NAS')
    await expect(page.getByRole('status')).toContainText('部分选中文件已不在工作目录中')
    await expect(page.locator('.input-selection-status')).toContainText('已选 0 /')
    expect(
      await page.evaluate(async () => {
        try {
          await window.cyberHorse.previewPipeline({
            steps: ['archive'],
            source: 'preprocess',
            recursive: true,
            selection: { mode: 'selected', relativePaths: [] },
            path: 'C:/',
          })
          return false
        } catch {
          return true
        }
      }),
    ).toBe(true)
    // 第一项处理完成时仍在执行第二项，工作台清单应立即显示新文件。
    await writeFile(media('LIVE-001.mp4'), original)
    await writeFile(media('LIVE-002.mp4'), original)
    await rm(join(toolDirectory, 'mode.txt'))
    await run('刷新')
    await selectOnly('LIVE-001.mp4')
    await page.getByRole('checkbox', { name: '勾选 LIVE-002.mp4', exact: true }).check()
    await writeFile(join(toolDirectory, 'progress-jasna-LIVE-002.txt'), '等待首项清单刷新')
    await runStep('视频破解')
    await run('确认运行所选步骤')
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.cyberHorse.getPipelineState())).tasks[0].completed,
        { timeout: 15000 },
      )
      .toBe(1)
    await expect(page.getByRole('button', { name: '停止处理', exact: true })).toBeVisible()
    await expect(page.locator('.input-file-row').filter({ hasText: 'LIVE-001-U.mkv' })).toHaveCount(
      1,
    )
    await expect(page.locator('.input-file-row').filter({ hasText: 'LIVE-001.mp4' })).toHaveCount(0)
    await rm(join(toolDirectory, 'progress-jasna-LIVE-002.txt'))
    await finish(1)
    await expect(page.locator('.input-file-row').filter({ hasText: 'LIVE-002-U.mkv' })).toHaveCount(
      1,
    )
    // MDC 零退出码却丢失标签时，经真实 IPC 阻止归档，不删除输入。
    await writeFile(media('CLUB-494-UC_1.mkv'), original)
    await writeFile(join(toolDirectory, 'mode.txt'), '丢标签')
    await run('刷新')
    await selectOnly('CLUB-494-UC_1.mkv')
    for (const step of stepNames) {
      if (step === '元数据刮削' || step === '归档到 NAS') await choice(step).check()
      else await choice(step).uncheck()
    }
    await run('运行所选 2 步')
    await run('确认运行所选步骤')
    await expect
      .poll(async () => (await page.evaluate(() => window.cyberHorse.getPipelineState())).status, {
        timeout: 15000,
      })
      .toBe('failed')
    await run('任务队列')
    await page.getByRole('tab', { name: /^未完成/ }).click()
    await expect(
      page.locator('.task-row').filter({ has: page.locator('.task-status.failed') }),
    ).toContainText('缺少任务要求的中文字幕或破解标签')
    expect(await readFile(media('CLUB-494-UC_1.mkv'), 'utf8')).toBe(original)
    const rejected = await page.evaluate(() => window.cyberHorse.getPipelineState())
    expect(rejected.tasks.find((task) => task.id === 'archive').status).toBe('skipped')
    await writeFile(
      join(output, 'pipeline-desktop-result.json'),
      JSON.stringify(
        {
          result: '通过',
          steps: stepNames,
          themes: 4,
          single: true,
          partial: true,
          all: true,
          cancellation: true,
          failure: true,
          scope: true,
          toolProgress: true,
          progressReload: true,
          refreshAfterEachFile: true,
          mdcMarksBlocked: true,
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
