import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings, settingsSchema } from '../src/shared/contracts'
import { defaultSubtitleStyle } from '../src/shared/subtitle-style'
import { SettingsStore } from '../src/main/services/settings-store'
import { parseSrt, srtToAss } from '../src/main/services/subtitles'
import { reconcileSettingsDraft } from '../src/renderer/src/lib/settings-draft'

describe('字幕字体配置', () => {
  it('旧版字幕配置补齐原有 ASS 样式，自定义样式跨实例保存恢复', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-subtitle-'))
    const file = join(folder, 'settings.json')
    await writeFile(file, JSON.stringify({ ...defaultSettings, subtitle: { format: 'ass' } }))
    const settings = (await new SettingsStore(folder).load()).settings
    expect(settings.subtitle).toEqual({ format: 'ass', ...defaultSubtitleStyle })
    settings.subtitle.fontName = '自定义中文字体'
    settings.subtitle.fontSize = 64
    settings.subtitle.color = '#12ABEF'
    await new SettingsStore(folder).save(settings)
    expect((await new SettingsStore(folder).load()).settings).toEqual(settings)
    expect(JSON.parse(await readFile(file, 'utf8')).subtitle).toEqual(settings.subtitle)
  })

  it.each([
    { fontName: '' },
    { fontName: '字体,注入' },
    { fontName: '字体\n[Events]' },
    { fontName: '字体\u0000' },
    { fontName: '字体\\控制' },
    { fontSize: 15 },
    { fontSize: 121 },
    { fontSize: 24.5 },
    { color: 'red' },
    { outlineWidth: -1 },
    { shadow: 9 },
    { marginBottom: 201 },
    { bold: '是' },
  ])('拒绝无效字幕配置：%j', (patch) => {
    expect(
      settingsSchema.safeParse({
        ...defaultSettings,
        subtitle: { ...defaultSettings.subtitle, ...patch },
      }).success,
    ).toBe(false)
  })

  it('外部只改字体时保留其他样式草稿；主题更新不丢失字体设置', () => {
    const draft = structuredClone(defaultSettings)
    draft.subtitle.fontSize = 72
    draft.subtitle.color = '#F0E0D0'
    const next = structuredClone(defaultSettings)
    next.theme = 'light'
    next.subtitle.fontName = 'SimSun'
    expect(reconcileSettingsDraft(draft, defaultSettings, next).subtitle).toEqual({
      ...draft.subtitle,
      fontName: 'SimSun',
    })
  })

  it('ASS 写入自定义样式与 BGR 颜色，时间轴和中文内容保持正确', () => {
    const cues = parseSrt(Buffer.from('1\n00:00:01,000 --> 00:00:03,000\n中文{测试}\\内容\n'))
    const ass = srtToAss(cues, {
      ...defaultSubtitleStyle,
      fontName: 'SimSun',
      fontSize: 64,
      color: '#12ABEF',
      outlineColor: '#123456',
      bold: false,
      italic: true,
      outlineWidth: 2,
      shadow: 0,
      marginBottom: 90,
    })
    expect(ass).toContain(
      'Style: Default,SimSun,64,&H00EFAB12,&H000000FF,&H00563412,&H80000000,0,-1,0,0,100,100,0,0,1,2,0,2,40,40,90,1',
    )
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,中文｛测试｝＼内容')
    expect(() => srtToAss(cues, { ...defaultSubtitleStyle, fontName: '错误,字体' })).toThrow()
  })
})
