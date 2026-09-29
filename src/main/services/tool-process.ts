import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { delimiter, isAbsolute, join } from 'node:path'

export type ProcessRequest = {
  executable: string
  args: string[]
  cwd: string
  signal: AbortSignal
  timeoutMs?: number
  onLine?: (line: string, error: boolean) => void
  captureLimit?: number
  pathEntries?: string[]
}
export type ProcessResult = { code: number; stdout: string; stderr: string }
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>

export const runTool: ProcessRunner = (request) =>
  new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new Error('任务已取消。'))
      return
    }
    if (
      !isAbsolute(request.executable) ||
      !isAbsolute(request.cwd) ||
      request.args.some((arg) => arg.includes('\0')) ||
      request.pathEntries?.some(
        (path) => !isAbsolute(path) || path.includes('\0') || path.includes(delimiter),
      )
    ) {
      reject(new Error('工具参数无效。'))
      return
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
    }
    if (request.pathEntries?.length) {
      // Windows 环境变量名不区分大小写，避免 Path 与 PATH 同时存在而丢失追加目录。
      const pathKey =
        Object.keys(env).find((key) =>
          process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH',
        ) ?? 'PATH'
      env[pathKey] = [...request.pathEntries, env[pathKey] ?? ''].filter(Boolean).join(delimiter)
    }
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env,
    })
    const limit = request.captureLimit ?? 2 * 1024 * 1024
    let stdout = '',
      stderr = '',
      failure = '',
      terminating: Promise<void> | null = null
    const stop = (reason: string) => {
      if (terminating) return
      failure = reason
      terminating = new Promise((done) => {
        if (!child.pid) {
          done()
          return
        }
        if (process.platform === 'win32') {
          const killer = spawn(
            join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/t', '/f'],
            { shell: false, windowsHide: true, stdio: 'ignore' },
          )
          const timer = setTimeout(() => {
            killer.kill()
            child.kill()
            done()
          }, 10000)
          killer.once('error', () => {
            clearTimeout(timer)
            child.kill()
            done()
          })
          killer.once('close', () => {
            clearTimeout(timer)
            done()
          })
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
          done()
        }
      })
    }
    const abort = () => stop('任务已取消，工具进程已停止。')
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const timer = setTimeout(
      () => stop('工具运行超时，已请求停止进程及子进程。'),
      request.timeoutMs ?? 24 * 60 * 60_000,
    )
    const flushers: (() => void)[] = []
    for (const [stream, isError] of [
      [child.stdout, false],
      [child.stderr, true],
    ] as const) {
      const decoder = new StringDecoder('utf8')
      let pending = ''
      const receive = (chunk: string) => {
        if (isError) stderr = (stderr + chunk).slice(-limit)
        else stdout = (stdout + chunk).slice(-limit)
        pending += chunk
        const lines = pending.split(/[\r\n]/)
        pending = lines.pop()!.slice(-8192)
        for (const line of lines) if (line.trim()) request.onLine?.(line.slice(0, 8192), isError)
      }
      stream.on('data', (data: Buffer) => receive(decoder.write(data)))
      flushers.push(() => {
        receive(decoder.end())
        if (pending.trim()) request.onLine?.(pending, isError)
      })
    }
    const cleanup = () => {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
    }
    child.once('error', () => {
      cleanup()
      reject(new Error('无法启动工具，请检查可执行文件及运行环境。'))
    })
    child.once('close', async (code) => {
      cleanup()
      await terminating
      flushers.forEach((flush) => flush())
      if (failure) reject(new Error(failure))
      else resolve({ code: code ?? -1, stdout, stderr })
    })
  })

/** 不把工具输出中的常见凭据、查询串或控制字符写入界面和日志。 */
export function redactToolLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key|authorization|密码|令牌)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[已隐藏]',
    )
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/https?:\/\/[^\s]+/gi, (url) => {
      try {
        const value = new URL(url)
        return `${value.protocol}//${value.host}${value.pathname}`
      } catch {
        return '[地址已隐藏]'
      }
    })
    .slice(0, 2000)
}
