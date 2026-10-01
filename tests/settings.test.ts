import { mkdtemp, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/main/services/settings-store'
import { defaultSettings, settingsSchema, type SettingsResult } from '../src/shared/contracts'
import { checkPaths } from '../src/main/services/path-health'
import { reconcileSettingsDraft } from '../src/renderer/src/lib/settings-draft'
import { settingsSaveError } from '../src/renderer/src/lib/settings-errors'

describe('本地配置和文件保护', () => {
  it('VLC 选择和默认静音可保存，旧播放器配置补齐关闭状态', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    await writeFile(
      join(folder, 'settings.json'),
      JSON.stringify({ ...defaultSettings, player: { startMuted: false } }),
    )
    const store = new SettingsStore(folder)
    const previous = (await store.load()).settings
    expect(previous.player).toEqual({ startMuted: false, useVlc: false })
    await store.save({ ...previous, player: { ...previous.player, useVlc: true } })
    expect((await new SettingsStore(folder).load()).settings.player).toEqual({
      startMuted: false,
      useVlc: true,
    })
  })
  it('旧后台拒绝新增字段时提示完整重启，正确网站地址可以保存并恢复', async () => {
    const next = structuredClone(defaultSettings)
    next.mediaServer.javbusUrl = 'https://www.javbus.com'
    const legacy = settingsSchema.extend({
      mediaServer: settingsSchema.shape.mediaServer.omit({ javbusUrl: true }),
    })
    const rejected = legacy.safeParse(next)
    expect(rejected.success).toBe(false)
    if (!rejected.success) {
      const remoteError = new Error(
        `Error invoking remote method 'settings:save': ${rejected.error.message}`,
      )
      expect(settingsSaveError(remoteError)).toContain('桌面后台尚未更新')
    }
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    await new SettingsStore(folder).save(next)
    expect((await new SettingsStore(folder).load()).settings.mediaServer.javbusUrl).toBe(
      'https://www.javbus.com',
    )
  })
  it('首次读取返回默认配置且不会创建媒体或配置文件', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const result = await new SettingsStore(folder).load()
    expect(result.settings).toEqual(defaultSettings)
    expect(await readdir(folder)).toEqual([])
  })
  it('串行保存并跨实例恢复最终配置', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const store = new SettingsStore(folder)
    await Promise.all([
      store.save({ ...defaultSettings, theme: 'dark' }),
      store.save({ ...defaultSettings, theme: 'light' }),
    ])
    expect((await new SettingsStore(folder).load()).settings.theme).toBe('light')
    expect(await readdir(folder)).toEqual(['settings.json'])
  })
  it.each([1, 2])('版本 %i 的系统主题迁移为初号机，钢铁侠可保存并恢复', async (version) => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const store = new SettingsStore(folder)
    const legacy = {
      ...(version === 1 ? { version } : defaultSettings),
      theme: 'system' as const,
      paths: { ...defaultSettings.paths, preprocess: folder },
    }
    await writeFile(join(folder, 'settings.json'), JSON.stringify(legacy))
    const restored = (await store.load()).settings
    expect(restored).toEqual({ ...defaultSettings, paths: legacy.paths })
    expect(JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8'))).toEqual(restored)
    expect(settingsSchema.safeParse({ ...restored, theme: 'system' }).success).toBe(false)
    await store.save({ ...restored, theme: 'ironman' })
    expect((await new SettingsStore(folder).load()).settings).toEqual({
      ...restored,
      theme: 'ironman',
    })
  })
  it('旧配置移除 MDC 工具日志目录并补上播放器默认静音', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const previous = structuredClone(defaultSettings) as Record<string, unknown>
    previous.paths = { ...defaultSettings.paths, mdcLogDirectory: join(folder, '旧日志') }
    delete previous.player
    await writeFile(join(folder, 'settings.json'), JSON.stringify(previous))
    const restored = (await new SettingsStore(folder).load()).settings
    expect(restored.paths).not.toHaveProperty('mdcLogDirectory')
    expect(restored.player.startMuted).toBe(true)
    expect(JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8'))).toEqual(restored)
    await new SettingsStore(folder).save({
      ...restored,
      player: { ...restored.player, startMuted: false },
    })
    expect((await new SettingsStore(folder).load()).settings.player.startMuted).toBe(false)
  })
  it('版本 1 的设置自动升级并保留已保存的主题和路径', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    await writeFile(
      join(folder, 'settings.json'),
      JSON.stringify({
        version: 1,
        theme: 'light',
        paths: { ...defaultSettings.paths, preprocess: folder },
      }),
    )
    const settings = (await new SettingsStore(folder).load()).settings
    expect(settings).toMatchObject({
      version: 2,
      theme: 'light',
      paths: { preprocess: folder },
      subtitle: { format: 'srt' },
    })
    expect(JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8'))).toEqual(settings)
  })
  it('移除旧强调色字段时保留版本 2 的其他配置', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const previous = {
      ...defaultSettings,
      theme: 'dark',
      accentColor: '#427841',
      subtitle: { format: 'ass' },
    }
    await writeFile(join(folder, 'settings.json'), JSON.stringify(previous))
    const settings = (await new SettingsStore(folder).load()).settings
    expect(settings).toMatchObject({ theme: 'dark', subtitle: { format: 'ass' } })
    expect(settings).not.toHaveProperty('accentColor')
    expect(JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8'))).toEqual(settings)
  })
  it('损坏配置回退但保留原文件并备份', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const broken = '{ 无效配置'
    await writeFile(join(folder, 'settings.json'), broken)
    const result = await new SettingsStore(folder).load()
    expect(result.settings).toEqual(defaultSettings)
    expect(result.warning).toContain('配置无法读取')
    expect(await readFile(join(folder, 'settings.json'), 'utf8')).toBe(broken)
    expect((await readdir(folder)).some((name) => name.startsWith('settings.invalid-'))).toBe(true)
  })
  it('首次打开创建默认配置，重复打开不覆盖现有或损坏内容', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const store = new SettingsStore(folder)
    await Promise.all([store.ensureFile(), store.ensureFile()])
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual(defaultSettings)
    await writeFile(store.filePath, '{ 编辑中的内容')
    await store.ensureFile()
    expect(await readFile(store.filePath, 'utf8')).toBe('{ 编辑中的内容')
  })
  it('外部损坏或删除文件保留上次有效设置，修正后恢复且重复读取不重复备份', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const store = new SettingsStore(folder)
    const saved = { ...defaultSettings, theme: 'light' as const }
    await store.save(saved)
    await writeFile(store.filePath, '{ 无效')
    const broken = await store.load()
    expect(broken.settings).toEqual(saved)
    expect(broken.warning).toContain('上一次有效配置')
    await store.load()
    expect(
      (await readdir(folder)).filter((name) => name.startsWith('settings.invalid-')),
    ).toHaveLength(1)
    await unlink(store.filePath)
    expect((await store.load()).settings).toEqual(saved)
    const fixed = { ...saved, subtitle: { ...saved.subtitle, format: 'ass' as const } }
    await writeFile(store.filePath, '\uFEFF' + JSON.stringify(fixed))
    expect(await store.load()).toEqual({ settings: fixed })
  })
  it('监听外部替换保存并在取消订阅后停止通知', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const store = new SettingsStore(folder)
    await store.save(defaultSettings)
    const received: SettingsResult[] = []
    const stop = store.watch((result) => received.push(result))
    try {
      const updated = {
        ...defaultSettings,
        mediaServer: { ...defaultSettings.mediaServer, username: '外部编辑' },
      }
      await writeFile(join(folder, 'editor.tmp'), JSON.stringify(updated))
      await rename(join(folder, 'editor.tmp'), store.filePath)
      await expect.poll(() => received.at(-1)?.settings.mediaServer.username).toBe('外部编辑')
      stop()
      const count = received.length
      await store.save(defaultSettings)
      expect(received).toHaveLength(count)
    } finally {
      stop()
    }
  })
  it('同步文件变化时保留其他草稿字段，切换主题不回滚路径和字幕', () => {
    const draft = structuredClone(defaultSettings)
    draft.paths.download = '未保存的目录'
    draft.subtitle.format = 'ass'
    draft.player.startMuted = false
    draft.mediaServer.username = '未保存的用户名'
    const updated = structuredClone(defaultSettings)
    updated.theme = 'light'
    updated.mediaServer.username = '文件中的用户名'
    const merged = reconcileSettingsDraft(draft, defaultSettings, updated)
    expect(merged.paths.download).toBe(draft.paths.download)
    expect(merged.subtitle.format).toBe('ass')
    expect(merged.player.startMuted).toBe(false)
    expect(merged.theme).toBe('light')
    expect(merged.mediaServer.username).toBe('文件中的用户名')
    expect(draft.mediaServer.username).toBe('未保存的用户名')
  })
  it('拒绝未知版本、无效主题、空字符与超长路径', () => {
    expect(settingsSchema.safeParse({ ...defaultSettings, version: 3 }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...defaultSettings, theme: 'neon' }).success).toBe(false)
    expect(
      settingsSchema.safeParse({ ...defaultSettings, player: { startMuted: '是' } }).success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({
        ...defaultSettings,
        paths: { ...defaultSettings.paths, download: 'D:\\bad\0path' },
      }).success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({ ...defaultSettings, subtitle: { format: 'vtt' } }).success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({
        ...defaultSettings,
        mediaServer: { ...defaultSettings.mediaServer, serverUrl: 'file:///secret' },
      }).success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({
        ...defaultSettings,
        mediaServer: { ...defaultSettings.mediaServer, serverUrl: 'https://u:p@example.com' },
      }).success,
    ).toBe(false)
    expect(
      settingsSchema.safeParse({
        ...defaultSettings,
        paths: { ...defaultSettings.paths, download: 'a'.repeat(4097) },
      }).success,
    ).toBe(false)
  })
  it('区分未配置、相对路径、缺失、路径类型与可访问文件', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-test-'))
    const file = join(folder, 'sample-tool.txt')
    await writeFile(file, '工具路径检查占位文件，不会执行')
    const health = await checkPaths({
      ...defaultSettings,
      paths: {
        ...defaultSettings.paths,
        download: folder,
        preprocess: file,
        mdcOutput: 'relative',
        nas: join(folder, 'absent'),
        mdc: file,
        whisper: folder,
      },
    })
    const status = Object.fromEntries(health.map((item) => [item.key, item.status]))
    expect(status).toMatchObject({
      download: 'ready',
      preprocess: 'missing',
      mdcOutput: 'missing',
      nas: 'missing',
      mdc: 'ready',
      whisper: 'missing',
      jasna: 'unconfigured',
    })
  })
})
