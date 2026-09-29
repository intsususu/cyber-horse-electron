import { readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { Settings } from '../../shared/contracts'
import type { PipelineStep } from '../../shared/pipeline'
import {
  fileStamp,
  type FileStamp,
  unchanged,
  listFiles,
  hashFile,
  checkpoint,
  exists,
  availablePath,
  checkDirectory,
  inside,
} from './safe-files'
import { runTool, type ProcessRunner, type ProcessResult, redactToolLine } from './tool-process'
import { parseSrt, srtToAss } from './subtitles'
import { checkWhisperSource, type CheckedFile } from './whisper-source'
import { toolProgress, type ProgressReporter } from './tool-progress'
import { mediaIdentity, verifyMediaIdentity, type MediaIdentity } from './media-identity'
import { verifyMdcMetadata } from './mdc-metadata'

export type ToolName = 'whisper' | 'mkvmerge' | 'jasna' | 'mdc' | 'ffprobe'
export type CheckedTool = {
  path: string
  stamp: FileStamp
  cwd: string
  argsPrefix: string[]
  dependencies: CheckedFile[]
  pathEntries?: string[]
}
export type CheckedTools = Partial<Record<ToolName, CheckedTool>>
export async function verifyCheckedTool(tool: CheckedTool): Promise<void> {
  await unchanged(tool.path, tool.stamp)
  for (const dependency of tool.dependencies) await unchanged(dependency.path, dependency.stamp)
}
export function requiredTools(steps: PipelineStep[]): ToolName[] {
  return [
    ...new Set<ToolName>(
      steps.flatMap((step) =>
        step === 'subtitle-mux'
          ? ['whisper', 'mkvmerge', 'ffprobe']
          : step === 'video'
            ? ['jasna', 'mkvmerge', 'ffprobe']
            : step === 'scrape'
              ? ['mdc']
              : [],
      ) as ToolName[],
    ),
  ]
}
const toolLabels: Record<ToolName, string> = {
  whisper: 'Whisper',
  mkvmerge: 'MKVToolNix',
  jasna: 'Jasna',
  mdc: 'MDC',
  ffprobe: 'ffprobe',
}
const capabilities: Record<ToolName, string[]> = {
  whisper: ['--sub_formats', '--audio_suffixes', '--device'],
  mkvmerge: ['--identify', '--output'],
  jasna: ['--input', '--output', '--post-export-action', '--post-export-video-command'],
  mdc: ['--cli', '--config-override', '--local-config-file'],
  ffprobe: ['-show_format', '-show_streams'],
}
function checkWhisperRuntime(name: ToolName, result: ProcessResult): void {
  if (name === 'whisper') {
    const missing = (result.stderr + result.stdout).match(
      /Library ((?:cublas(?:Lt)?|cudnn\w*|cudart)\w*\.dll) is not found or cannot be loaded/i,
    )
    if (missing)
      throw new Error(
        `Whisper 无法加载 GPU 运行库 ${missing[1]}。请在 Whisper 源码目录的 cuda/bin 中配置匹配的 CUDA 12 与 cuDNN 9 运行库，并检查其依赖。源文件已保留。`,
      )
  }
  if (
    name === 'whisper' &&
    result.code === 103 &&
    /No Python at\s/i.test(result.stderr + result.stdout)
  )
    throw new Error(
      'Whisper 虚拟环境无法访问基础 Python（退出码 103）。请检查 .venv/pyvenv.cfg 中 home 指向的 Python 是否存在且当前应用有权访问；建议使用工具目录内的独立 Python 重建虚拟环境。源文件未因本次失败删除。',
    )
}
export class PipelineTools {
  constructor(private readonly runner: ProcessRunner = runTool) {}
  async check(
    settings: Settings,
    steps: PipelineStep[],
    signal: AbortSignal,
    isolated = false,
  ): Promise<CheckedTools> {
    const tools: CheckedTools = {}
    for (const name of requiredTools(steps)) {
      checkpoint(signal)
      let path = name === 'ffprobe' ? '' : settings.paths[name]
      if (name === 'ffprobe') {
        for (const tool of ['jasna', 'whisper', 'mkvmerge'] as const) {
          if (!settings.paths[tool]) continue
          for (const folder of ['', 'tools']) {
            const base =
              tool === 'whisper' &&
              (await stat(settings.paths[tool]).catch(() => null))?.isDirectory()
                ? settings.paths[tool]
                : dirname(settings.paths[tool])
            const candidate = join(
              base,
              folder,
              process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
            )
            if (await exists(candidate)) {
              path = candidate
              break
            }
          }
          if (path) break
        }
        if (!path)
          throw new Error(
            '缺少视频校验工具 ffprobe，请将其放在 Jasna、Whisper 或 MKVToolNix 同目录或 tools 子目录。',
          )
      }
      if (!path) throw new Error(`请配置 ${toolLabels[name]} 的入口路径。`)
      const pathInfo = await stat(path).catch(() => null)
      if (!pathInfo) throw new Error(`${toolLabels[name]} 入口不存在，请检查配置。`)
      let checked: CheckedTool
      if (name === 'whisper' && pathInfo.isDirectory()) {
        const source = await checkWhisperSource(path)
        checked = {
          path: source.executable.path,
          stamp: source.executable.stamp,
          cwd: source.cwd,
          argsPrefix: source.argsPrefix,
          dependencies: source.dependencies,
          pathEntries: source.pathEntries,
        }
      } else {
        if (process.platform === 'win32' && extname(path).toLowerCase() !== '.exe')
          throw new Error(`请配置 ${toolLabels[name]} 的可执行文件，不能使用批处理脚本。`)
        checked = {
          path,
          stamp: await fileStamp(path),
          cwd: dirname(path),
          argsPrefix: [],
          dependencies: [],
        }
      }
      const result = await this.runner({
        executable: checked.path,
        args: [...checked.argsPrefix, '--help'],
        cwd: checked.cwd,
        signal,
        timeoutMs: 60000,
        pathEntries: checked.pathEntries,
      })
      const help = result.stdout + result.stderr
      if (result.code !== 0) {
        checkWhisperRuntime(name, result)
        const detail = (result.stderr || result.stdout)
          .split(/[\r\n]+/)
          .map((line) => redactToolLine(line).trim())
          .filter(Boolean)
          .slice(-3)
          .join('；')
          .slice(0, 600)
        throw new Error(
          `${toolLabels[name]} 命令行能力检测失败，退出码 ${result.code}。${detail || '工具未返回错误说明，请检查运行环境。'}`,
        )
      }
      const missing = capabilities[name].filter((flag) => !help.includes(flag))
      if (isolated && name === 'whisper' && !help.includes('--output_dir'))
        missing.push('--output_dir')
      if (isolated && name === 'jasna' && !help.includes('--working-directory'))
        missing.push('--working-directory')
      if (missing.length)
        throw new Error(`${toolLabels[name]} 命令行能力检测缺少参数：${missing.join('、')}。`)
      tools[name] = checked
    }
    return tools
  }
  async invoke(
    tools: CheckedTools,
    name: ToolName,
    args: string[],
    signal: AbortSignal,
    log: (line: string, warning?: boolean) => void,
    timeoutMs?: number,
    allowedCodes = [0],
    consumeProgress?: (line: string) => boolean,
  ): Promise<string> {
    const tool = tools[name]
    if (!tool) throw new Error(`${toolLabels[name]} 尚未通过检测。`)
    await verifyCheckedTool(tool)
    const result = await this.runner({
      executable: tool.path,
      args: [...tool.argsPrefix, ...args],
      cwd: tool.cwd,
      signal,
      timeoutMs,
      pathEntries: tool.pathEntries,
      onLine: (line, error) => {
        if (signal.aborted) return
        if (consumeProgress?.(line)) return
        const text = redactToolLine(line).trim()
        if (text) log(`${toolLabels[name]} · ${text}`, error)
      },
    })
    checkpoint(signal)
    if (!allowedCodes.includes(result.code)) {
      checkWhisperRuntime(name, result)
      if (
        name === 'whisper' &&
        /UnicodeEncodeError:\s*['"](?:gbk|cp936)['"] codec/i.test(result.stderr + result.stdout)
      )
        throw new Error(
          'Whisper 在 Windows GBK 编码下输出字符时崩溃。当前打包版本未采纳 UTF-8 环境变量，请更换修复了标准输出编码的 Whisper 版本；源文件已保留。',
        )
      throw new Error(
        `${toolLabels[name]} 执行失败，退出码 ${result.code}。源文件已保留，请查看日志。`,
      )
    }
    if (result.code !== 0) log(`${toolLabels[name]} 返回警告，将继续校验输出。`, true)
    return result.stdout
  }
  async inspect(
    tools: CheckedTools,
    path: string,
    signal: AbortSignal,
  ): Promise<{ duration: number; audio: boolean; chinese: boolean; subtitles: boolean }> {
    const raw = await this.invoke(
      tools,
      'mkvmerge',
      ['--output-charset', 'UTF-8', '-J', path],
      signal,
      () => {},
      60000,
    )
    let data: {
      container?: { recognized?: boolean; supported?: boolean; properties?: { duration?: number } }
      tracks?: { type?: string; properties?: { language?: string; language_ietf?: string } }[]
    }
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error('无法读取视频结构，输出未通过校验。')
    }
    const probe = await this.invoke(
      tools,
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
      signal,
      () => {},
      60000,
    )
    let duration: number
    try {
      const metadata = JSON.parse(probe) as {
        format?: { duration?: string }
        streams?: { duration?: string; codec_type?: string }[]
      }
      duration =
        Number(
          metadata.format?.duration ??
            metadata.streams?.find((track) => track.codec_type === 'video')?.duration,
        ) * 1e9
    } catch {
      throw new Error('无法读取视频时长，未通过校验。')
    }
    if (
      !data.container?.recognized ||
      !data.container.supported ||
      !data.tracks?.some((track) => track.type === 'video') ||
      !duration ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      throw new Error('视频缺少可识别的视频轨道或时长，未通过校验。')
    return {
      duration,
      audio: data.tracks.some((track) => track.type === 'audio'),
      subtitles: data.tracks.some((track) => track.type === 'subtitles'),
      chinese: data.tracks.some(
        (track) =>
          track.type === 'subtitles' &&
          /^(chi|zho|zh)(-|$)/i.test(
            track.properties?.language_ietf ?? track.properties?.language ?? '',
          ),
      ),
    }
  }
  async validateVideo(
    tools: CheckedTools,
    input: string,
    output: string,
    signal: AbortSignal,
    subtitles = false,
  ): Promise<void> {
    if (!(await fileStamp(output)).size) throw new Error('视频输出为空。')
    const before = await this.inspect(tools, input, signal),
      after = await this.inspect(tools, output, signal)
    if (
      Math.abs(after.duration - before.duration) > Math.max(2e9, before.duration * 0.02) ||
      (before.audio && !after.audio) ||
      (subtitles && !after.chinese)
    )
      throw new Error('视频时长、音轨或中文字幕轨道校验失败，源文件已保留。')
  }
  async subtitle(
    tools: CheckedTools,
    input: string,
    output: string,
    format: 'srt' | 'ass',
    signal: AbortSignal,
    log: (line: string, warning?: boolean) => void,
    report: ProgressReporter = () => {},
    subtitleDirectory?: string,
  ): Promise<string> {
    report({ phase: 'validate', percent: null })
    const inspection = await this.inspect(tools, input, signal)
    if (!inspection.audio) throw new Error('视频没有音轨，无法提取字幕。')
    if (subtitleDirectory) await checkDirectory(subtitleDirectory)
    const srt = join(subtitleDirectory ?? dirname(input), basename(input, extname(input)) + '.srt')
    report({ phase: 'transcribe', percent: null })
    if (!(await exists(srt)))
      await this.invoke(
        tools,
        'whisper',
        [
          '--audio_suffixes',
          extname(input).slice(1),
          '--sub_formats',
          'srt',
          '--device',
          'cuda',
          '--log_level',
          'DEBUG',
          ...(subtitleDirectory ? ['--output_dir', subtitleDirectory] : []),
          input,
        ],
        signal,
        log,
        undefined,
        [0],
        toolProgress('whisper', report, inspection.duration / 1e9),
      )
    report({ phase: 'validate', percent: null })
    const info = await fileStamp(srt)
    if (info.size > 8 * 1024 * 1024) throw new Error('字幕超过 8 MiB，未执行封装。')
    const cues = parseSrt(await readFile(srt))
    if (cues.some((cue) => cue.end > inspection.duration / 1e6 + 2000))
      throw new Error('字幕时间轴超出视频时长，未执行封装。')
    const subtitle = format === 'ass' ? await availablePath(srt.slice(0, -4) + '.ass') : srt
    if (format === 'ass')
      await writeFile(subtitle, srtToAss(cues), { encoding: 'utf8', flag: 'wx' })
    try {
      report({ phase: 'mux', percent: null })
      await this.invoke(
        tools,
        'mkvmerge',
        [
          '--gui-mode',
          '--output-charset',
          'UTF-8',
          '-o',
          output,
          '--no-subtitles',
          input,
          '--language',
          '0:chi',
          '--track-name',
          '0:中文字幕',
          '--default-track-flag',
          '0:yes',
          subtitle,
        ],
        signal,
        log,
        undefined,
        [0, 1],
        toolProgress('mkvmerge', report),
      )
      report({ phase: 'validate', percent: null })
      await this.validateVideo(tools, input, output, signal, true)
      return subtitle
    } catch (error) {
      if (!subtitleDirectory && format === 'ass' && (await exists(subtitle))) await unlink(subtitle)
      throw error
    }
  }
  async video(
    tools: CheckedTools,
    input: string,
    output: string,
    signal: AbortSignal,
    log: (line: string, warning?: boolean) => void,
    report: ProgressReporter = () => {},
    workspace?: { restored: string; workingDirectory: string },
  ): Promise<void> {
    report({ phase: 'validate', percent: null })
    const before = await this.inspect(tools, input, signal)
    const restored = workspace?.restored ?? output + '.jasna.mkv'
    if (workspace) await checkDirectory(workspace.workingDirectory)
    report({ phase: 'restore', percent: null })
    await this.invoke(
      tools,
      'jasna',
      [
        '--input',
        input,
        '--output',
        restored,
        '--working-directory',
        workspace?.workingDirectory ?? dirname(output),
        '--post-export-action',
        'none',
        '--post-export-command',
        '',
        '--post-export-video-command',
        '',
      ],
      signal,
      log,
      undefined,
      [0],
      toolProgress('jasna', report),
    )
    report({ phase: 'validate', percent: null })
    await this.validateVideo(tools, input, restored, signal)
    report({ phase: 'mux', percent: null })
    await this.invoke(
      tools,
      'mkvmerge',
      [
        '--gui-mode',
        '-o',
        output,
        '--no-audio',
        '--no-subtitles',
        restored,
        ...(before.audio || before.subtitles
          ? ['--no-video', '--no-chapters', '--no-attachments', input]
          : []),
      ],
      signal,
      log,
      undefined,
      [0, 1],
      toolProgress('mkvmerge', report),
    )
    report({ phase: 'validate', percent: null })
    await this.validateVideo(tools, input, output, signal, before.chinese)
    if (!workspace) await unlink(restored)
  }
  async scrape(
    tools: CheckedTools,
    input: string,
    outputDirectory: string,
    signal: AbortSignal,
    log: (line: string, warning?: boolean) => void,
    expected: MediaIdentity = mediaIdentity(input),
    companions: string[] = [],
  ): Promise<string[]> {
    const sourceDirectory = dirname(input)
    if (/[;=\r\n]/.test(sourceDirectory + outputDirectory))
      throw new Error('MDC 目录不能包含分号、等号或换行，请更换目录。')
    const expectedHash = await hashFile(input, signal)
    const subtitles: { extension: string; hash: string }[] = []
    for (const path of companions) {
      if (dirname(path) !== sourceDirectory) throw new Error('MDC 关联输入不在同一目录。')
      if (/\.(srt|ass|vtt)$/i.test(path))
        subtitles.push({
          extension: extname(path).toLowerCase(),
          hash: await hashFile(path, signal),
        })
    }
    const previous = new Map<string, FileStamp>()
    for (const path of await listFiles(outputDirectory, signal)) {
      previous.set(path, await fileStamp(path))
      if (
        /\.(mp4|mkv|avi|mov|wmv|flv|m4v|ts|mts|m2ts|webm|mpg|mpeg|vob)$/i.test(path) &&
        basename(path, extname(path)).toLowerCase() ===
          basename(input, extname(input)).toLowerCase()
      )
        throw new Error('MDC 输出目录已有同名视频，请先核对，避免工具覆盖。')
    }
    await this.invoke(
      tools,
      'mdc',
      [
        '-cli',
        input,
        '-C',
        `common:source_folders=${JSON.stringify([sourceDirectory.replace(/\\/g, '/')])}`,
        '-C',
        `common:success_folder=${outputDirectory.replace(/\\/g, '/')}`,
        '--log-dir=',
      ],
      signal,
      log,
      2 * 60 * 60_000,
    )
    for (const [path, stamp] of previous) await unchanged(path, stamp)
    const files = (await listFiles(outputDirectory, signal)).filter((path) => !previous.has(path))
    const videos = files.filter((path) =>
      /\.(mp4|mkv|avi|mov|wmv|flv|m4v|ts|mts|m2ts|webm|mpg|mpeg|vob)$/i.test(path),
    )
    if (videos.length !== 1 || (await hashFile(videos[0]!, signal)) !== expectedHash)
      throw new Error('MDC 没有生成唯一且完整的视频产物，请核对源目录与输出目录。')
    verifyMediaIdentity(videos[0]!, expected)
    if (files.some((path) => !inside(dirname(videos[0]!), path)))
      throw new Error('MDC 产物分散在多个目录，未提交输出。')
    const nfo = join(dirname(videos[0]!), basename(videos[0]!, extname(videos[0]!)) + '.nfo')
    if (!files.includes(nfo) || (await fileStamp(nfo)).size > 2 * 1024 * 1024)
      throw new Error('MDC 缺少配套元数据文件或文件过大。')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(nfo))
    verifyMdcMetadata(text, expected)
    if (
      !files.some(
        (path) => /\.(jpe?g|png|webp)$/i.test(path) && /poster|thumb|fanart/i.test(basename(path)),
      )
    )
      throw new Error('MDC 未生成封面资源，未提交输出。')
    for (const path of files)
      if (!(await fileStamp(path)).size) throw new Error('MDC 存在空的输出文件，未提交。')
    for (const subtitle of subtitles) {
      let retained = false
      for (const path of files.filter((path) => extname(path).toLowerCase() === subtitle.extension))
        if ((await hashFile(path, signal)) === subtitle.hash) {
          retained = true
          break
        }
      if (!retained) throw new Error('MDC 产物缺少原有字幕或字幕内容发生变化，未提交输出。')
    }
    return files
  }
}
