import { lstat, opendir, access } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { InputSelection, MediaFile } from '../../shared/contracts'
import { isInternalMediaEntry } from '../../shared/media-files'

export const mediaExtensions = [
  'mp4',
  'mkv',
  'avi',
  'mov',
  'wmv',
  'flv',
  'm4v',
  'ts',
  'mts',
  'm2ts',
  'webm',
  'mpg',
  'mpeg',
  'vob',
]
const isMedia = (file: string) => mediaExtensions.includes(extname(file).slice(1).toLowerCase())

/** 只枚举路径、大小和修改时间，不读取媒体内容、不跟随符号链接或联接目录。 */
export async function collectMediaInputs(
  paths: string[],
  recursive: boolean,
  directory: boolean,
  limit = 5000,
): Promise<InputSelection> {
  if (!paths.length || paths.some((path) => !isAbsolute(path) || path.includes('\0')))
    throw new Error('请选择有效的绝对路径')
  const root = directory ? resolve(paths[0]!) : null
  const files: MediaFile[] = []
  const seen = new Set<string>()
  let skipped = 0
  let visited = 0
  const startedAt = Date.now()
  async function addFile(path: string) {
    if (!isMedia(path)) return
    const canonical = resolve(path)
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    if (seen.has(key)) return
    seen.add(key)
    let info
    try {
      info = await lstat(canonical)
    } catch {
      skipped++
      return
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      skipped++
      return
    }
    files.push({
      path: canonical,
      name: basename(canonical),
      relativePath: root ? relative(root, canonical) : basename(canonical),
      size: info.size,
      modifiedAt: info.mtimeMs,
    })
    if (files.length > limit)
      throw new Error(`视频文件超过 ${limit} 个，请选择较小目录或直接选择文件`)
  }
  if (root) {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('请选择普通目录，不支持符号链接或联接目录')
    const pending = [root]
    while (pending.length) {
      const current = pending.pop()!
      if (
        await access(join(current, '.cyber-horse-incomplete')).then(
          () => true,
          () => false,
        )
      )
        continue
      let entries
      try {
        entries = await opendir(current)
      } catch {
        if (current === root) throw new Error('无法读取所选目录')
        skipped++
        continue
      }
      for await (const entry of entries) {
        if (isInternalMediaEntry(entry.name)) continue
        if (++visited > 100000 || Date.now() - startedAt > 20000)
          throw new Error('目录范围过大或读取超时，请缩小范围后重试')
        const path = join(current, entry.name)
        if (entry.isSymbolicLink()) {
          skipped++
          continue
        }
        if (recursive && entry.isDirectory()) pending.push(path)
        else if (entry.isFile()) await addFile(path)
      }
    }
  } else {
    if (paths.length > limit) throw new Error(`一次最多选择 ${limit} 个文件`)
    for (const path of paths) await addFile(path)
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }))
  return {
    mode: directory ? 'directory' : 'files',
    directory: root,
    recursive: directory && recursive,
    files,
    skipped,
  }
}
