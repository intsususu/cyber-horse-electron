import { spawn } from 'node:child_process'
import { expect } from '@playwright/test'

/** 第二次启动必须退出并唤起原窗口，不能创建第二套任务服务。 */
export async function verifySingleInstance(application, environment) {
  const executable = await application.evaluate(({ app, BrowserWindow }) => {
    globalThis.singleInstanceReceived = false
    app.once('second-instance', () => {
      globalThis.singleInstanceReceived = true
    })
    BrowserWindow.getAllWindows()[0].minimize()
    return process.execPath
  })
  const child = spawn(executable, ['.'], {
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('同一配置的第二个应用没有及时退出。'))
    }, 15000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  expect(code).toBe(0)
  expect(stderr).not.toMatch(/Unable to (?:move the cache|create cache)|Gpu Cache Creation failed/i)
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) => ({
        received: globalThis.singleInstanceReceived,
        windows: BrowserWindow.getAllWindows().length,
        minimized: BrowserWindow.getAllWindows()[0].isMinimized(),
      })),
    )
    .toEqual({ received: true, windows: 1, minimized: false })
}
