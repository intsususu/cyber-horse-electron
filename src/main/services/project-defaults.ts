import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { defaultSettings, settingsSchema, toolKeys } from '../../shared/contracts'
import type { SettingsStore } from './settings-store'
import type { CredentialStore } from './credential-store'

const pathMap = {
  download: 'downloadDirectory',
  preprocess: 'preprocessDirectory',
  mdcOutput: 'mdcOutputDirectory',
  nas: 'nasDirectory',
  whisperOutput: 'whisperWorkingDirectory',
  videoOutput: 'videoProcessingDirectory',
  mdc: 'mdcToolPath',
  whisper: 'whisperToolPath',
  mkvmerge: 'mkvToolNixPath',
  jasna: 'jasnaToolPath',
} as const

const projectDefaultsSchema = z
  .object({
    pathsAndTools: z.record(z.string(), z.string()),
    previousToolPaths: z.record(z.string(), z.string()).optional(),
    theme: z.object({ accentColor: z.string().regex(/^#[0-9a-f]{6}$/i) }).strict(),
    subtitle: settingsSchema.shape.subtitle,
    embyServer: settingsSchema.shape.mediaServer
      .extend({
        password: z
          .string()
          .max(1024)
          .refine((value) => !value.includes('\0')),
      })
      .strict(),
    privacyCover: z
      .object({
        embyPosterCoverImagePath: z.string(),
        embyThumbCoverImagePath: z.string(),
        defaultEyeOpen: z.boolean(),
      })
      .strict(),
  })
  .strict()

export function parseProjectDefaults(value: unknown) {
  const source = projectDefaultsSchema.parse(value)
  const settings = settingsSchema.parse({
    ...defaultSettings,
    paths: Object.fromEntries(
      Object.entries(pathMap).map(([key, field]) => [key, source.pathsAndTools[field]]),
    ),
    subtitle: source.subtitle,
    mediaServer: {
      serverUrl: source.embyServer.serverUrl,
      username: source.embyServer.username,
      downloadDirectory: source.embyServer.downloadDirectory,
      javbusUrl: source.embyServer.javbusUrl,
    },
    privacyCover: {
      posterPath: source.privacyCover.embyPosterCoverImagePath,
      thumbPath: source.privacyCover.embyThumbCoverImagePath,
      defaultEyeOpen: source.privacyCover.defaultEyeOpen,
    },
  })
  const previousToolPaths = Object.fromEntries(
    toolKeys.flatMap((key) => {
      const previous = source.previousToolPaths?.[pathMap[key]]
      return previous ? [[key, previous]] : []
    }),
  )
  return { settings, password: source.embyServer.password, previousToolPaths }
}

export async function initializeProjectDefaults(
  file: string,
  store: SettingsStore,
  credentials: CredentialStore,
): Promise<void> {
  let source: string
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('项目默认配置无法读取，请检查 config/default-settings.json。')
  }
  let defaults: ReturnType<typeof parseProjectDefaults>
  try {
    defaults = parseProjectDefaults(JSON.parse(source.replace(/^\uFEFF/, '')))
  } catch {
    throw new Error('项目默认配置格式无效，请检查 config/default-settings.json。')
  }
  // 项目文件保留用户提供的原格式，运行时密码仍交给系统安全存储。
  await store.initializeDefaults(
    defaults.settings,
    async () => {
      if (defaults.password && !(await credentials.hasPassword()))
        await credentials.savePassword(defaults.password)
    },
    defaults.previousToolPaths,
  )
}
