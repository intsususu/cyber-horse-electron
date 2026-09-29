import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/contracts'
import { SettingsStore } from '../src/main/services/settings-store'
import { CredentialStore } from '../src/main/services/credential-store'
import {
  initializeProjectDefaults,
  parseProjectDefaults,
} from '../src/main/services/project-defaults'

function fixture() {
  return {
    pathsAndTools: Object.fromEntries(
      [
        'downloadDirectory',
        'preprocessDirectory',
        'mdcOutputDirectory',
        'nasDirectory',
        'whisperWorkingDirectory',
        'videoProcessingDirectory',
        'mdcToolPath',
        'whisperToolPath',
        'mkvToolNixPath',
        'jasnaToolPath',
      ].map((key) => [key, `D:\\测试\\${key}`]),
    ),
    theme: { accentColor: '#7C3AED' },
    subtitle: { format: 'ass' },
    embyServer: {
      serverUrl: 'http://localhost:8096',
      username: '测试',
      password: '测试密码',
      downloadDirectory: '',
    },
    privacyCover: {
      embyPosterCoverImagePath: 'assets/poster.png',
      embyThumbCoverImagePath: 'assets/thumb.png',
      defaultEyeOpen: true,
    },
  }
}

describe('项目默认配置', () => {
  it('转换所有目录、工具和偏好，运行时配置不含明文密码', () => {
    const source = fixture()
    const result = parseProjectDefaults(source)
    expect(Object.values(result.settings.paths).filter(Boolean)).toHaveLength(10)
    expect(result.settings.paths.whisper).toBe(source.pathsAndTools.whisperToolPath)
    expect(result.settings.subtitle.format).toBe('ass')
    expect(result.settings.privacyCover.posterPath).toBe('assets/poster.png')
    expect(result.settings.mediaServer).not.toHaveProperty('password')
    expect(result.password).toBe(source.embyServer.password)
  })
  it('首次启动和旧空配置使用项目默认值，已有配置与损坏文件不覆盖', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'horse-defaults-'))
    const store = new SettingsStore(directory)
    const configured = parseProjectDefaults(fixture()).settings
    expect(await store.initializeDefaults(configured)).toBe(true)
    expect((await store.load()).settings).toEqual(configured)
    const customized = { ...configured, paths: { ...configured.paths, download: 'D:\\自定义' } }
    await store.save(customized)
    expect(await store.initializeDefaults(configured)).toBe(false)
    expect((await store.load()).settings).toEqual(customized)
    await store.save({ ...defaultSettings, theme: 'light' })
    expect(await store.initializeDefaults(configured)).toBe(true)
    expect((await store.load()).settings.theme).toBe('light')
    await writeFile(store.filePath, '{ 损坏')
    expect(await store.initializeDefaults(configured)).toBe(false)
    expect(await readFile(store.filePath, 'utf8')).toBe('{ 损坏')
  })
  it('只升级与旧默认值一致的工具路径，保留用户自定义项', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'horse-tool-upgrade-'))
    const store = new SettingsStore(directory)
    const current = {
      ...defaultSettings,
      paths: {
        ...defaultSettings.paths,
        download: 'D:\\个人下载',
        mdc: 'D:\\工具\\MDC-旧版\\MDC.exe',
        whisper: 'D:\\工具\\语音',
        mkvmerge: 'D:\\工具\\封装',
        jasna: 'D:\\个人工具\\jasna.exe',
      },
    }
    await store.save(current)
    const updated = {
      ...current,
      paths: {
        ...current.paths,
        mdc: 'D:\\工具\\MDC-新版\\MDC.exe',
        whisper: 'D:\\工具\\语音\\infer.exe',
        mkvmerge: 'D:\\工具\\封装\\mkvmerge.exe',
        jasna: 'D:\\新版工具\\jasna.exe',
      },
    }
    expect(
      await store.initializeDefaults(updated, undefined, {
        mdc: 'D:\\工具\\MDC-旧版\\MDC.exe',
        whisper: 'D:\\工具\\语音',
        mkvmerge: 'D:\\工具\\封装',
        jasna: 'D:\\工具\\jasna',
      }),
    ).toBe(true)
    expect((await store.load()).settings).toEqual({
      ...current,
      paths: {
        ...current.paths,
        mdc: updated.paths.mdc,
        whisper: updated.paths.whisper,
        mkvmerge: updated.paths.mkvmerge,
      },
    })
  })
  it('从项目文件初始化并安全保存密码，原项目文件保持不变', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'horse-defaults-'))
    const file = join(directory, 'defaults.json')
    const source = JSON.stringify(fixture())
    await writeFile(file, source)
    const store = new SettingsStore(join(directory, 'user'))
    const credentials = new CredentialStore(join(directory, 'user'), {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value).reverse(),
      decryptString: (value) => Buffer.from(value).reverse().toString(),
    })
    await initializeProjectDefaults(file, store, credentials)
    expect(await credentials.hasPassword()).toBe(true)
    expect((await store.load()).settings.subtitle.format).toBe('ass')
    expect(await readFile(file, 'utf8')).toBe(source)
    expect(await readFile(store.filePath, 'utf8')).not.toContain('测试密码')
  })
})
