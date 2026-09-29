import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  realpath,
  mkdir,
  open,
  opendir,
  link,
  unlink,
  copyFile,
  rmdir,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { homedir } from 'node:os'
import { isInternalMediaEntry } from '../../shared/media-files'

export type FileStamp = { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
export const pathKey = (path: string) =>
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
export const inside = (root: string, path: string): boolean =>
  pathKey(root) === pathKey(path) || pathKey(path).startsWith(pathKey(root) + sep)
export const overlap = (a: string, b: string) => inside(a, b) || inside(b, a)
export const checkpoint = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error('任务已取消。')
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
export async function checkDirectory(path: string): Promise<string> {
  if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path) || /^\\\\[?.]\\/.test(path))
    throw new Error('需要普通绝对目录路径。')
  const full = resolve(path)
  let current = parse(full).root
  for (const part of relative(current, full).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('目录包含链接或不是普通目录。')
  }
  return realpath(full)
}
export async function safeRoot(path: string, protectedPaths: string[]): Promise<string> {
  const root = await checkDirectory(path)
  if (root.split(sep).some(isInternalMediaEntry))
    throw new Error('不能把旧版本遗留目录用作处理范围。')
  if (pathKey(root) === pathKey(parse(root).root) || inside(root, homedir()))
    throw new Error('不能处理磁盘根目录或用户根目录。')
  for (const protectedPath of [
    ...protectedPaths,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ]) {
    if (!protectedPath) continue
    const protectedRoot = await realpath(protectedPath).catch(() => resolve(protectedPath))
    if (overlap(root, protectedRoot)) throw new Error('不能处理系统、应用数据或项目目录。')
  }
  return root
}
export async function fileStamp(path: string): Promise<FileStamp> {
  await checkDirectory(dirname(path))
  const value = await lstat(path)
  if (!value.isFile() || value.isSymbolicLink()) throw new Error('需要普通文件，不支持链接。')
  return {
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
    ino: value.ino,
    dev: value.dev,
  }
}
export async function unchanged(path: string, expected: FileStamp): Promise<void> {
  const current = await fileStamp(path)
  if (
    Object.keys(expected).some(
      (key) => current[key as keyof FileStamp] !== expected[key as keyof FileStamp],
    )
  )
    throw new Error('文件已变化，请重新预览并等待下载完成。')
}
export async function makeDirectory(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error('目标目录越界。')
  let current = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    await checkDirectory(current)
    current = join(current, part)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await checkDirectory(current)
  }
}
export async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const expected = await fileStamp(path)
  const input = await open(path, 'r')
  try {
    const hash = createHash('sha256'),
      buffer = Buffer.allocUnsafe(1024 * 1024)
    while (true) {
      checkpoint(signal)
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    await unchanged(path, expected)
    return hash.digest('hex')
  } finally {
    await input.close()
  }
}
/** 异步分块复制，取消时只删除本次独占创建的临时文件。 */
export async function copyChecked(
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  const expected = await fileStamp(source)
  await checkDirectory(dirname(target))
  const temporary = join(dirname(target), `.horse-${randomUUID()}.partial`)
  const input = await open(source, 'r')
  let output: Awaited<ReturnType<typeof open>> | undefined
  let owned = false
  try {
    output = await open(temporary, 'wx')
    owned = true
    const buffer = Buffer.allocUnsafe(1024 * 1024),
      hash = createHash('sha256')
    let size = 0
    while (true) {
      checkpoint(signal)
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      size += bytesRead
      if (size > expected.size) throw new Error('源文件仍在增长，已停止复制。')
      let written = 0
      while (written < bytesRead) {
        const next = await output.write(buffer, written, bytesRead - written)
        if (!next.bytesWritten) throw new Error('目标写入中断。')
        written += next.bytesWritten
      }
    }
    await output.sync()
    await output.close()
    output = undefined
    if (size !== expected.size || (await hashFile(temporary, signal)) !== hash.digest('hex'))
      throw new Error('文件复制校验失败，源文件已保留。')
    await unchanged(source, expected)
    checkpoint(signal)
    await checkDirectory(dirname(target))
    try {
      await link(temporary, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(code ?? ''))
        throw error
      // 网络盘可能不支持硬链接；独占复制后再次校验，失败绝不清理源文件。
      let targetOwned = false
      try {
        await copyFile(temporary, target, constants.COPYFILE_EXCL)
        targetOwned = true
        if ((await hashFile(temporary, signal)) !== (await hashFile(target, signal)))
          throw new Error('目标提交校验失败。')
      } catch (cause) {
        if (targetOwned) {
          await checkDirectory(dirname(target))
          await unlink(target)
        }
        throw cause
      }
    }
  } finally {
    await input.close()
    await output?.close()
    if (owned) {
      await checkDirectory(dirname(temporary))
      if (await exists(temporary)) await unlink(temporary)
    }
  }
}
/** NAS 归档只单向写入文件内容；目标位于带未完成标记的独占媒体目录内。 */
export async function copySizeChecked(
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  const expected = await fileStamp(source)
  await checkDirectory(dirname(target))
  const input = await open(source, 'r')
  let output: Awaited<ReturnType<typeof open>> | undefined
  try {
    output = await open(target, 'wx')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let size = 0
    while (true) {
      checkpoint(signal)
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > expected.size) throw new Error('源文件仍在增长，已停止复制。')
      let written = 0
      while (written < bytesRead) {
        checkpoint(signal)
        const next = await output.write(buffer, written, bytesRead - written)
        if (!next.bytesWritten) throw new Error('目标写入中断。')
        written += next.bytesWritten
      }
    }
    await output.sync()
    await output.close()
    output = undefined
    await unchanged(source, expected)
    if (size !== expected.size || (await fileStamp(target)).size !== expected.size)
      throw new Error('NAS 文件大小与本地源文件不一致，源文件已保留。')
    checkpoint(signal)
  } finally {
    await input.close()
    await output?.close()
  }
}
export async function availablePath(path: string, directory = false): Promise<string> {
  const extension = directory ? '' : extname(path),
    stem = basename(path, extension)
  let candidate = path,
    counter = 1
  while (await exists(candidate))
    candidate = join(dirname(path), `${stem}_${counter++}${extension}`)
  return candidate
}
export async function removeChecked(
  path: string,
  root: string,
  expected: FileStamp,
  signal: AbortSignal,
): Promise<void> {
  checkpoint(signal)
  if (!inside(root, path) || pathKey(path) === pathKey(root))
    throw new Error('待删除文件超出本次工作目录。')
  await unchanged(path, expected)
  checkpoint(signal)
  await unlink(path)
}

