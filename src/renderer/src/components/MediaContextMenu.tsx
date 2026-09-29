import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Heart, Subtitles, Trash2, WandSparkles } from 'lucide-react'
import type { LibraryVideo, MediaDetail } from '../../../shared/media-library'

export type MediaContextState = {
  item: LibraryVideo
  detail: MediaDetail | null
  loading: boolean
  error: string
  sourceId: string
  x: number
  y: number
  request: number
}

export function MediaContextMenu({
  menu,
  disabled,
  processing,
  onSourceChange,
  onProcess,
  onDownload,
  onFavorite,
  onRemove,
  onClose,
}: {
  menu: MediaContextState
  disabled: boolean
  processing: boolean
  onSourceChange: (sourceId: string) => void
  onProcess: (kind: 'subtitle' | 'video') => void
  onDownload: () => void
  onFavorite: () => void
  onRemove: () => void
  onClose: (restoreFocus: boolean) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: menu.x, top: menu.y })
  const source = menu.detail?.sources.find((item) => item.id === menu.sourceId)
  const canProcess =
    !disabled && !processing && (!menu.detail || (!!source && menu.detail.canDownload))
  const canDownload = !!source && !!menu.detail?.canDownload && !disabled && !processing
  const favorite = menu.detail?.favorite ?? menu.item.favorite
  const unavailable = menu.loading
    ? '正在读取媒体信息'
    : menu.error
      ? '媒体信息读取失败'
      : !source
        ? '没有可用的媒体版本'
        : !menu.detail?.canDownload
          ? '账号未获得下载权限'
          : ''

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const margin = 8
    setPosition({
      left: Math.max(margin, Math.min(menu.x, window.innerWidth - panel.offsetWidth - margin)),
      top: Math.max(margin, Math.min(menu.y, window.innerHeight - panel.offsetHeight - margin)),
    })
  }, [menu.x, menu.y, menu.loading, menu.detail, menu.error])

  useLayoutEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose(false)
    }
    const closeOnResize = () => onClose(false)
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', closeOnResize)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', closeOnResize)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={panelRef}
      className="media-context-menu"
      role="dialog"
      aria-label={`快捷操作：${menu.item.name}`}
      tabIndex={-1}
      style={position}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose(true)
      }}
    >
      <div className="media-context-heading">
        <span>快捷操作</span>
        <strong title={menu.item.name}>{menu.item.name}</strong>
      </div>
      {menu.detail && menu.detail.sources.length > 1 && (
        <label className="media-context-source">
          媒体版本
          <select
            aria-label="快捷操作使用的媒体版本"
            value={menu.sourceId}
            disabled={disabled || processing}
            onChange={(event) => onSourceChange(event.target.value)}
          >
            {menu.detail.sources.map((item, index) => (
              <option key={item.id} value={item.id}>
                版本 {index + 1}
                {item.size === null ? '' : ` · ${(item.size / 1024 ** 3).toFixed(2)} GiB`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="media-context-actions">
        <button
          disabled={!canProcess}
          title={menu.detail ? unavailable : '加入队列后检查媒体信息'}
          onClick={() => onProcess('subtitle')}
        >
          <Subtitles size={17} aria-hidden="true" />
          中文字幕
        </button>
        <button
          disabled={!canProcess}
          title={menu.detail ? unavailable : '加入队列后检查媒体信息'}
          onClick={() => onProcess('video')}
        >
          <WandSparkles size={17} aria-hidden="true" />
          视频破解
        </button>
        <button disabled={!canDownload} title={unavailable} onClick={onDownload}>
          <Download size={17} aria-hidden="true" />
          下载
        </button>
        <span className="media-context-divider" aria-hidden="true" />
        <button
          className={favorite ? 'is-favorite' : ''}
          disabled={disabled || processing}
          onClick={onFavorite}
        >
          <Heart size={17} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
          {favorite ? '取消关注' : '关注'}
        </button>
        <span className="media-context-divider" aria-hidden="true" />
        <button
          className="is-danger"
          disabled={disabled || processing || !menu.detail?.canDelete}
          title={
            menu.loading
              ? '正在读取媒体信息'
              : !menu.detail
                ? '媒体信息读取失败'
                : menu.detail.canDelete
                  ? '从 Emby 删除媒体，需再次确认'
                  : '账号未获得删除权限'
          }
          onClick={onRemove}
        >
          <Trash2 size={17} aria-hidden="true" />
          删除媒体
        </button>
      </div>
      {menu.loading && <p className="media-context-status">正在读取媒体信息…</p>}
      {menu.error && (
        <p className="media-context-status" role="alert">
          {menu.error}
        </p>
      )}
    </div>,
    document.body,
  )
}
