import { z } from 'zod'
import type { PipelineStep, PipelineProgress } from './pipeline'
import { mediaUserDataSnapshotSchema } from './media-user-data'

const label = z.string().trim().min(1).max(512)
const instant = z.string().datetime()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const invalidPart = (part: string) =>
  !part ||
  part === '.' ||
  part === '..' ||
  /[<>:"|?*\x00-\x1f]/.test(part) ||
  /[ .]$/.test(part) ||
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)

/** 清单内部路径统一使用斜杠；主进程仍必须验证实际目录边界和链接。 */
export const taskRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes('\\') && !value.split('/').some(invalidPart), '任务路径无效')

export const taskAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\x00-\x1f]/.test(value) &&
      !/^\\\\[?.]\\/.test(value) &&
      (/^[A-Za-z]:[\\/]/.test(value) ||
        /^\\\\[^\\]+\\[^\\]+/.test(value) ||
        value.startsWith('/')) &&
      !value.split(/[\\/]/).some((part) => part === '..' || part === '.'),
    '需要普通绝对路径',
  )

export const taskFileStampSchema = z
  .object({
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().finite(),
    ctimeMs: z.number().finite(),
    ino: z.number().nonnegative().finite(),
    dev: z.number().nonnegative().finite(),
  })
  .strict()

export const taskSteps = [
  'download',
  'preparation',
  'subtitle-mux',
  'video',
  'scrape',
  'archive',
] as const
export const taskStepSchema = z.enum(taskSteps)
export const taskStateSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'interrupted',
  'failed',
  'cancelled',
  'finalizing',
  'completed',
  'removed',
])
const markSchema = z
  .object({
    present: z.boolean(),
    evidence: z.enum(['none', 'filename', 'verified-output']),
  })
  .strict()
  .refine((mark) => mark.present === (mark.evidence !== 'none'), '处理标记与证据不一致')

export const taskArtifactSchema = z
  .object({
    path: taskRelativePathSchema,
    role: z.enum(['input', 'subtitle', 'output', 'temporary']),
    state: z.enum(['reserved', 'verified', 'removing', 'removed']),
    stamp: taskFileStampSchema.nullable(),
    sha256: digest.nullable(),
  })
  .strict()
  .refine(
    (artifact) => artifact.state !== 'verified' || artifact.stamp !== null,
    '已校验文件缺少快照',
  )

export const taskPublicationSchema = z
  .object({
    source: taskRelativePathSchema,
    target: taskAbsolutePathSchema,
    sha256: digest,
    size: z.number().int().positive(),
    state: z.enum(['pending', 'committing', 'published', 'cleaned']),
    previous: taskFileStampSchema.nullable(),
    // NAS 只使用写入成功后持久化的快照；旧记录缺失时禁止推断发布成功。
    stagedStamp: taskFileStampSchema.optional(),
    targetStamp: taskFileStampSchema.optional(),
  })
  .strict()