/** 同卷独占移动，不产生完整副本；跨卷时校验复制完成后再删除源文件。 */
export async function moveChecked(
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  checkpoint(signal)
  const before = await fileStamp(source)
  await checkDirectory(dirname(target))
  try {
    await link(source, target)
  } catch (error) {
    if (
      !['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EINVAL', 'ENOSYS'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error
    await copyChecked(source, target, signal)
    await removeChecked(source, dirname(source), before, signal)
    return
  }
  // 硬链接会改变 ctime，移动前核对其余内容身份字段。
  const [current, output] = await Promise.all([fileStamp(source), fileStamp(target)])
  if (
    [current, output].some(
      (value) =>
        value.dev !== before.dev ||
        value.ino !== before.ino ||
        value.size !== before.size ||
        value.mtimeMs !== before.mtimeMs,
    )
  )
    throw new Error('移动时文件发生变化，已保留现有文件。')
  await unlink(source)
}

export async function removeEmptyParents(directory: string, root: string): Promise<void> {
  let current = directory
  while (inside(root, current) && pathKey(current) !== pathKey(root)) {
    try {
      await checkDirectory(current)
      await rmdir(current)
    } catch (error) {
      if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    current = dirname(current)
  }
}
export async function listFiles(
  root: string,
  signal: AbortSignal,
  excludeInternal = true,
): Promise<string[]> {
  const files: string[] = [],
    pending = [root]
  const start = Date.now()
  let count = 0
  while (pending.length) {
    checkpoint(signal)
    const current = pending.pop()!
    await checkDirectory(current)
    for await (const entry of await opendir(current)) {
      if (++count > 100000 || Date.now() - start > 30000)
        throw new Error('文件范围过大或读取超时。')
      if (excludeInternal && isInternalMediaEntry(entry.name)) continue
      const path = join(current, entry.name),
        info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('文件范围包含链接，已停止。')
      if (info.isDirectory()) pending.push(path)
      else if (info.isFile()) files.push(path)
      else throw new Error('文件范围包含特殊文件，已停止。')
      if (files.length > 10000) throw new Error('文件范围超过 10000 项。')
    }
  }
  return files.sort()
}
