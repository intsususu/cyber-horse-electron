import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  pathKeys,
  toolKeys,
  type Settings,
  type HealthItem,
  type PathKey,
} from '../../shared/contracts'

async function inspectPath(key: PathKey, path: string): Promise<HealthItem> {
  if (!path.trim()) return { key, status: 'unconfigured', message: '尚未配置' }
  if (!isAbsolute(path)) return { key, status: 'missing', message: '请选择绝对路径' }
  try {
    await access(path, constants.R_OK)
    const information = await stat(path)
    if (key === 'whisper' && information.isDirectory()) {
      try {
        await access(join(path, 'infer.py'), constants.R_OK)
        await access(
          join(
            path,
            '.venv',
            process.platform === 'win32' ? 'Scripts' : 'bin',
            process.platform === 'win32' ? 'python.exe' : 'python',
          ),
          constants.R_OK,
        )
      } catch {
        return {
          key,
          status: 'missing',
          message: '源码目录缺少 infer.py 或 .venv 中的 Python 入口',
        }
      }
      return { key, status: 'ready', message: '源码与 Python 入口可读取，运行环境待预览检测' }
    }
    if (!toolKeys.includes(key) && !information.isDirectory()) {
      return { key, status: 'missing', message: '需要选择文件夹' }
    }
    if (toolKeys.includes(key) && !information.isFile()) {
      return { key, status: 'missing', message: '需要选择工具入口文件' }
    }
    return {
      key,
      status: 'ready',
      message: toolKeys.includes(key) ? '入口文件可读取' : '目录可读取',
    }
  } catch {
    return { key, status: 'missing', message: '路径不存在或无读取权限' }
  }
}

export async function checkPaths(settings: Settings): Promise<HealthItem[]> {
  return Promise.all(
    pathKeys.map(async (key) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // 网络盘的系统读取可能无法中止；限时返回未知状态，不将超时当成路径不存在。
        return await Promise.race([
          inspectPath(key, settings.paths[key]),
          new Promise<HealthItem>((resolve) => {
            timer = setTimeout(
              () =>
                resolve({
                  key,
                  status: 'unavailable',
                  message: '检查超时，请确认磁盘或网络连接后重试',
                }),
              5000,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }),
  )
}
