import { spawn } from 'node:child_process'
import { mkdir, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// 使用 Windows 自带的 .NET Framework 编译器，不增加 npm 或运行时依赖。
if (process.platform === 'win32') {
  const compiler = join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  )
  await access(compiler).catch(() => {
    throw new Error('缺少 Windows .NET Framework 编译器，无法准备 VLC 内嵌播放器。')
  })
  await mkdir('out/native', { recursive: true })
  const child = spawn(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/platform:x64',
      '/optimize+',
      '/reference:System.Windows.Forms.dll',
      '/reference:System.Drawing.dll',
      '/reference:System.Web.Extensions.dll',
      `/win32manifest:${resolve('native/vlc-host/app.manifest')}`,
      `/out:${resolve('out/native/vlc-host.exe')}`,
      resolve('native/vlc-host/Program.cs'),
    ],
    { stdio: 'inherit', windowsHide: true, shell: false },
  )
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('VLC 播放器编译失败。')),
    )
  })
}
