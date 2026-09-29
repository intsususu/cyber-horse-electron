import type { PipelineProgress } from '../../shared/pipeline'
import { redactToolLine } from './tool-process'

export type ProgressReporter = (progress: PipelineProgress) => void

function seconds(value: string): number | null {
  const parts = value.split(':').map(Number)
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  )
    return null
  if (parts.at(-1)! >= 60 || (parts.length === 3 && parts[1]! >= 60)) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

/** 只识别已知工具格式，避免将模型下载、日志中的百分比当成处理进度。 */
export function toolProgress(
  tool: 'whisper' | 'jasna' | 'mkvmerge',
  report: ProgressReporter,
  durationSeconds?: number,
): (line: string) => boolean {
  let latestTimestamp = 0
  let lastPercent = 0
  return (raw) => {
    const line = redactToolLine(raw).trim()
    if (tool === 'whisper') {
      const vad = /^VAD(?:进度|\s+progress)\s*[:：]\s*(\d+)\s*\/\s*(\d+)/i.exec(line)
      if (vad) {
        const current = Number(vad[1]),
          total = Number(vad[2])
        if (!Number.isSafeInteger(total) || total <= 0 || current > total) return false
        // 智能分块会多次执行 VAD，各轮独立计算，不冒充整个文件的完成度。
        report({ phase: 'vad', percent: (current / total) * 100 })
        return true
      }
      const segment = /^\[(\d+(?::\d{2}){1,2}\.\d+)\s*-->\s*(\d+(?::\d{2}){1,2}\.\d+)\]/.exec(line)
      if (!segment) return false
      const start = seconds(segment[1]!),
        end = seconds(segment[2]!)
      if (start === null || end === null || end < start) return false
      latestTimestamp = Math.max(latestTimestamp, end)
      const knownDuration =
        durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0
      report({
        phase: 'transcribe',
        percent: knownDuration ? Math.min(99, (latestTimestamp / durationSeconds!) * 100) : null,
        approximate: true,
      })
      return true
    }
    const match =
      tool === 'jasna'
        ? /^Processing video:\s*(\d+(?:\.\d+)?)%\|/.exec(line)
        : /^(?:#GUI#progress\s+|Progress:\s*|进度[:：]\s*)(\d+(?:\.\d+)?)%$/.exec(line)
    if (!match) return false
    const percent = Number(match[1])
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return false
    lastPercent = Math.max(lastPercent, percent)
    const progress: PipelineProgress = {
      phase: tool === 'jasna' ? 'restore' : 'mux',
      percent: lastPercent,
    }
    if (tool === 'jasna') {
      const fps = /\bSpeed:\s*(\d+(?:\.\d+)?)fps\b/.exec(line)
      const eta = /\bRemaining:\s*(\d+(?::\d{2}){1,2})\b/.exec(line)
      if (fps && Number.isFinite(Number(fps[1])) && Number(fps[1]) > 0)
        progress.fps = Number(fps[1])
      const remaining = eta ? seconds(eta[1]!) : null
      if (remaining !== null) progress.etaSeconds = remaining
    }
    report(progress)
    return true
  }
}
