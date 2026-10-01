import { expect } from '@playwright/test'
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'

export async function verifyPreparation(app, page, output) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'horse-desktop-preparation-')))
  const download = join(root, '下载')
  const preprocess = join(root, '预处理')
  await mkdir(download)
  await mkdir(preprocess)
  const source = join(download, 'prefix@abc-123-uc_restored.mp4')
  const file = await open(source, 'wx')
  await file.truncate(1024 ** 3)
  await file.write('隔离的稀疏文件样本，不是真实媒体。', 0, 'utf8')
  await file.close()
  await mkdir(join(download, '子目录', '内层'), { recursive: true })
  await writeFile(join(download, '子目录', '内层', '说明.txt'), '可恢复的下载残留')
  await writeFile(join(download, '小视频.mp4'), '未达到门槛')
  await writeFile(join(preprocess, 'def456_restored.mkv'), '需要规范名称的文本样本')
  await writeFile(join(preprocess, 'ABC-123-UC.mp4'), '已有同名文件不得覆盖')
  const saved = await page.evaluate(async () => (await window.cyberHorse.getSettings()).settings)
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 900))
    await page.evaluate(
      async ({ download, preprocess }) => {
        const { settings } = await window.cyberHorse.getSettings()
        await window.cyberHorse.saveSettings({
          ...settings,
          paths: { ...settings.paths, download, preprocess },
        })
      },
      { download, preprocess },
    )
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await expect(page.locator('.directory-trigger')).toHaveAttribute('title', preprocess)
    await expect(page.locator('.input-selection-status')).toContainText('2 个视频')
    for (const theme of ['初号机', '深色', '浅色', '钢铁侠主题']) {
      await page
        .getByRole('button', {
          name: theme === '初号机' ? '初号机主题' : theme === '钢铁侠主题' ? theme : `${theme}模式`,
          exact: true,
        })
        .click()
      await page.getByRole('button', { name: '文件预处理', exact: true }).click()
      const preview = page.getByRole('dialog', { name: '预处理清单' })
      await expect(preview).toContainText(
        '提取 1 项 · 重命名 1 项 · 删除残留 2 项 · 清理空文件夹 2 项',
      )
      await expect(preview).toContainText('ABC-123-UC_1.mp4')
      await expect(preview).toContainText('小视频.mp4')
      await expect(preview.getByRole('button', { name: '确认执行预处理' })).toBeInViewport()
      await page.screenshot({
        path: join(output, `预处理清单-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '文件预处理', exact: true })).toBeFocused()
      expect((await stat(source)).size).toBe(1024 ** 3)
      await page.getByRole('button', { name: '偏好配置', exact: true }).click()
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
      await expect(page.getByRole('status')).toContainText('配置已保存')
      await page.screenshot({
        path: join(output, `提示位置-${theme}.png`),
        animations: 'disabled',
        scale: 'css',
      })
      await page.getByRole('button', { name: '关闭提示', exact: true }).click()
      await page.getByRole('button', { name: '工作台', exact: true }).click()
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 760))
    await page.getByRole('button', { name: '文件预处理', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认执行预处理' })).toBeInViewport()
    await page.screenshot({ path: join(output, '预处理清单-最小窗口.png'), scale: 'css' })
    await page.keyboard.press('Escape')
    expect((await stat(source)).size).toBe(1024 ** 3)
    expect(await readFile(join(download, '子目录', '内层', '说明.txt'), 'utf8')).toBe(
      '可恢复的下载残留',
    )
    await page.getByRole('button', { name: '最大化或还原', exact: true }).click()
    await page.getByRole('button', { name: '文件预处理', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认执行预处理' })).toBeInViewport()
    await page.screenshot({ path: join(output, '预处理清单-最大化.png'), scale: 'css' })
    await page.getByRole('button', { name: '确认执行预处理' }).click()
    await page.getByRole('button', { name: '任务队列', exact: true }).click()
    await page.getByRole('tab', { name: /^已完成/ }).click()
    await expect(page.locator('.task-status')).toHaveText('已完成', { timeout: 15000 })
    const state = await page.evaluate(() => window.cyberHorse.getPreparationState())
    expect(state).toMatchObject({ status: 'succeeded', completed: 6, total: 6 })
    expect(Date.parse(state.endedAt) - Date.parse(state.startedAt)).toBeLessThan(5000)
    const entries = (await readFile(state.journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const plan = entries[0].plan
    for (const item of plan.items) {
      if (item.action === 'cleanup')
        await expect(stat(item.source)).rejects.toMatchObject({ code: 'ENOENT' })
      if (item.target) expect((await stat(item.target)).size).toBe(item.size)
    }
    for (const path of plan.cleanupDirectories) {
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect((await stat(download)).isDirectory()).toBe(true)
    await expect(stat(join(download, '.cyber-horse-recovery'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(preprocess, 'ABC-123-UC.mp4'), 'utf8')).toBe('已有同名文件不得覆盖')
    expect(await readFile(join(preprocess, 'DEF-456.mkv'), 'utf8')).toBe('需要规范名称的文本样本')
    await page.screenshot({ path: join(output, '预处理-真实完成.png'), scale: 'css' })
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await expect(page.locator('.input-selection-status')).toContainText('3 个视频')
    expect(
      await page.evaluate(async () => {
        try {
          await window.cyberHorse.startPreparation({ planId: '无效', path: 'C:/' })
          return false
        } catch {
          return true
        }
      }),
    ).toBe(true)
    await page.getByRole('button', { name: '文件预处理', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '预处理清单' })).toContainText(
      '没有需要处理的文件',
    )
    await expect(page.getByRole('button', { name: '确认执行预处理' })).toBeDisabled()
    await page.keyboard.press('Escape')
  } finally {
    await page.evaluate((settings) => window.cyberHorse.saveSettings(settings), saved)
    const current = await page.evaluate(() => window.cyberHorse.getPreparationState())
    if (current && ['running', 'cancelling'].includes(current.status)) {
      await page.evaluate(() => window.cyberHorse.cancelPreparation())
      await expect
        .poll(
          () => page.evaluate(async () => (await window.cyberHorse.getPreparationState())?.status),
          { timeout: 30000 },
        )
        .not.toMatch(/^(running|cancelling)$/)
    }
    if (
      !resolve(root).startsWith((await realpath(tmpdir())) + sep) ||
      !parse(root).base.startsWith('horse-desktop-preparation-')
    )
      throw new Error('测试目录越界')
    await rm(root, { recursive: true, force: true })
  }
}
