import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'

/** 只读核对任务路径占用；无法确认时禁止接管，不结束任何外部进程。 */
export async function assertNoTaskProcess(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    const result = await promisify(execFile)(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
    )
    const processes: { ProcessId: number; CommandLine?: string }[] = JSON.parse(
      result.stdout || '[]',
    )
    const key = directory.replace(/\\/g, '/').toLowerCase()
    if (
      processes.some(
        (entry) =>
          entry.ProcessId !== process.pid &&
          entry.CommandLine?.replace(/\\/g, '/').toLowerCase().includes(key),
      )
    )
      throw new Error('仍有工具进程使用任务目录，请等待退出后重新预览。')
  } else if (process.platform === 'linux') {
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')
      if (command.includes(directory)) throw new Error('仍有工具进程使用任务目录，未接管。')
    }
  } else throw new Error('当前平台无法确认遗留进程，请保留任务目录。')
}
