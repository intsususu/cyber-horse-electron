import { describe, expect, it } from 'vitest'
import { verifyMdcMetadata } from '../src/main/services/mdc-metadata'
import {
  markedMediaName,
  mediaIdentity,
  verifyMediaIdentity,
} from '../src/main/services/media-identity'

const expected = { number: 'CLUB-494', chinese: true, restored: true }
describe('MDC 状态与元数据核对', () => {
  it('读取实体与 CDATA 标签，简介文字不冒充标签；不把无码当作破解', () => {
    expect(() =>
      verifyMdcMetadata(
        '<movie><title>甲 &amp; 乙</title><tag><![CDATA[中文字幕]]></tag><genre>破解</genre><num>CLUB-494</num></movie>',
        expected,
      ),
    ).not.toThrow()
    for (const content of [
      '<plot>中文字幕 破解</plot>',
      '<tag>中文字幕</tag><tag>无码</tag>',
      '<actor><tag>中文字幕</tag><tag>破解</tag></actor>',
    ])
      expect(() =>
        verifyMdcMetadata(`<movie><title>测试</title>${content}</movie>`, expected),
      ).toThrow('标签')
  })
  it.each([
    '<movie><title>测试</title><tag></movie>',
    '<movie><title>&unknown;</title></movie>',
    '<!DOCTYPE movie [<!ENTITY x SYSTEM "file:///secret">]><movie><title>&x;</title></movie>',
    '<movie><title>一</title></movie><movie><title>二</title></movie>',
  ])('拒绝无效或危险 XML', (text) => {
    expect(() =>
      verifyMdcMetadata(text, { number: null, chinese: false, restored: false }),
    ).toThrow('元数据内容无效')
  })
  it('视频与 NFO 番号不一致均拒绝发布', () => {
    expect(() => verifyMediaIdentity('CLUB-495-UC.mkv', expected)).toThrow('番号')
    expect(() => verifyMediaIdentity('CLUB-494.mkv', expected)).toThrow('标记')
    expect(() =>
      verifyMdcMetadata(
        '<movie><title>测试</title><tag>中文字幕</tag><tag>破解</tag><num>CLUB-495</num></movie>',
        expected,
      ),
    ).toThrow('番号')
  })
  it('MDC 输入 C/UC 不带防重尾缀，仅 U 使用 hack，不合并分段文件', () => {
    expect(markedMediaName('CLUB-494-UC_1.mkv', expected, true)).toBe('CLUB-494-UC.mkv')
    expect(markedMediaName('CLUB-494-U_1.mkv', { ...expected, chinese: false }, true)).toBe(
      'CLUB-494-hack.mkv',
    )
    const part = mediaIdentity('CLUB-494-CD2-C.mkv')
    expect(part.number).toBeNull()
    expect(markedMediaName('CLUB-494-CD2-C.mkv', part, true)).toBe('CLUB-494-CD2-C.mkv')
  })
})
