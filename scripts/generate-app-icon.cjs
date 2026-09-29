// 使用项目已有的 Electron 图像能力，从同一母版生成界面图标与 Windows 多尺寸图标。
// 运行：electron scripts/generate-app-icon.cjs
const { app, nativeImage } = require('electron')
const { writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

app.whenReady().then(() => {
  try {
    const source = nativeImage.createFromPath(resolve(__dirname, '../assets/icon-master.png'))
    if (source.isEmpty()) throw new Error('无法读取应用图标母版')
    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const images = sizes.map((size) =>
      source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    )
    const header = Buffer.alloc(6 + sizes.length * 16)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16
      header[entry] = size === 256 ? 0 : size
      header[entry + 1] = size === 256 ? 0 : size
      header.writeUInt16LE(1, entry + 4)
      header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(images[index].length, entry + 8)
      header.writeUInt32LE(offset, entry + 12)
      offset += images[index].length
    })
    writeFileSync(resolve(__dirname, '../assets/icon.ico'), Buffer.concat([header, ...images]))
    writeFileSync(
      resolve(__dirname, '../assets/icon.png'),
      source.resize({ width: 512, height: 512, quality: 'best' }).toPNG(),
    )
    console.log('已生成统一应用图标：界面 PNG 与 Windows 多尺寸 ICO。')
    app.exit(0)
  } catch (error) {
    console.error('生成应用图标失败：', error)
    app.exit(1)
  }
})
