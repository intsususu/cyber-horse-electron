const { listPackage, extractFile } = require('@electron/asar')
const { join, posix } = require('node:path')

// 检查最终归档，避免构建目录被清理或资源漏打包时交付空白窗口。
module.exports = async function verifyPackagedAssets(context) {
  const archive = join(context.appOutDir, 'resources', 'app.asar')
  const files = new Set(listPackage(archive).map((file) => file.replaceAll('\\', '/')))
  const required = ['/out/main/index.js', '/out/preload/index.js', '/out/renderer/index.html']
  for (const file of required) {
    if (!files.has(file)) throw new Error(`打包失败：应用归档缺少启动文件 ${file}`)
  }
  const html = extractFile(archive, join('out', 'renderer', 'index.html')).toString('utf8')
  const resources = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"?#]+)"/g)]
  if (!resources.some((match) => match[1].endsWith('.js')))
    throw new Error('打包失败：主页面缺少界面脚本入口')
  for (const [, resource] of resources) {
    const file = posix.join('/out/renderer', resource)
    if (!files.has(file)) throw new Error(`打包失败：应用归档缺少页面资源 ${file}`)
  }
  console.log('成品资源检查通过：主页面、预加载及页面引用文件完整。')
}
