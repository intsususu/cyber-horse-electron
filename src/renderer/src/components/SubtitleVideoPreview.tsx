import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Play } from 'lucide-react'
import { subtitleStyleSchema, type SubtitleStyle } from '../../../shared/subtitle-style'
import { SubtitlePreviewPlayer } from './SubtitlePreviewPlayer'

export function SubtitleVideoPreview({
  style,
  children,
  target,
  onOpenChange,
}: {
  style: SubtitleStyle
  children: ReactNode
  target: HTMLElement | null
  onOpenChange: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const active = useRef<{ id: string; url: string; cancelled: boolean } | null>(null)
  const pending = useRef(false)

  const dispose = () => {
    const session = active.current
    active.current = null
    if (!session) return
    session.cancelled = true
    if (session.url) URL.revokeObjectURL(session.url)
    void window.cyberHorse?.cancelSubtitlePreview?.({ id: session.id }).catch(() => {})
  }
  useEffect(() => () => dispose(), [])

  const close = () => {
    dispose()
    setOpen(false)
    setUrl('')
    onOpenChange(false)
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  const start = async () => {
    if (pending.current) return
    dispose()
    setOpen(true)
    onOpenChange(true)
    setError('')
    setUrl('')
    const parsed = subtitleStyleSchema.strip().safeParse(style)
    if (!parsed.success) {
      setError('请先检查字体、字号、描边和边距设置。')
      return
    }
    if (!window.cyberHorse?.generateSubtitlePreview) {
      setError('视频预览需要新版桌面应用，请重启应用后重试。')
      return
    }
    const session = { id: crypto.randomUUID(), url: '', cancelled: false }
    active.current = session
    pending.current = true
    setBusy(true)
    try {
      const result = await window.cyberHorse.generateSubtitlePreview({
        id: session.id,
        style: parsed.data,
      })
      if (session.cancelled) return
      session.url = URL.createObjectURL(
        new Blob([new Uint8Array(result.bytes)], { type: 'video/mp4' }),
      )
      setUrl(session.url)
    } catch (cause) {
      if (!session.cancelled)
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
            : '字幕预览生成失败，请重试。',
        )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={trigger}
        className="subtitle-preview-stage"
        onClick={() => void start()}
        aria-disabled={busy}
        aria-label="点击预览 15 秒字幕视频"
      >
        <span className="subtitle-preview-prompt">
          <Play size={18} />
          点击预览 · 15 秒
        </span>
        {children}
      </button>
      {open &&
        target &&
        createPortal(
          <SubtitlePreviewPlayer
            url={url}
            loading={busy}
            error={error}
            onError={setError}
            onClose={close}
            onRetry={() => void start()}
          />,
          target,
        )}
    </>
  )
}
