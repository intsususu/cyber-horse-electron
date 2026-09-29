import { describe, expect, it } from 'vitest'
import { defaultSettings, parseStoredSettings } from '../src/shared/contracts'
import {
  embyDetailUrl,
  javbusDetailUrl,
  javbusUrlSchema,
  mediaCatalogNumber,
} from '../src/shared/media-links'
import { mediaLinkSchema } from '../src/shared/media-library'

describe('媒体详情网页链接', () => {
  it('旧配置默认隐藏 JavBus，拒绝危险协议、凭据和任意地址参数', () => {
    const { javbusUrl: _unused, ...legacy } = defaultSettings.mediaServer
    expect(
      parseStoredSettings({ ...defaultSettings, mediaServer: legacy }).mediaServer.javbusUrl,
    ).toBe('')
    for (const address of [
      'file:///C:/secret',
      'javascript:alert(1)',
      'https://u:p@example.com',
      'https://example.com/?token=x',
    ]) {
      expect(javbusUrlSchema.safeParse(address).success).toBe(false)
      expect(() => javbusDetailUrl(address, 'VDD-209')).toThrow()
    }
    expect(
      mediaLinkSchema.safeParse({ id: 'v1', target: 'javbus', url: 'https://example.com' }).success,
    ).toBe(false)
    expect(mediaLinkSchema.safeParse({ id: '../secret', target: 'emby' }).success).toBe(false)
    expect(mediaLinkSchema.safeParse({ id: 'v1', target: 'other' }).success).toBe(false)
  })
  it('接受网站或示例链接，替换最后的番号并保留站点子路径', () => {
    for (const address of [
      'https://www.javbus.com',
      'https://www.javbus.com/',
      'https://www.javbus.com/VDD-209/',
    ])
      expect(javbusDetailUrl(address, 'abc-123')).toBe('https://www.javbus.com/ABC-123')
    expect(javbusDetailUrl('https://example.com/ja/VDD-209', 'ABC-123')).toBe(
      'https://example.com/ja/ABC-123',
    )
    expect(() => javbusDetailUrl('', 'ABC-123')).toThrow('请先配置')
    expect(() => javbusDetailUrl('https://example.com', '../secret')).toThrow('番号')
  })
  it('优先识别标题番号，缺失时使用文件名，歧义时不猜测', () => {
    expect(mediaCatalogNumber({ name: 'VDD-209-U 测试影片', path: '', sources: [] })).toBe(
      'VDD-209',
    )
    expect(
      mediaCatalogNumber({ name: '测试影片', path: '/媒体/ABC-123-UC.mkv', sources: [] }),
    ).toBe('ABC-123')
    expect(mediaCatalogNumber({ name: 'ABC-123 与 DEF-456', path: '', sources: [] })).toBe('')
    expect(
      mediaCatalogNumber({ name: '普通影片', path: '/ABC-123/普通影片.mkv', sources: [] }),
    ).toBe('')
  })
  it('Emby 详情链接保留配置子路径及服务器标识', () => {
    expect(embyDetailUrl('http://localhost:8096', '123', 'server-id')).toBe(
      'http://localhost:8096/web/index.html#!/item?id=123&serverId=server-id',
    )
    expect(embyDetailUrl('https://example.com/media/emby/', '123', '')).toBe(
      'https://example.com/media/emby/web/index.html#!/item?id=123',
    )
  })
})