export const taskContextSchema = z
  .object({
    configuration: digest,
    media: z
      .object({
        processId: z.string().uuid(),
        downloadId: z.string().uuid(),
        name: label,
      })
      .strict()
      .optional(),
    replacements: z
      .array(
        z
          .object({
            path: taskAbsolutePathSchema,
            stamp: taskFileStampSchema,
            sha256: digest.nullable(),
            removed: z.boolean().default(false),
            removalPending: z.boolean().default(false),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    sync: z
      .object({
        server: digest,
        serverIdentity: digest.nullable().default(null),
        itemId: z.string().min(1).max(200),
        originalRemotePath: z.string().min(1).max(4096),
        userData: mediaUserDataSnapshotSchema.optional(),
        state: z.enum(['pending', 'confirmed', 'waived']),
        message: z.string().max(2000),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()

export const taskFileSchema = z
  .object({
    id: z.string().uuid(),
    name: label,
    number: z
      .string()
      .regex(/^[A-Z]{2,6}-\d{2,6}$/)
      .nullable(),
    directory: taskRelativePathSchema,
    sources: z
      .array(
        z
          .object({
            path: taskAbsolutePathSchema,
            stamp: taskFileStampSchema,
            target: taskRelativePathSchema,
            state: z.enum(['pending', 'claiming', 'claimed']),
            copy: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    marks: z.object({ chinese: markSchema, restored: markSchema }).strict(),
    steps: z
      .array(
        z
          .object({
            id: taskStepSchema,
            state: z.enum(['pending', 'running', 'validating', 'verified', 'skipped', 'failed']),
            startedAt: instant.nullable(),
            endedAt: instant.nullable(),
            message: z.string().max(2000),
            inputVideo: taskRelativePathSchema.nullable().default(null),
            inputFiles: z.array(taskRelativePathSchema).max(1000).default([]),
            outputVideo: taskRelativePathSchema.nullable().default(null),
            outputFiles: z.array(taskRelativePathSchema).max(1000).default([]),
            attempt: z.number().int().nonnegative().max(1000).default(0),
          })
          .strict(),
      )
      .min(1)
      .max(taskSteps.length),
    artifacts: z.array(taskArtifactSchema).max(1000),
    publications: z.array(taskPublicationSchema).max(1000).default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const prefix = file.directory.toLowerCase() + '/'
    const paths = [
      ...file.sources.map((source) => source.target),
      ...file.artifacts.map((a) => a.path),
      ...file.publications.map((publication) => publication.source),
      ...file.steps.flatMap((step) =>
        [step.inputVideo, step.outputVideo, ...step.inputFiles, ...step.outputFiles].filter(
          (path): path is string => path !== null,
        ),
      ),
    ]
    if (paths.some((path) => !path.toLowerCase().startsWith(prefix)))
      ctx.addIssue({ code: 'custom', message: '文件路径超出所属任务子目录' })
    for (const group of [file.sources.map((s) => s.target), file.artifacts.map((a) => a.path)])
      if (new Set(group.map((path) => path.toLowerCase())).size !== group.length)
        ctx.addIssue({ code: 'custom', message: '同一文件清单内存在重复路径' })
  })

export const taskManifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    name: label,
    origin: z.enum(['workbench', 'media-library', 'download', 'preparation']),
    createdAt: instant,
    updatedAt: instant,
    downloadRoot: taskAbsolutePathSchema,
    workspaceName: taskRelativePathSchema.refine((name) => !name.includes('/'), '任务目录名无效'),
    destination: z
      .object({
        kind: z.enum(['download', 'preprocess', 'nas', 'media-original']),
        root: taskAbsolutePathSchema,
      })
      .strict(),
    state: taskStateSchema,
    removalAction: z.enum(['keep', 'delete']).optional(),
    steps: z.array(taskStepSchema).min(1).max(taskSteps.length),
    files: z.array(taskFileSchema).min(1).max(5000),
    message: z.string().max(2000),
    context: taskContextSchema.nullable().default(null),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (new Set(task.steps).size !== task.steps.length)
      ctx.addIssue({ code: 'custom', message: '步骤不能重复' })
    if (
      task.steps.some(
        (step, i) => i > 0 && taskSteps.indexOf(step) <= taskSteps.indexOf(task.steps[i - 1]!),
      )
    )
      ctx.addIssue({ code: 'custom', message: '处理步骤顺序无效' })
    if (new Set(task.files.map((f) => f.id)).size !== task.files.length)
      ctx.addIssue({ code: 'custom', message: '文件标识不能重复' })
    const directories = task.files.map((f) => f.directory.toLowerCase())
    const directorySet = new Set(directories)
    if (
      directorySet.size !== directories.length ||
      directories.some((dir) => {
        const parts = dir.split('/')
        return parts.some((_, i) => i > 0 && directorySet.has(parts.slice(0, i).join('/')))
      })
    )
      ctx.addIssue({ code: 'custom', message: '文件子目录重复或重叠' })
    const sources = task.files.flatMap((f) =>
      f.sources.map((s) => s.path.replace(/\\/g, '/').toLowerCase()),
    )
    if (new Set(sources).size !== sources.length)
      ctx.addIssue({ code: 'custom', message: '来源文件不能重复接管' })
    for (const file of task.files)
      if (JSON.stringify(file.steps.map((step) => step.id)) !== JSON.stringify(task.steps))
        ctx.addIssue({ code: 'custom', message: '文件步骤与批次步骤不一致' })
    if (task.updatedAt < task.createdAt)
      ctx.addIssue({ code: 'custom', message: '任务更新时间无效' })
    if (
      task.state === 'completed' &&
      task.files.some((f) => f.steps.some((s) => !['verified', 'skipped'].includes(s.state)))
    )
      ctx.addIssue({ code: 'custom', message: '任务步骤尚未完成校验' })
  })

export type TaskManifest = z.infer<typeof taskManifestSchema>
export type TaskFile = z.infer<typeof taskFileSchema>
export type TaskState = z.infer<typeof taskStateSchema>

export const taskConfirmationSchema = z
  .object({ planId: z.string().uuid(), revision: z.number().int().nonnegative() })
  .strict()

export const taskRootRegistrySchema = z
  .object({
    version: z.literal(1),
    roots: z.array(taskAbsolutePathSchema).max(1000),
  })
  .strict()

export const taskIdRequestSchema = z.object({ id: z.string().uuid() }).strict()
export const taskActionSchema = z.enum(['resume', 'keep', 'delete', 'finish'])
export const taskPreviewRequestSchema = taskIdRequestSchema
  .extend({ action: taskActionSchema })
  .strict()
export type TaskAction = z.infer<typeof taskActionSchema>
export type TaskView = {
  task: TaskManifest
  directory: string
  active: boolean
  recoverable: boolean
  diagnostic: string
  progress?: Partial<Record<PipelineStep, PipelineProgress>>
}
export type TaskActionPlan = {
  planId: string
  revision: number
  id: string
  action: TaskAction
  name: string
  directory: string
  destination: string
  files: { path: string; size: number; disposition: string }[]
  summary: { name: string; sources: string[]; steps: TaskFile['steps']; published: string[] }[]
  warnings: string[]
  expiresAt: number
}
export interface TaskApi {
  listWorkspaceTasks(): Promise<{
    tasks: TaskView[]
    diagnostics: { directory: string; message: string }[]
  }>
  cancelWorkspaceTask(request: { id: string }): Promise<void>
  previewWorkspaceAction(request: { id: string; action: TaskAction }): Promise<TaskActionPlan>
  confirmWorkspaceAction(request: { planId: string; revision: number }): Promise<void>
  openWorkspaceDirectory(request: { id: string }): Promise<void>
}
