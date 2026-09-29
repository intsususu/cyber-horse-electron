import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkDirectory, fileStamp, type FileStamp } from './safe-files'

export type CheckedFile = { path: string; stamp: FileStamp }
export type WhisperSource = {
  executable: CheckedFile
  cwd: string
  argsPrefix: string[]
  dependencies: CheckedFile[]
  pathEntries: string[]
}

/** 源码模式只运行约定位置的入口和虚拟环境，不从 PATH 查找解释器。 */
export async function checkWhisperSource(directory: string): Promise<WhisperSource> {
  const root = await checkDirectory(directory)
  const executablePath = join(
    root,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  )
  const packageDirectory = join(root, 'src', 'faster_whisper_transwithai_chickenrice')
  const files = [
    join(root, 'infer.py'),
    join(root, 'generation_config.json5'),
    join(root, 'models', 'config.json'),
    join(root, 'models', 'model.bin'),
    join(root, 'models', 'whisper_vad.onnx'),
    join(root, 'models', 'whisper_vad_metadata.json'),
  ]
  let sourceFiles: string[]
  try {
    await checkDirectory(packageDirectory)
    sourceFiles = (await readdir(packageDirectory))
      .filter((name) => name.endsWith('.py'))
      .map((name) => join(packageDirectory, name))
  } catch {
    throw new Error('Whisper 源码目录缺少 src/faster_whisper_transwithai_chickenrice。')
  }
  if (!sourceFiles.some((path) => path.endsWith('infer.py')))
    throw new Error('Whisper 源码目录缺少推理模块 infer.py。')
  const checked = async (path: string, label: string): Promise<CheckedFile> => {
    try {
      return { path, stamp: await fileStamp(path) }
    } catch {
      throw new Error(`Whisper 源码目录缺少或无法读取${label}。`)
    }
  }
  const executable = await checked(executablePath, '虚拟环境中的 Python 入口 .venv')
  const dependencies = await Promise.all(
    [...files, ...sourceFiles].map((path) => checked(path, path.slice(root.length + 1))),
  )
  const pathEntries: string[] = []
  if (process.platform === 'win32') {
    const cudaDirectory = join(root, 'cuda', 'bin')
    const cudaInfo = await lstat(cudaDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (cudaInfo) {
      await checkDirectory(cudaDirectory)
      for (const name of await readdir(cudaDirectory)) {
        if (name.toLowerCase().endsWith('.dll'))
          dependencies.push(await checked(join(cudaDirectory, name), `CUDA 运行库 ${name}`))
      }
      pathEntries.push(cudaDirectory)
    }
  }
  return {
    executable,
    cwd: root,
    argsPrefix: [
      '-I',
      '-B',
      '-X',
      'utf8',
      join(root, 'infer.py'),
      '--model_name_or_path',
      join(root, 'models'),
      '--generation_config',
      join(root, 'generation_config.json5'),
    ],
    dependencies,
    pathEntries,
  }
}
