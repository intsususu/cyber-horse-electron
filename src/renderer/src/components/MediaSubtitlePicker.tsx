import { Captions } from 'lucide-react'
import type { MediaSubtitle } from '../../../shared/media-library'
import { Select } from './Select'

function subtitleLabel(track: MediaSubtitle) {
  const name = track.name
  if (/^(zh|chi|zho)/i.test(track.language) || /chinese/i.test(name)) {
    if (/simplified|简体|hans|zh-cn/i.test(`${name} ${track.language}`)) return '中文简体'
    if (/traditional|繁体|hant|zh-tw/i.test(`${name} ${track.language}`)) return '中文繁体'
    return /[\u4e00-\u9fff]/.test(name) ? name : '中文'
  }
  if (/^(en|eng)$/i.test(track.language) || /^english/i.test(name)) return '英语'
  if (/^(ja|jpn)$/i.test(track.language) || /^japanese/i.test(name)) return '日语'
  return name
}

export function MediaSubtitlePicker({
  subtitles,
  value,
  onChange,
}: {
  subtitles: MediaSubtitle[]
  value: number | null
  onChange: (value: number | null) => void
}) {
  const disabled = subtitles.length === 0
  const items = [
    { value: 'off', label: disabled ? '无独立字幕轨' : '字幕关闭' },
    ...subtitles.map((track) => ({
      value: String(track.index),
      label: subtitleLabel(track),
      detail: track.name,
    })),
  ]
  return (
    <Select
      className="media-player-subtitle-picker"
      triggerClassName="media-player-subtitle-trigger"
      menuClassName="media-player-subtitle-menu"
      label="选择字幕"
      listLabel="字幕轨道"
      value={value === null ? 'off' : String(value)}
      disabled={disabled}
      title={
        disabled ? '服务器未提供独立文字字幕轨；压在视频画面里的字幕无法单独切换或关闭' : undefined
      }
      icon={<Captions size={18} aria-hidden="true" />}
      menuMinWidth={280}
      boundarySelector=".media-player"
      options={items}
      onChange={(next) => onChange(next === 'off' ? null : Number(next))}
    />
  )
}
