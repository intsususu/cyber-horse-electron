import { z } from 'zod'
import type { MediaFile } from './contracts'

export const pipelineSteps = ['subtitle-mux', 'video', 'scrape', 'archive'] as const
export type PipelineStep = (typeof pipelineSteps)[number]
export const pipelineNames: Record<PipelineStep, string> = {
  'subtitle-mux': '字幕与封装',
  video: '视频破解',
  scrape: '元数据刮削',
  archive: '归档到 NAS',
}
export const pipelinePreviewSchema = z
  .object({
    steps: z
      .array(z.enum(pipelineSteps))
      .min(1)
      .max(4)
      .refine((items) => new Set(items).size === items.length),
    source: z.enum(['preprocess', 'current']),
    recursive: z.boolean(),
    selection: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('all') }).strict(),
      z
        .object({
          mode: z.literal('selected'),
          relativePaths: z.array(z.string().min(1).max(4096)).min(1).max(5000),
        })
        .strict(),
    ]),
  })
  .strict()
export const pipelineStartSchema = z.object({ planId: z.string().uuid() }).strict()
export type PipelineRequest = z.infer<typeof pipelinePreviewSchema>
export type PipelinePlan = {
  id: string
  createdAt: number
  steps: PipelineStep[]
  source: string
  mode: 'all' | 'selected'
  files: MediaFile[]
  relatedFiles: { video: string; files: string[] }[]
  destinations: { step: PipelineStep; directory: string }[]
  tools: string[]
  warnings: string[]
}
export type PipelineStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'
/** 当前文件的阶段进度；null 表示工具未提供可计算的进度。 */
export type PipelineProgress = {
  phase:
    | 'prepare'
    | 'vad'
    | 'transcribe'
    | 'restore'
    | 'mux'
    | 'validate'
    | 'publish'
    | 'scrape'
    | 'archive'
  percent: number | null
  approximate?: boolean
  fps?: number
  etaSeconds?: number
}
export type PipelineTask = {
  id: PipelineStep
  title: string
  status: PipelineStatus
  completed: number
  total: number
  skipped: number
  progress: number
  current?: PipelineProgress
  message: string
  startedAt?: string
  endedAt?: string
}
export type PipelineLog = {
  id: number
  time: string
  level: 'info' | 'warning' | 'success'
  text: string
}
export type PipelineState = {
  id: string
  status: 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: string
  endedAt?: string
  tasks: PipelineTask[]
  files: MediaFile[]
  source: string
  mode: 'all' | 'selected'
  logs: PipelineLog[]
  message: string
  journal: string
  outputs: string[]
  resultFiles: string[]
}
