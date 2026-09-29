import { useRef, useState, type CSSProperties } from 'react'
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { MediaSubtitle } from '../../../shared/media-library'
import { MediaSubtitlePicker } from './MediaSubtitlePicker'

function time(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '--:--'
  const total = Math.max(0, Math.floor(value))
  const hours = Math.floor(total / 3600)
  return [hours || null, Math.floor((total % 3600) / 60), total % 60]
    .filter((part) => part !== null)
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
    .join(':')
}

function progress(value: number, total: number): CSSProperties {
  return {
    '--player-progress': `${total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0}%`,
  } as CSSProperties
}

export function MediaPlayerControls({
  ready,
  paused,
  fullscreen,
  position,
  duration,
  volume,
  muted,
  onTogglePause,
  onSeek,
  onSeekTo,
  onFullscreen,
  onVolume,
  onMute,
  subtitles,
  subtitleIndex,
  subtitleLoaded,
  subtitleRetrying,
  firstSubtitleAt,
  subtitleError,
  subtitleRestartRequired,
  onSubtitle,
}: {
  ready: boolean
  paused: boolean
  fullscreen: boolean
  position: number
  duration: number | null
  volume: number
  muted: boolean
  onTogglePause: () => void
  onSeek: (delta: number) => void
  onSeekTo: (seconds: number) => void
  onFullscreen: () => void
  onVolume: (value: number) => void
  onMute: () => void
  subtitles: MediaSubtitle[]
  subtitleIndex: number | null
  subtitleLoaded: boolean
  subtitleRetrying: boolean
  firstSubtitleAt: number | null
  subtitleError: string
  subtitleRestartRequired: boolean
  onSubtitle: (index: number | null) => void
}) {
  const [preview, setPreview] = useState<number | null>(null)
  const pending = useRef<number | null>(null)
  const shownTime = preview ?? position
  const subtitleHint =
    subtitleIndex === null
      ? ''
      : subtitleRestartRequired
        ? '字幕需重启应用'
        : subtitleError
          ? '字幕加载失败'
          : subtitleRetrying
            ? '正在重试字幕…'
            : !subtitleLoaded
              ? '正在加载字幕…'
              : firstSubtitleAt === null
                ? '字幕轨没有内容'
                : position < firstSubtitleAt
                  ? `首条字幕 ${time(firstSubtitleAt)}`
                  : ''
  const commit = () => {
    const value = pending.current
    pending.current = null
    setPreview(null)
    if (value !== null) onSeekTo(value)
  }
  return (
    <>
      <input
        className="media-player-range media-player-timeline"
        type="range"
        min={0}
        max={duration ?? 0}
        step={1}
        value={Math.min(duration ?? 0, shownTime)}
        disabled={!ready || !duration}
        aria-label="播放进度"
        aria-valuetext={`${time(shownTime)} / ${time(duration)}`}
        style={progress(shownTime, duration ?? 0)}
        onChange={(event) => {
          const value = Number(event.target.value)
          pending.current = value
          setPreview(value)
        }}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerUp={commit}
        onPointerCancel={() => {
          pending.current = null
          setPreview(null)
        }}
        onKeyUp={(event) => {
          if (
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
          )
            commit()
        }}
        onBlur={commit}
      />
      <div className="media-player-buttons" role="group" aria-label="播放控制">
        <button
          className="media-player-button media-player-icon"
          disabled={!ready}
          onClick={onTogglePause}
          aria-label={paused ? '继续播放' : '暂停播放'}
          title="暂停或继续（Space）"
        >
          {paused ? (
            <Play size={20} fill="currentColor" />
          ) : (
            <Pause size={20} fill="currentColor" />
          )}
        </button>
        <button
          className="media-player-button media-player-skip"
          disabled={!ready}
          onClick={() => onSeek(-15)}
          aria-label="后退 15 秒"
          title="后退 15 秒（←）"
        >
          <RotateCcw size={19} />
          <span aria-hidden="true">15</span>
        </button>
        <button
          className="media-player-button media-player-skip"
          disabled={!ready}
          onClick={() => onSeek(15)}
          aria-label="快进 15 秒"
          title="快进 15 秒（→）"
        >
          <RotateCw size={19} />
          <span aria-hidden="true">15</span>
        </button>
        <span className="media-player-time" aria-hidden="true">
          {time(shownTime)} <span>/ {time(duration)}</span>
        </span>
        <div className="media-player-audio">
          <button
            className="media-player-button media-player-icon"
            onClick={onMute}
            aria-label={muted || volume === 0 ? '取消静音' : '静音'}
            title={muted || volume === 0 ? '取消静音' : '静音'}
          >
            {muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </button>
          <input
            className="media-player-range media-player-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            style={progress(muted ? 0 : volume, 1)}
            aria-label="音量"
            aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
            onChange={(event) => onVolume(Number(event.target.value))}
          />
        </div>
        <MediaSubtitlePicker subtitles={subtitles} value={subtitleIndex} onChange={onSubtitle} />
        {subtitleHint && (
          <span className="media-player-subtitle-hint" role="status" title={subtitleHint}>
            {subtitleHint}
          </span>
        )}
        <button
          className="media-player-button media-player-icon"
          onClick={onFullscreen}
          aria-label={fullscreen ? '退出全屏' : '全屏'}
          title="切换全屏（Enter）"
        >
          {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
        </button>
      </div>
    </>
  )
}
