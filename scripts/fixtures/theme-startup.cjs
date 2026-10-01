const { app, ipcMain } = require('electron')
const { resolve } = require('node:path')

// 在测试启动器中延迟真实配置响应，观察首次显示；生产代码不包含测试开关。
app.setAppPath(resolve('.'))
globalThis.themeStartupProbe = { reads: 0, shows: [], requested: false, resolved: false }
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  handle(
    channel,
    channel === 'settings:get'
      ? async (...args) => {
          if (!globalThis.themeStartupProbe.requested) {
            globalThis.themeStartupProbe.requested = true
            // 模拟配置尚未返回时再次启动，主窗口不能因此提前出现。
            app.emit('second-instance', {}, [], process.cwd(), {})
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
          const result = await listener(...args)
          globalThis.themeStartupProbe.reads += 1
          globalThis.themeStartupProbe.resolved = true
          return result
        }
      : listener,
  )
app.on('browser-window-created', (_event, window) => {
  window.on('show', () => {
    const show = {
      configured: globalThis.themeStartupProbe.resolved,
      theme: null,
      background: null,
    }
    globalThis.themeStartupProbe.shows.push(show)
    void window.webContents
      .executeJavaScript(
        `({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor
    })`,
      )
      .then((state) => Object.assign(show, state))
  })
})
require(resolve('out/main/index.js'))
