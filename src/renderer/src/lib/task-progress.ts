import type { PipelineProgress } from '../../../shared/pipeline'
import type { DemoTask } from './workflow'

const phases: Record<PipelineProgress['phase'], string> = {
  prepare: '准备文件',
  vad: '语音检测',
  transcribe: '字幕识别',
  restore: '视频处理',
  mux: '封装',
  validate: '校验',
  publish: '回写与整理',
  scrape: '元数据刮削',
  archive: '复制与大小核对',
}
export function stageLabel(task: DemoTask): string {
  const current = task.current
  if (!current) return `${task.progress}%`
  return current.percent === null
    ? `${phases[current.phase]}中…`
    : `${phases[current.phase]}${current.approximate ? '约 ' : ' '}${Math.floor(current.percent)}%`
}
export function fileCountLabel(task: DemoTask): string {
  if (task.total === undefined) return ''
  return `已完成 ${task.completed ?? 0}/${task.total} 个文件${task.failed ? `，失败 ${task.failed}` : ''}${task.skipped ? `，跳过 ${task.skipped}` : ''}`
}
export function speedLabel(current?: PipelineProgress): string {
  if (!current) return ''
  const parts: string[] = []
  if (current.fps !== undefined) parts.push(`${current.fps.toFixed(1)} 帧/秒`)
  if (current.etaSeconds !== undefined) {
    const seconds = Math.ceil(current.etaSeconds)
    parts.push(`预计剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`)
  }
  return parts.join(' · ')
}
