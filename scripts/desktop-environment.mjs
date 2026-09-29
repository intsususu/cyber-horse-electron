import { expect } from '@playwright/test'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export async function verifyInitialEnvironment(page) {
  const showPanel = () => page.getByRole('button', { name: /^查看目录与工具检测/ }).click()
  await showPanel()
  const panel = page.getByRole('region', { name: '环境检测', exact: true })
  await expect(panel).toHaveAttribute('data-state', 'complete')
  await expect(panel).toContainText('10 项待处理')
  await panel.getByRole('button', { name: /^工作目录检测/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: '路径与工具' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByLabel('下载目录', { exact: true })).toBeFocused()
  await expect(page.locator('#path-health-download')).toHaveText('尚未配置')
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await showPanel()
  await expect(panel).toHaveAttribute('data-state', 'complete')
  await panel.getByRole('button', { name: /^工具入口检测/ }).click()
  await expect(page.getByLabel('Movie_Data_Capture', { exact: true })).toBeFocused()
  await page.getByLabel('Movie_Data_Capture', { exact: true }).fill('尚未保存的入口')
  await expect(page.locator('#path-health-mdc')).toHaveText('未保存，保存后自动检测')
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await showPanel()
  await expect(panel).toContainText('10 项待处理')
  await page.locator('dialog.environment-modal').getByRole('button', { name: '关闭弹窗' }).click()
}

export async function verifyEnvironmentRecovery(app, page, dataDirectory, output) {
  const original = await page.evaluate(async () => (await window.cyberHorse.getSettings()).settings)
  const fixtureDirectory = join(dataDirectory, '环境检测夹具')
  const entry = join(fixtureDirectory, '工具入口.txt')
  await mkdir(fixtureDirectory)
  await writeFile(entry, '只读路径夹具，不执行任何工具')
  const toolKeys = ['mdc', 'whisper', 'mkvmerge', 'jasna']
  const valid = structuredClone(original)
  for (const key of Object.keys(valid.paths))
    valid.paths[key] = toolKeys.includes(key) ? entry : fixtureDirectory
  const panel = page.getByRole('region', { name: '环境检测', exact: true })
  const dialog = page.locator('dialog.environment-modal')
  const closePanel = async () => {
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: '关闭弹窗' }).click()
  }
  const showPanel = () => page.getByRole('button', { name: /^查看目录与工具检测/ }).click()
  const home = async () => {
    await closePanel()
    await page.getByRole('button', { name: '工作台', exact: true }).click()
    await showPanel()
  }
  const save = (settings) =>
    page.evaluate((value) => window.cyberHorse.saveSettings(value), settings)
  try {
    await home()
    await save(valid)
    await expect(panel).toContainText('路径检查通过')

    // 模拟窗口错过配置推送，重新获得焦点时从磁盘校准，保留无关草稿。
    await closePanel()
    await page.getByRole('button', { name: '偏好配置', exact: true }).click()
    await page.getByLabel('下载目录', { exact: true }).fill('尚未保存的草稿')
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      globalThis.originalSettingsSend = contents.send.bind(contents)
      contents.send = (channel, ...args) => {
        if (channel !== 'settings:changed') globalThis.originalSettingsSend(channel, ...args)
      }
    })
    const changedWhileAway = { ...valid, paths: { ...valid.paths, nas: entry } }
    try {
      await save(changedWhileAway)
      await expect(page.getByLabel('NAS 媒体目录', { exact: true })).toHaveValue(fixtureDirectory)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(page.getByLabel('NAS 媒体目录', { exact: true })).toHaveValue(entry)
      await expect(page.getByLabel('下载目录', { exact: true })).toHaveValue('尚未保存的草稿')
    } finally {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send = globalThis.originalSettingsSend
      })
    }
    await home()
    await save(valid)
    await expect(panel).toContainText('路径检查通过')
    await expect(panel).toContainText('工具运行环境尚未验证')
    await page.screenshot({
      path: join(output, '环境检测-通过.png'),
      animations: 'disabled',
      scale: 'css',
    })
    // 文件实际消失后重检；未执行或删除真实媒体。
    await unlink(entry)
    await panel.getByRole('button', { name: '重新检测环境' }).click()
    await expect(panel).toContainText('4 项待处理')
    await expect(panel).toContainText('路径不存在或无读取权限')
    await panel.getByRole('button', { name: /^工具入口检测/ }).click()
    await expect(page.getByLabel('Movie_Data_Capture', { exact: true })).toBeFocused()
    await expect(page.locator('#path-health-mdc')).toContainText('路径不存在')
    await writeFile(entry, '恢复只读入口夹具')
    await home()
    await expect(panel).toContainText('路径检查通过')
    // 已配置但失效的项优先定位，修复保存后自动检测。
    await save({ ...valid, paths: { ...valid.paths, download: '', nas: entry } })
    await expect(panel).toContainText('NAS 媒体目录 · 需要选择文件夹')
    await panel.getByRole('button', { name: /^工作目录检测/ }).click()
    await expect(page.getByLabel('NAS 媒体目录', { exact: true })).toBeFocused()
    await page.getByLabel('NAS 媒体目录', { exact: true }).fill(fixtureDirectory)
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(page.locator('#path-health-nas')).toHaveText('目录可读取')
    await home()
    await expect(panel).toContainText('1 项待处理')
    await save(valid)
    await expect(panel).toContainText('路径检查通过')

    // 用受控 IPC 替身验证慢响应、失败、超时与乱序；实际读取已在上方验证。
    const ready = await page.evaluate(() => window.cyberHorse.checkPaths())
    await app.evaluate(({ ipcMain }) => {
      globalThis.healthRequests = []
      ipcMain.removeHandler('paths:check')
      ipcMain.handle(
        'paths:check',
        () =>
          new Promise((resolve, reject) => {
            globalThis.healthRequests.push({ resolve, reject })
          }),
      )
    })
    const count = () => app.evaluate(() => globalThis.healthRequests.length)
    const reply = (index, items) =>
      app.evaluate((_, { index, items }) => globalThis.healthRequests[index].resolve(items), {
        index,
        items,
      })
    await panel.getByRole('button', { name: '重新检测环境' }).click()
    await expect(panel).toHaveAttribute('data-state', 'checking')
    await expect(panel).toContainText('正在检测')
    await expect(panel.getByRole('button', { name: '重新检测环境' })).toBeDisabled()
    await panel.getByRole('button', { name: '重新检测环境' }).evaluate((button) => {
      button.click()
      button.click()
    })
    await expect.poll(count).toBe(1)
    await page.screenshot({ path: join(output, '环境检测-检测中.png'), scale: 'css' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(
      await panel
        .locator('.environment-check-heading > svg')
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await app.evaluate(() => globalThis.healthRequests[0].reject(new Error('检测服务替身失败')))
    await expect(panel).toHaveAttribute('data-state', 'failed')
    await expect(panel).toContainText('当前无法确认路径状态')
    await expect(panel).not.toContainText('路径检查通过')
    await panel.getByRole('button', { name: '重新检测环境' }).click()
    await expect.poll(count).toBe(2)
    await reply(1, ready)
    await expect(panel).toContainText('路径检查通过')
    await panel.getByRole('button', { name: '重新检测环境' }).click()
    await expect.poll(count).toBe(3)
    const changed = { ...valid, paths: { ...valid.paths, download: '' } }
    await save(changed)
    await expect.poll(count).toBe(4)
    await reply(
      3,
      ready.map((item) =>
        item.key === 'download' ? { ...item, status: 'unconfigured', message: '尚未配置' } : item,
      ),
    )
    await expect(panel).toContainText('1 项待处理')
    await reply(2, ready)
    await expect(panel).not.toContainText('路径检查通过')
    await panel.getByRole('button', { name: '重新检测环境' }).click()
    await expect.poll(count).toBe(5)
    await expect(panel).toHaveAttribute('data-state', 'failed', { timeout: 10000 })
    await reply(4, ready)
    await expect(panel).toHaveAttribute('data-state', 'failed')
    await page.screenshot({
      path: join(output, '环境检测-失败.png'),
      animations: 'disabled',
      scale: 'css',
    })

    // 旧的读取响应不能覆盖随后收到的更新；读取失败持续提示并允许焦点重试。
    await closePanel()
    await app.evaluate(({ ipcMain }) => {
      globalThis.settingsRequests = []
      ipcMain.removeHandler('settings:get')
      ipcMain.handle(
        'settings:get',
        () =>
          new Promise((resolve, reject) => {
            globalThis.settingsRequests.push({ resolve, reject })
          }),
      )
    })
    const settingsCount = () => app.evaluate(() => globalThis.settingsRequests.length)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(settingsCount).toBe(1)
    await save(valid)
    await page.getByRole('button', { name: '偏好配置', exact: true }).click()
    await expect(page.getByLabel('下载目录', { exact: true })).toHaveValue(fixtureDirectory)
    await app.evaluate((_, settings) => globalThis.settingsRequests[0].resolve({ settings }), {
      ...valid,
      paths: { ...valid.paths, download: '' },
    })
    await expect(page.getByLabel('下载目录', { exact: true })).toHaveValue(fixtureDirectory)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(settingsCount).toBe(2)
    await app.evaluate(() => globalThis.settingsRequests[1].reject(new Error('配置读取失败替身')))
    await expect(page.locator('.config-error')).toContainText('配置读取失败')
    await expect(page.getByLabel('下载目录', { exact: true })).toHaveValue(fixtureDirectory)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(settingsCount).toBe(3)
    await app.evaluate((_, settings) => globalThis.settingsRequests[2].resolve({ settings }), valid)
    await expect(page.locator('.config-error')).toHaveCount(0)
  } finally {
    await save(original)
  }
}
