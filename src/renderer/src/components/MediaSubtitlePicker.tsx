import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Captions, Check, ChevronDown } from 'lucide-react'
import type { MediaSubtitle } from '../../../shared/media-library'

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
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const options = useRef<Array<HTMLButtonElement | null>>([])
  const id = useId()
  const items = [
    { index: null, label: '字幕关闭', detail: '' },
    ...subtitles.map((track) => ({
      index: track.index,
      label: subtitleLabel(track),
      detail: track.name,
    })),
  ]
  const selected = Math.max(
    0,
    items.findIndex((item) => item.index === value),
  )
  const disabled = subtitles.length === 0
  const label = disabled ? '无独立字幕轨' : items[selected]!.label

  useLayoutEffect(() => {
    if (open) options.current[selected]?.focus()
  }, [open, selected])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [open])

  return (
    <div
      ref={root}
      className="media-player-subtitle-picker"
      data-open={open}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="media-player-button media-player-subtitle-trigger"
        aria-label="选择字幕"
        aria-description={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        title={
          disabled
            ? '服务器未提供独立文字字幕轨；压在视频画面里的字幕无法单独切换或关闭'
            : items[selected]!.detail || label
        }
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', ' '].includes(event.key)) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Captions size={18} aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div id={id} role="listbox" aria-label="字幕轨道" className="media-player-subtitle-menu">
          {items.map((item, index) => (
            <button
              key={item.index ?? 'off'}
              type="button"
              role="option"
              aria-selected={index === selected}
              tabIndex={-1}
              title={item.detail || item.label}
              ref={(node) => {
                options.current[index] = node
              }}
              onClick={() => {
                setOpen(false)
                trigger.current?.focus()
                onChange(item.index)
              }}
              onKeyDown={(event) => {
                let next = index
                if (event.key === 'ArrowDown') next = (index + 1) % items.length
                else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
                else if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = items.length - 1
                else return
                event.preventDefault()
                options.current[next]?.focus()
              }}
            >
              <span>
                <span>{item.label}</span>
                {item.detail && item.detail !== item.label && <small>{item.detail}</small>}
              </span>
              {index === selected && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
