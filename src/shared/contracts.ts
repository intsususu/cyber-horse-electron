import { z } from 'zod'
import { javbusUrlSchema } from './media-links'
import type { MediaLibraryApi } from './media-library'
import type { PreparationPlan, PreparationState } from './preparation'
import type { PipelinePlan, PipelineRequest, PipelineState } from './pipeline'
import type { ExecutionRecordRequest } from './execution-record'

export const pathKeys = [
  'download',
  'preprocess',
  'mdcOutput',
  'nas',
  'whisperOutput',
  'videoOutput',
  'mdc',
  'whisper',
  'mkvmerge',
  'jasna',
] as const
export type PathKey = (typeof pathKeys)[number]
export const workDirectoryKeys = ['whisperOutput', 'videoOutput', 'mdcOutput', 'nas'] as const
export type WorkDirectoryKey = (typeof workDirectoryKeys)[number]
export const openDirectoryKeys = ['preprocess', 'current', ...workDirectoryKeys] as const
export type OpenDirectoryKey = (typeof openDirectoryKeys)[number]
export const toolKeys: PathKey[] = ['mdc', 'whisper', 'mkvmerge', 'jasna']
export const themeSchema = z.enum(['light', 'dark', 'system', 'eva'])
export type Theme = z.infer<typeof themeSchema>
const pathValueSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'), '路径不能包含空字符')
const shortTextSchema = z
  .string()
  .max(256)
  .refine((value) => !value.includes('\0'), '内容不能包含空字符')
const serverUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value.trim()) return true
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    } catch {
      return false
    }
  }, '服务器地址需要是有效的 HTTP 或 HTTPS 地址，且不能包含凭据')
const pathsSchema = z
  .object(
    Object.fromEntries(pathKeys.map((key) => [key, pathValueSchema])) as Record<
      PathKey,
      typeof pathValueSchema
    >,
  )
  .strict()
const legacySettingsSchema = z
  .object({
    version: z.literal(1),
    theme: themeSchema,
    paths: pathsSchema.extend({ mdcLogDirectory: pathValueSchema.optional() }),
  })
  .strict()
export const settingsSchema = z
  .object({
    version: z.literal(2),
    theme: themeSchema,
    paths: pathsSchema,
    subtitle: z.object({ format: z.enum(['srt', 'ass']) }).strict(),
    player: z.object({ startMuted: z.boolean() }).strict().default({ startMuted: true }),
    mediaServer: z
      .object({
        serverUrl: serverUrlSchema,
        username: shortTextSchema,
        downloadDirectory: pathValueSchema,
        javbusUrl: javbusUrlSchema,
      })
      .strict(),
    privacyCover: z
      .object({
        posterPath: pathValueSchema,
        thumbPath: pathValueSchema,
        defaultEyeOpen: z.boolean(),
      })
      .strict(),
  })
  .strict()
export type Settings = z.infer<typeof settingsSchema>
export const defaultSettings: Settings = {
  version: 2,
  theme: 'eva',
  paths: {
    ...(Object.fromEntries(pathKeys.map((key) => [key, ''])) as Record<PathKey, string>),
  },
  subtitle: { format: 'srt' },
  player: { startMuted: true },
  mediaServer: { serverUrl: '', username: '', downloadDirectory: '', javbusUrl: '' },
  privacyCover: { posterPath: '', thumbPath: '', defaultEyeOpen: true },
}
export function parseStoredSettings(value: unknown): Settings {
  const version =
    typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined
  if (version === 1) {
    const legacy = legacySettingsSchema.parse(value)
    const paths = { ...legacy.paths }
    delete paths.mdcLogDirectory
    return settingsSchema.parse({
      ...structuredClone(defaultSettings),
      theme: legacy.theme,
      paths,
    })
  }
  if (version === 2 && typeof value === 'object' && value !== null) {
    const current = { ...value } as Record<string, unknown>
    delete current.accentColor
    if (typeof current.paths === 'object' && current.paths !== null) {
      const paths = { ...current.paths } as Record<string, unknown>
      delete paths.mdcLogDirectory
      current.paths = paths
    }
    return settingsSchema.parse(current)
  }
  return settingsSchema.parse(value)
}
export const preferencePathKeys = ['mediaDownload', 'posterCover', 'thumbCover'] as const
export type PreferencePathKey = (typeof preferencePathKeys)[number]
export type HealthItem = {
  key: PathKey
  // ready 只代表目录或入口文件可读取，不代表工具运行环境已验证。
  status: 'ready' | 'missing' | 'unconfigured' | 'unavailable'
  message: string
}
export type SettingsResult = { settings: Settings; warning?: string }
export const inputRequestSchema = z
  .object({
    mode: z.enum(['directory', 'files']),
    recursive: z.boolean(),
  })
  .strict()
export type InputRequest = z.infer<typeof inputRequestSchema>
export const refreshInputRequestSchema = z
  .object({
    source: z.enum(['preprocess', 'download', 'current']),
    recursive: z.boolean(),
  })
  .strict()
export type RefreshInputRequest = z.infer<typeof refreshInputRequestSchema>
export type MediaFile = {
  path: string
  name: string
  relativePath: string
  size: number
  modifiedAt: number
}
export type InputSelection = {
  mode: InputRequest['mode']
  directory: string | null
  recursive: boolean
  files: MediaFile[]
  skipped: number
}
export type MetricState = 'loading' | 'ready' | 'unavailable'
export type PerformanceSnapshot = {
  sampledAt: number
  cpu: { usage: number | null; model: string; cores: number }
  memory: { used: number; total: number; usage: number }
  gpu: { usage: number | null; state: MetricState; sampledAt: number | null; name: string }
  network: {
    receive: number | null
    send: number | null
    state: MetricState
    sampledAt: number | null
    interfaces: string[]
  }
}
export interface DesktopApi extends MediaLibraryApi {
  openExecutionRecord(request: ExecutionRecordRequest): Promise<void>
  previewPipeline(request: PipelineRequest): Promise<PipelinePlan>
  startPipeline(request: { planId: string }): Promise<PipelineState>
  getPipelineState(): Promise<PipelineState | null>
  cancelPipeline(): Promise<void>
  previewPreparation(): Promise<PreparationPlan>
  startPreparation(request: { planId: string }): Promise<PreparationState>
  getPreparationState(): Promise<PreparationState | null>
  cancelPreparation(): Promise<void>
  getSettings(): Promise<SettingsResult>
  getSettingsLocation(): Promise<string>
  openSettingsFile(): Promise<void>
  onSettingsChanged(listener: (result: SettingsResult) => void): () => void
  saveSettings(settings: Settings): Promise<void>
  choosePath(key: PathKey): Promise<string | null>
  choosePreferencePath(key: PreferencePathKey): Promise<string | null>
  getCredentialStatus(): Promise<boolean>
  saveCredential(password: string): Promise<void>
  checkPaths(): Promise<HealthItem[]>
  chooseInputs(request: InputRequest): Promise<InputSelection | null>
  refreshInputs(request: RefreshInputRequest): Promise<InputSelection>
  openWorkDirectory(key: OpenDirectoryKey): Promise<void>
  getPerformance(): Promise<PerformanceSnapshot>
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>
}
