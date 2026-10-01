import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { MediaPlayerControls } from './MediaPlayerControls'

export function SubtitlePreviewPlayer({
  url,
  loading,
  error,
  onError,
  onClose,
  onRetry,
}: {
  url: string
  loading: boolean
  error: string
  onError: (message: string) => void
  onClose: () => void
  onRetry: () => void
}) {
  const panel = useRef<HTMLElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const [paused, setPaused] = useState(true)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [intro, setIntro] = useState(true)
  const leaveFullscreen = useRef(false)
  const wasFullscreen = useRef(false)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const element = panel.current
    element?.focus({ preventScroll: true })
    const changed = () => {
      const next = document.fullscreenElement === element
      setFullscreen(next)
      if (wasFullscreen.current && !next && !leaveFullscreen.current) close.current()
      wasFullscreen.current = next
      leaveFullscreen.current = false
    }
    document.addEventListener('fullscreenchange', changed)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {})
    }
  }, [])
  useEffect(() => {
    setReady(false)
    setPosition(0)
    setDuration(null)
    setIntro(true)
    const timer = window.setTimeout(() => setIntro(false), 2000)
    const element = video.current
    return () => {
      window.clearTimeout(timer)
      element?.pause()
      element?.removeAttribute('src')
      element?.load()
    }
  }, [url])
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === panel.current) {
        leaveFullscreen.current = true
        await document.exitFullscreen()
      } else await panel.current?.requestFullscreen()
      panel.current?.focus({ preventScroll: true })
    } catch {
      onError('无法切换全屏，请重试。')
    }
  }
  const togglePause = () => {
    const element = video.current
    if (!element || !ready) return
    if (element.paused) {
      if (element.ended) element.currentTime = 0
      void element.play().catch(() => onError('播放未能开始，请重试。'))
    } else element.pause()
  }
  const seekTo = (seconds: number) => {
    if (!video.current || !ready) return
    video.current.currentTime = Math.max(0, Math.min(duration ?? 15, seconds))
  }
  return (
    <section
      ref={panel}
      className="media-player subtitle-preview-player"
      aria-label="字幕预览播放器"
      tabIndex={0}
      data-intro={intro || loading || !!error}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        if ((event.target as HTMLElement).closest('button, input')) return
        if (event.key === ' ') {
          event.preventDefault()
          togglePause()
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          void toggleFullscreen()
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          seekTo(position + (event.key === 'ArrowLeft' ? -15 : 15))
        }
      }}
    >
      {url && (
        <video
          ref={video}
          className="media-video"
          aria-label="15 秒 ASS 字幕预览"
          src={url}
          autoPlay
          muted
          playsInline
          disablePictureInPicture
          onLoadedMetadata={(event) => {
            setDuration(event.currentTarget.duration)
            setReady(true)
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onEnded={() => setPaused(true)}
          onError={() => {
            setReady(false)
            onError('视频无法播放，请重新生成预览。')
          }}
          onDoubleClick={() => void toggleFullscreen()}
        />
      )}
      <header className="media-player-heading media-player-chrome">
        <button className="media-player-button" onClick={onClose} title="退出预览（Esc）">
          <ArrowLeft size={17} />
          返回字幕设置
        </button>
        <strong>字幕预览 · 15 秒模拟片段</strong>
      </header>
      {(loading || error) && (
        <div className="media-player-message" role={error ? 'alert' : 'status'}>
          <p>{loading ? '正在生成 15 秒字幕片段…' : error}</p>
          {!loading && (
            <button className="media-player-button" onClick={onRetry}>
              重试
            </button>
          )}
        </div>
      )}
      <div className="media-player-controls media-player-chrome">
        <MediaPlayerControls
          ready={ready}
          paused={paused}
          fullscreen={fullscreen}
          position={position}
          duration={duration}
          volume={0}
          muted
          onTogglePause={togglePause}
          onSeek={(delta) => seekTo(position + delta)}
          onSeekTo={seekTo}
          onFullscreen={() => void toggleFullscreen()}
          onVolume={() => {}}
          onMute={() => {}}
          subtitles={[]}
          subtitleIndex={null}
          onSubtitle={() => {}}
          silentPreview
        />
      </div>
    </section>
  )
}
