import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { MediaDetail } from '../../../shared/media-library'
import type { VlcBounds, VlcControl, VlcState } from '../../../shared/vlc-player'
import { MediaPlayerControls } from './MediaPlayerControls'

export function VlcMediaPlayer({
  detail,
  sourceId,
  startSeconds,
  onClose,
}: {
  detail: MediaDetail
  sourceId: string
  startSeconds: number
  onClose: () => void
}) {
  const panel = useRef<HTMLElement>(null)
  const videoArea = useRef<HTMLDivElement>(null)
  const token = useRef<string | null>(null)
  const stateRef = useRef<VlcState | null>(null)
  const [state, setState] = useState<VlcState | null>(null)
  const [error, setError] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const close = useRef(onClose)
  close.current = onClose
  const closingFullscreen = useRef(false)
  const wasFullscreen = useRef(false)
  const pendingSeek = useRef<{ seconds: number; expires: number } | null>(null)
  const readBounds = useCallback((): VlcBounds => {
    const rect = videoArea.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0, width: 0, height: 0, visible: false }
    const menu = panel.current?.querySelector('[role="listbox"]')?.getBoundingClientRect()
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).some(
      (element) => element.getBoundingClientRect().height > 0,
    )
    const bottom = Math.min(rect.bottom, menu?.top ?? rect.bottom, window.innerHeight)
    const x = Math.max(0, rect.x),
      y = Math.max(0, rect.y)
    return {
      x,
      y,
      width: Math.max(0, Math.min(rect.right, window.innerWidth) - x),
      height: Math.max(0, bottom - y),
      visible:
        !dialog &&
        !panel.current?.querySelector('.media-player-message') &&
        stateRef.current?.status !== 'failed',
    }
  }, [])
  const control = useCallback(
    (
      command:
        | Omit<Extract<VlcControl, { action: 'bounds' }>, 'token'>
        | Omit<Extract<VlcControl, { action: 'pause' }>, 'token'>
        | Omit<Extract<VlcControl, { action: 'seek' }>, 'token'>
        | Omit<Extract<VlcControl, { action: 'audio' }>, 'token'>
        | Omit<Extract<VlcControl, { action: 'subtitle' }>, 'token'>,
    ) => {
      const current = token.current
      if (!current) return
      void window.cyberHorse?.controlVlcPlayback({ ...command, token: current }).catch(() => {
        if (token.current === current) setError('VLC 无法执行播放操作，请重新打开视频。')
      })
    },
    [],
  )
  const seek = (seconds: number) => {
    const duration = stateRef.current?.duration
    const position = Math.max(0, Math.min(duration ?? seconds, seconds))
    control({ action: 'seek', seconds: position })
    pendingSeek.current = { seconds: position, expires: Date.now() + 2000 }
    if (stateRef.current) {
      stateRef.current = { ...stateRef.current, position }
      setState(stateRef.current)
    }
  }
  const togglePause = () =>
    control({ action: 'pause', paused: stateRef.current?.status !== 'paused' })
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        closingFullscreen.current = true
        await document.exitFullscreen()
        closingFullscreen.current = false
      } else await panel.current?.requestFullscreen()
    } catch {
      setError('无法切换全屏，请重试。')
    }
  }

  useEffect(() => {
    const api = window.cyberHorse
    const requestId = crypto.randomUUID()
    token.current = requestId
    let active = true
    let timer: number | undefined
    let lastBounds = ''
    setError('')
    setState(null)
    stateRef.current = null
    pendingSeek.current = null
    const apply = (next: VlcState) => {
      const pending = pendingSeek.current
      if (pending && Date.now() < pending.expires && Math.abs(next.position - pending.seconds) > 1)
        next = { ...next, position: pending.seconds }
      else pendingSeek.current = null
      stateRef.current = next
      setState(next)
    }
    const updateBounds = () => {
      if (!active || !stateRef.current || stateRef.current.status === 'failed') return
      const bounds = readBounds()
      const serialized = JSON.stringify(bounds)
      if (serialized === lastBounds) return
      lastBounds = serialized
      control({ action: 'bounds', bounds })
    }
    const observer = new ResizeObserver(updateBounds)
    if (videoArea.current) observer.observe(videoArea.current)
    const mutations = new MutationObserver(updateBounds)
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-open', 'class', 'style', 'hidden'],
    })
    const poll = async () => {
      try {
        const next = await api?.getVlcPlayback(requestId)
        if (!active) return
        if (!next) {
          setError('VLC 播放会话已结束，请重新打开视频。')
          return
        }
        apply(next)
        updateBounds()
        if (next.status === 'failed') return
        timer = window.setTimeout(() => void poll(), 250)
      } catch {
        if (active) setError('无法读取 VLC 播放状态，请重新打开视频。')
      }
    }
    if (!api?.openVlcPlayback) setError('桌面后台尚未更新，请完整退出后重新启动应用。')
    else
      void api
        .openVlcPlayback({ requestId, id: detail.id, sourceId, startSeconds, bounds: readBounds() })
        .then((next) => {
          if (!active) return
          if (!next) {
            setError('VLC 播放准备已取消，请重新打开视频。')
            return
          }
          apply(next)
          updateBounds()
          void poll()
        })
        .catch((reason) => {
          if (active) setError(reason instanceof Error ? reason.message : 'VLC 播放失败。')
        })
    const changed = () => {
      const current = document.fullscreenElement === panel.current
      setFullscreen(current)
      if (wasFullscreen.current && !current && !closingFullscreen.current) close.current()
      wasFullscreen.current = current
      updateBounds()
    }
    panel.current?.focus()
    document.addEventListener('fullscreenchange', changed)
    window.addEventListener('resize', updateBounds)
    return () => {
      active = false
      if (token.current === requestId) token.current = null
      window.clearTimeout(timer)
      observer.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', updateBounds)
      document.removeEventListener('fullscreenchange', changed)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      void api?.closeVlcPlayback?.(requestId).catch(() => {})
    }
  }, [detail.id, sourceId, startSeconds, attempt, control, readBounds])

  const ready =
    state?.status === 'playing' || state?.status === 'paused' || state?.status === 'ended'
  const message = error || state?.message || (!ready ? '正在准备 VLC 播放…' : '')
  return (
    <section
      ref={panel}
      className="media-player media-player-vlc"
      aria-label={`VLC 视频播放器：${detail.name}`}
      tabIndex={0}
      data-vlc-status={state?.status ?? 'loading'}
      data-vlc-token={state?.token}
      data-vlc-width={state?.width ?? 0}
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement
        if (event.key === 'Escape') {
          if (target.closest('.media-player-subtitle-picker[data-open="true"]')) return
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          seek((stateRef.current?.position ?? 0) + (event.key === 'ArrowLeft' ? -15 : 15))
          return
        }
        if (target.closest('.media-player-subtitle-picker, input, select, textarea')) return
        if (event.key === ' ' || (event.key === 'Enter' && !target.closest('button'))) {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === ' ') togglePause()
          else void toggleFullscreen()
        }
      }}
    >
      <header className="media-player-heading media-player-chrome">
        <button className="media-player-button" onClick={onClose} title="退出播放（Esc）">
          <ArrowLeft size={18} />
          返回详情
        </button>
        <strong>{detail.name}</strong>
      </header>
      <div
        ref={videoArea}
        className="vlc-video-surface"
        aria-label="VLC 视频画面"
        tabIndex={0}
        onDoubleClick={() => void toggleFullscreen()}
      />
      {message && (
        <div
          className="media-player-message"
          role={error || state?.status === 'failed' ? 'alert' : 'status'}
        >
          <p>{message}</p>
          {(error || state?.status === 'failed') && (
            <button
              className="media-player-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试播放
            </button>
          )}
        </div>
      )}
      <div className="media-player-controls media-player-chrome">
        <MediaPlayerControls
          ready={!!ready}
          paused={state?.status !== 'playing'}
          fullscreen={fullscreen}
          position={state?.position ?? startSeconds}
          duration={state?.duration ?? null}
          volume={state?.volume ?? 1}
          muted={state?.muted ?? true}
          onTogglePause={togglePause}
          onSeek={(delta) => seek((stateRef.current?.position ?? 0) + delta)}
          onSeekTo={seek}
          onFullscreen={() => void toggleFullscreen()}
          onVolume={(volume) => control({ action: 'audio', volume, muted: volume === 0 })}
          onMute={() =>
            control({ action: 'audio', volume: state?.volume || 1, muted: !state?.muted })
          }
          subtitles={state?.subtitles ?? []}
          subtitleIndex={state?.subtitleIndex ?? null}
          onSubtitle={(index) => control({ action: 'subtitle', index })}
        />
      </div>
    </section>
  )
}
