import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { MediaDetail, MediaPlaybackSession } from '../../../shared/media-library'
import { MediaPlayerControls } from './MediaPlayerControls'

export function MediaPlayer({
  detail,
  sourceId,
  startSeconds,
  startMuted,
  onClose,
}: {
  detail: MediaDetail
  sourceId: string
  startSeconds: number
  startMuted: boolean
  onClose: () => void
}) {
  const [session, setSession] = useState<MediaPlaybackSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(true)
  const [ready, setReady] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [offset, setOffset] = useState(startSeconds)
  const [transcode, setTranscode] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [intro, setIntro] = useState(true)
  const [keyboardZone, setKeyboardZone] = useState<string | null>(null)
  const [position, setPosition] = useState(startSeconds)
  const [duration, setDuration] = useState<number | null>(null)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(startMuted)
  const [subtitleIndex, setSubtitleIndex] = useState<number | null | undefined>(undefined)
  const [subtitleError, setSubtitleError] = useState('')
  const [subtitleText, setSubtitleText] = useState('')
  const [subtitleAttempt, setSubtitleAttempt] = useState(0)
  const keyboardNavigation = useRef(false)
  const video = useRef<HTMLVideoElement>(null)
  const subtitleTrack = useRef<HTMLTrackElement>(null)
  const panel = useRef<HTMLElement>(null)
  const leaveFullscreen = useRef(false)
  const wasFullscreen = useRef(false)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const timer = window.setTimeout(() => setIntro(false), 2000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (video.current) {
      video.current.volume = volume
      video.current.muted = muted
    }
  }, [session, volume, muted])

  useEffect(() => {
    const element = video.current
    return () => {
      element?.pause()
      element?.removeAttribute('src')
      element?.load()
    }
  }, [session])

  useEffect(() => {
    let active = true
    let token: string | undefined
    setLoading(true)
    setReady(false)
    setPosition(offset)
    setDuration(null)
    setError('')
    setSession(null)
    setSubtitleText('')
    setSubtitleError('')
    setSubtitleAttempt(0)
    void window.cyberHorse
      ?.openMediaPlayback({ id: detail.id, sourceId, startSeconds: offset, transcode })
      .then((value) => {
        if (!value) return
        if (!active) {
          void window.cyberHorse?.closeMediaPlayback(value.token).catch(() => {})
          return
        }
        token = value.token
        setSession(value)
        setSubtitleIndex((current) => {
          if (current !== undefined) return current
          const tracks = value.subtitles.filter((track) => track.isText)
          return (
            tracks.find((track) => track.index === value.defaultSubtitleIndex)?.index ??
            tracks.find((track) => /^(zh|chi|zho)/i.test(track.language))?.index ??
            tracks[0]?.index ??
            null
          )
        })
      })
      .catch((error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : '无法开始播放。')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      if (token) void window.cyberHorse?.closeMediaPlayback(token).catch(() => {})
    }
  }, [detail.id, sourceId, offset, transcode, attempt])

  useEffect(() => {
    const element = panel.current
    element?.focus()
    const changed = () => {
      const current = document.fullscreenElement === element
      setFullscreen(current)
      // Chromium 可能先消费全屏中的 Esc，通过全屏事件补齐返回详情行为。
      if (wasFullscreen.current && !current && !leaveFullscreen.current) close.current()
      wasFullscreen.current = current
      leaveFullscreen.current = false
    }
    document.addEventListener('fullscreenchange', changed)
    return () => {
      document.removeEventListener('fullscreenchange', changed)
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {})
    }
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === panel.current) {
        leaveFullscreen.current = true
        await document.exitFullscreen()
      } else await panel.current?.requestFullscreen()
      panel.current?.focus({ preventScroll: true })
    } catch {
      leaveFullscreen.current = false
      setError('无法切换全屏，请重试。')
    }
  }, [])

  const togglePause = () => {
    const element = video.current
    if (!element || !ready) return
    if (element.paused) void element.play().catch(() => setError('播放未能开始，请重试。'))
    else element.pause()
  }

  const seekTo = (seconds: number) => {
    const element = video.current
    if (!element || !ready) return
    const target = Math.max(0, Math.min(duration ?? Infinity, seconds))
    setPosition(target)
    // 转码流通常不支持任意 Range 定位，重新从目标时间点建立播放流。
    if (session && !session.direct) {
      setOffset(target)
    } else {
      element.currentTime = target
    }
  }

  const seek = (delta: number) => {
    const origin = session?.direct === false ? offset : 0
    seekTo(origin + (video.current?.currentTime ?? 0) + delta)
  }

  const updateTimeline = (element: HTMLVideoElement) => {
    const origin = session?.direct === false ? offset : 0
    setPosition(origin + element.currentTime)
    setDuration(Number.isFinite(element.duration) ? origin + element.duration : null)
  }

  const updateSubtitle = () => {
    const element = subtitleTrack.current
    const cues = element?.track.activeCues
    setSubtitleText(
      Array.from(cues ?? [])
        .map((cue) => (cue instanceof VTTCue ? (cue.getCueAsHTML().textContent ?? '') : ''))
        .filter(Boolean)
        .join('\n'),
    )
  }

  const retry = () => {
    const currentTime = video.current?.currentTime ?? 0
    setOffset(session?.direct ? currentTime || offset : offset + currentTime)
    setTranscode(true)
    setAttempt((value) => value + 1)
  }

  const subtitles = session?.subtitles.filter((track) => track.isText) ?? []
  const selectedSubtitle = subtitles.find((track) => track.index === subtitleIndex)
  const subtitleRestartRequired = Boolean(
    session && !session.supportsCrossOrigin && window.location.protocol !== 'horse:',
  )

  const retrySubtitle = () => {
    setSubtitleError('')
    setSubtitleText('')
    setSubtitleAttempt((current) => current + 1)
  }

  useEffect(() => {
    const element = subtitleTrack.current
    if (!element) return
    let retryTimer: number | undefined
    const loaded = () => {
      if (element.readyState !== 2) return
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      setSubtitleError('')
      updateSubtitle()
    }
    const failed = () => {
      if (element.readyState === 2) {
        loaded()
        return
      }
      if (element.readyState !== 3) return
      if (subtitleAttempt === 0) {
        retryTimer = window.setTimeout(retrySubtitle, 500)
        return
      }
      setSubtitleError(`所选字幕加载失败（诊断编号 ${session?.diagnosticId}）。`)
    }
    element.addEventListener('load', loaded)
    element.addEventListener('error', failed)
    element.track.addEventListener('cuechange', updateSubtitle)
    element.track.mode = 'hidden'
    if (element.readyState === 2) loaded()
    else if (element.readyState === 3) failed()
    return () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      element.removeEventListener('load', loaded)
      element.removeEventListener('error', failed)
      element.track.removeEventListener('cuechange', updateSubtitle)
    }
  }, [session?.token, selectedSubtitle?.index, subtitleAttempt])

  return (
    <section
      ref={panel}
      className="media-player"
      aria-label={`视频播放器：${detail.name}`}
      tabIndex={0}
      data-intro={intro}
      data-keyboard-zone={keyboardZone ?? undefined}
      onPointerDownCapture={() => {
        keyboardNavigation.current = false
        setKeyboardZone(null)
      }}
      onFocusCapture={(event) => {
        if (keyboardNavigation.current)
          setKeyboardZone(
            (event.target.closest('[data-control-zone]') as HTMLElement | null)?.dataset
              .controlZone ?? null,
          )
      }}
      onBlurCapture={(event) => {
        const target = event.relatedTarget as HTMLElement | null
        if (!target || !event.currentTarget.contains(target)) setKeyboardZone(null)
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'Tab') keyboardNavigation.current = true
        const target = event.target as HTMLElement
        if (
          target.matches('input[type="range"]') &&
          [
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Home',
            'End',
            'PageUp',
            'PageDown',
          ].includes(event.key)
        ) {
          keyboardNavigation.current = true
          setKeyboardZone('controls')
        }
        if (event.key === 'Escape') {
          // 展开的字幕菜单先处理 Esc，第二次 Esc 才退出播放。
          if (target.closest('.media-player-subtitle-picker[data-open="true"]')) return
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        // 左右键在播放器控件间保持一致，不能被滑块或字幕选择按钮吞掉。
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          if (
            target.closest('input:not([type="range"]), select, textarea, [contenteditable="true"]')
          )
            return
          event.preventDefault()
          event.stopPropagation()
          if (event.repeat) return
          keyboardNavigation.current = true
          setKeyboardZone(target.closest('[data-control-zone="controls"]') ? 'controls' : null)
          seek(event.key === 'ArrowLeft' ? -15 : 15)
          return
        }
        // 字幕选项仍由上下键导航，空格和 Enter 用于选择。
        if (target.closest('.media-player-subtitle-picker')) return
        if (target.closest('input, select, textarea, [contenteditable="true"]')) return
        if (![' ', 'Enter'].includes(event.key)) return
        // Enter 保留按钮本身的键盘激活，播放器画面聚焦时切换全屏。
        if (event.key === 'Enter' && target.closest('button')) return
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        if (event.key === ' ') togglePause()
        else if (event.key === 'Enter') void toggleFullscreen()
      }}
    >
      {session && (
        <video
          key={session.url}
          ref={video}
          className="media-video"
          crossOrigin={session.supportsCrossOrigin ? 'anonymous' : undefined}
          src={session.url}
          disablePictureInPicture
          autoPlay
          muted={muted}
          playsInline
          tabIndex={0}
          aria-label={`播放：${detail.name}`}
          onLoadedMetadata={(event) => {
            if (session.direct) event.currentTarget.currentTime = offset
            updateTimeline(event.currentTarget)
            updateSubtitle()
            setReady(true)
          }}
          onTimeUpdate={(event) => {
            updateTimeline(event.currentTarget)
            updateSubtitle()
          }}
          onSeeked={updateSubtitle}
          onDurationChange={(event) => updateTimeline(event.currentTarget)}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onError={(event) => {
            setReady(false)
            const element = event.currentTarget
            void window.cyberHorse
              ?.reportMediaPlaybackError({
                token: session.token,
                code: element.error?.code ?? 0,
                readyState: element.readyState,
                networkState: element.networkState,
              })
              .catch(() => setError('视频播放失败，诊断日志保存失败。'))
            setError(
              session.direct
                ? `视频无法直接播放。诊断编号 ${session.diagnosticId}，可尝试转码播放。`
                : `视频转码播放失败。诊断编号 ${session.diagnosticId}，请查看播放日志。`,
            )
          }}
          onDoubleClick={() => void toggleFullscreen()}
        >
          {selectedSubtitle && !subtitleRestartRequired && (
            <track
              key={`${session.token}:${selectedSubtitle.index}:${subtitleAttempt}`}
              kind="subtitles"
              ref={subtitleTrack}
              src={`horse://app/media-playback/${session.token}/subtitles/${selectedSubtitle.index}.vtt?attempt=${subtitleAttempt}`}
              srcLang={selectedSubtitle.language || 'und'}
              label={selectedSubtitle.name}
            />
          )}
        </video>
      )}
      <header className="media-player-heading media-player-chrome" data-control-zone="heading">
        <button className="media-player-button" onClick={onClose} title="退出播放（Esc）">
          <ArrowLeft size={17} />
          返回详情
        </button>
        <strong>{detail.name}</strong>
      </header>
      {(loading || error) && (
        <div className="media-player-message" role={error ? 'alert' : 'status'}>
          <p>{loading ? '正在准备播放…' : error}</p>
          {error && (
            <button className="media-player-button" disabled={loading} onClick={retry}>
              {transcode ? '重试播放' : '转码播放'}
            </button>
          )}
        </div>
      )}
      {subtitleText && (
        <div className="media-player-subtitles" aria-label="字幕">
          {subtitleText}
        </div>
      )}
      {selectedSubtitle && subtitleRestartRequired && (
        <div className="media-player-subtitle-error" role="alert">
          <p>字幕功能需要更新后台。请在处理任务结束后完整退出并重新启动应用。</p>
        </div>
      )}
      {subtitleError && !subtitleRestartRequired && (
        <div className="media-player-subtitle-error" role="alert">
          <p>{subtitleError}</p>
          <button className="media-player-button" onClick={retrySubtitle}>
            重试字幕
          </button>
        </div>
      )}
      <div className="media-player-controls media-player-chrome" data-control-zone="controls">
        <MediaPlayerControls
          key={session?.token ?? 'preparing'}
          ready={ready}
          paused={paused}
          fullscreen={fullscreen}
          position={position}
          duration={duration}
          volume={volume}
          muted={muted}
          onTogglePause={togglePause}
          onSeek={seek}
          onSeekTo={seekTo}
          onFullscreen={() => void toggleFullscreen()}
          onVolume={(value) => {
            setVolume(value)
            setMuted(false)
          }}
          onMute={() => {
            if (muted || volume === 0) {
              setMuted(false)
              if (volume === 0) setVolume(1)
            } else setMuted(true)
          }}
          subtitles={subtitles}
          subtitleIndex={selectedSubtitle?.index ?? null}
          onSubtitle={(index) => {
            setSubtitleError('')
            setSubtitleText('')
            setSubtitleAttempt(0)
            setSubtitleIndex(index)
          }}
        />
      </div>
    </section>
  )
}
