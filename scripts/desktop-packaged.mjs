import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// 直接启动免安装成品，覆盖临时解压与归档资源加载，不能用开发构建代替。
const executable = resolve(process.argv[2] || 'release/Cyber-Horse-0.1.0-x64-portable.exe')
const output = resolve('test-results')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(output, 'packaged-profile-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], {
  env,
  windowsHide: true,
  stdio: 'ignore',
})
let launchError
child.on('error', (error) => (launchError = error))
let browser
try {
  let port
  await expect
    .poll(
      async () => {
        if (launchError) throw launchError
        try {
          port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]
          return Boolean(port)
        } catch {
          return false
        }
      },
      { timeout: 60000, message: '免安装程序应完成解压并启动浏览器进程' },
    )
    .toBe(true)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  const page = context.pages()[0] || (await context.waitForEvent('page'))
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible({
    timeout: 30000,
  })
  await expect(page.locator('.brand-mark img')).toBeVisible()
  expect(await page.locator('.brand-mark img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(
    0,
  )
  for (const theme of ['深色', '浅色']) {
    await page.getByRole('button', { name: `${theme}模式`, exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      theme === '深色' ? 'dark' : 'light',
    )
    await page.screenshot({ path: join(output, `成品启动-${theme}.png`), scale: 'css' })
  }
  console.log('免安装成品启动验证通过：工作台、马头图标和深浅主题均正常加载。')
} finally {
  if (browser) {
    const session = await browser.newBrowserCDPSession()
    const disconnected = new Promise((resolve) => browser.once('disconnected', resolve))
    void session.send('Browser.close').catch(() => {})
    await disconnected
    await browser.close()
  } else {
    child.kill()
  }
}
