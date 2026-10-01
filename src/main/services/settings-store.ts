import { watchFile, unwatchFile } from 'node:fs'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { replaceRecordFile } from './record-replacement'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  defaultSettings,
  parseStoredSettings,
  settingsSchema,
  type Settings,
  type SettingsResult,
} from '../../shared/contracts'

export class SettingsStore {
  private pending: Promise<unknown> = Promise.resolve()
  private validSettings: Settings | undefined
  private lastSource: string | undefined
  private lastResult: SettingsResult | undefined
  private listeners = new Set<(result: SettingsResult) => void>()
  readonly filePath: string

  constructor(private readonly directory: string) {
    this.filePath = join(directory, 'settings.json')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.pending.catch(() => {}).then(operation)
    this.pending = pending
    return pending
  }

  private publish(result: SettingsResult): SettingsResult {
    const changed = this.lastResult && JSON.stringify(this.lastResult) !== JSON.stringify(result)
    this.lastResult = structuredClone(result)
    if (changed) for (const listener of this.listeners) listener(structuredClone(result))
    return structuredClone(result)
  }

  load(): Promise<SettingsResult> {
    return this.enqueue(async () => {
      let source: string | undefined
      try {
        source = await readFile(this.filePath, 'utf8')
        if (source === this.lastSource && this.lastResult) return structuredClone(this.lastResult)
        const data: unknown = JSON.parse(source.replace(/^\uFEFF/, ''))
        const settings = parseStoredSettings(data)
        this.validSettings = settings
        this.lastSource = source
        if (!isDeepStrictEqual(data, settings)) {
          try {
            await this.write(settings)
          } catch {
            return this.publish({
              settings,
              warning: '旧配置已读取，但升级写入失败；原配置仍保留在应用数据目录。',
            })
          }
        }
        return this.publish({ settings })
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        if (!missing && source !== this.lastSource) {
          try {
            await copyFile(
              this.filePath,
              join(this.directory, `settings.invalid-${Date.now()}.json`),
            )
          } catch {
            /* 无法备份时保留原文件，等待用户显式保存。 */
          }
        }
        this.lastSource = source
        return this.publish({
          settings: this.validSettings ?? structuredClone(defaultSettings),
          ...(!missing || this.validSettings
            ? {
                warning: this.validSettings
                  ? '配置文件无效或无法读取，继续使用上一次有效配置；请修正文件后保存。'
                  : '配置无法读取，已使用默认值；原配置保留在应用数据目录。',
              }
            : {}),
        })
      }
    })
  }

  private async write(settings: Settings): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const source = JSON.stringify(settings, null, 2) + '\n'
    const temporary = this.filePath + '.tmp'
    await writeFile(temporary, source, 'utf8')
    await replaceRecordFile(temporary, this.filePath)
    this.lastSource = source
  }

  save(value: Settings): Promise<void> {
    const settings = settingsSchema.parse(value)
    return this.enqueue(async () => {
      await this.write(settings)
      this.validSettings = settings
      this.publish({ settings })
    })
  }

  initializeDefaults(
    value: Settings,
    beforeWrite?: () => Promise<void>,
    previousToolPaths: Partial<Settings['paths']> = {},
  ): Promise<boolean> {
    const settings = settingsSchema.parse(value)
    return this.enqueue(async () => {
      let existing: Settings | undefined
      try {
        existing = parseStoredSettings(
          JSON.parse((await readFile(this.filePath, 'utf8')).replace(/^\uFEFF/, '')),
        )
      } catch (error) {
        // 损坏文件留给现有恢复流程，不能用项目默认值覆盖。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      }
      if (
        existing &&
        JSON.stringify({ ...existing, theme: defaultSettings.theme }) !==
          JSON.stringify(defaultSettings)
      ) {
        const paths = { ...existing.paths }
        let changed = false
        for (const key of ['mdc', 'whisper', 'mkvmerge', 'jasna'] as const) {
          const previous = previousToolPaths[key]
          if (
            previous &&
            paths[key].toLowerCase() === previous.toLowerCase() &&
            paths[key] !== settings.paths[key]
          ) {
            paths[key] = settings.paths[key]
            changed = true
          }
        }
        if (!changed) return false
        const upgraded = { ...existing, paths }
        await this.write(upgraded)
        this.validSettings = upgraded
        this.publish({ settings: upgraded })
        return true
      }
      const next = { ...settings, theme: existing?.theme ?? settings.theme }
      await beforeWrite?.()
      await this.write(next)
      this.validSettings = next
      this.publish({ settings: next })
      return true
    })
  }

  ensureFile(): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true })
      try {
        // 仅首次打开时创建；已有文件（包括损坏文件）交给用户编辑，不覆盖。
        await writeFile(
          this.filePath,
          JSON.stringify(this.validSettings ?? defaultSettings, null, 2) + '\n',
          {
            encoding: 'utf8',
            flag: 'wx',
          },
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    })
  }

  watch(listener: (result: SettingsResult) => void): () => void {
    this.listeners.add(listener)
    const refresh = () => {
      void this.load()
    }
    // 监听固定文件的状态变化，兼容编辑器使用临时文件替换保存。
    watchFile(this.filePath, { interval: 500, persistent: false }, refresh)
    return () => {
      this.listeners.delete(listener)
      unwatchFile(this.filePath, refresh)
    }
  }
}
