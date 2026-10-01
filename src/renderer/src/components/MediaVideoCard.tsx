import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Film, Heart, UserRound } from 'lucide-react'
import type { LibraryVideo, MediaImageRequest } from '../../../shared/media-library'

export function Cover({
  id,
  visible,
  thumb = false,
  revision,
  preview = false,
  avatar = false,
  lazy = false,
}: {
  id: string
  visible: boolean
  thumb?: boolean
  revision: string
  preview?: boolean
  avatar?: boolean
  lazy?: boolean
}) {
  const element = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(!lazy)
  const [image, setImage] = useState<{ key: string; data: string | null } | null>(null)
  const [error, setError] = useState('')
  const kind: MediaImageRequest['kind'] = visible
    ? thumb
      ? 'Thumb'
      : 'Primary'
    : thumb
      ? 'privacyThumb'
      : 'privacyPoster'
  const key = `${id}:${kind}:${revision}`
  useEffect(() => {
    if (!lazy || inView || !element.current) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin: '120px' },
    )
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [lazy, inView])
  useEffect(() => {
    if (preview || !inView || (avatar && !visible)) return
    let active = true
    setError('')
    void window.cyberHorse
      ?.getMediaImage({ id, kind })
      .then((data) => {
        if (active) setImage({ key, data })
      })
      .catch(() => {
        if (active) setError(avatar ? '头像加载失败' : thumb ? '缩略图加载失败' : '封面加载失败')
      })
    return () => {
      active = false
    }
  }, [key, id, kind, preview, inView, avatar, visible])
  return (
    <div
      ref={element}
      className={`media-cover ${thumb ? 'media-thumb' : ''} ${avatar ? 'media-avatar' : ''}`}
    >
      {image?.key === key && image.data && !(avatar && !visible) ? (
        <img
          src={image.data}
          alt={visible ? (avatar ? '演员头像' : thumb ? '媒体缩略图' : '媒体封面') : '隐私封面'}
          onError={() => setImage({ key, data: null })}
        />
      ) : (
        <>
          {avatar ? <UserRound size={24} /> : <Film size={32} />}
          <span>
            {!visible
              ? avatar
                ? '头像已隐藏'
                : thumb
                  ? '缩略图已隐藏'
                  : '封面已隐藏'
              : error ||
                (avatar ? '暂无头像' : preview ? '示例封面' : thumb ? '暂无缩略图' : '暂无封面')}
          </span>
        </>
      )}
    </div>
  )
}

function splitRelatedName(name: string) {
  const number = /^((?:[A-Z0-9]{2,12}-){1,2}\d{2,8}[A-Z]?)(?=$|[\s:：|｜·—–-])/i.exec(name)?.[1]
  if (!number) return { number: '', title: name }
  return {
    number,
    title: name
      .slice(number.length)
      .replace(/^[\s:：|｜·—–-]+/, '')
      .trim(),
  }
}

export function MediaVideoCard({
  item,
  compact = false,
  visible,
  revision,
  busy = false,
  action = '',
  preview = false,
  onOpen,
  onFavorite,
  onContextMenu,
}: {
  item: LibraryVideo
  compact?: boolean
  visible: boolean
  revision: string
  busy?: boolean
  action?: string
  preview?: boolean
  onOpen: (id: string) => void
  onFavorite?: (item: LibraryVideo) => void
  onContextMenu?: (event: MouseEvent<HTMLElement>, item: LibraryVideo) => void
}) {
  const relatedName = compact ? splitRelatedName(item.name) : null
  return (
    <article
      className={`media-card ${compact ? 'media-card-compact' : ''}`}
      key={item.id}
      onContextMenu={(event) => onContextMenu?.(event, item)}
    >
      <button
        className="media-card-open"
        onClick={() => onOpen(item.id)}
        disabled={busy || !!action}
        aria-label={`查看详情：${item.name}`}
      >
        <Cover
          id={item.id}
          visible={visible}
          thumb={compact}
          revision={revision}
          preview={preview}
        />
        {relatedName ? (
          <>
            {relatedName.number && <strong>{relatedName.number}</strong>}
            {relatedName.title && <span className="media-related-name">{relatedName.title}</span>}
          </>
        ) : (
          <>
            <strong>{item.name}</strong>
            <small>
              {[item.year, item.minutes !== null ? `${item.minutes} 分钟` : '']
                .filter(Boolean)
                .join(' · ') || '暂无年份与时长'}
            </small>
          </>
        )}
      </button>
      <button
        className={`media-heart icon-button ${item.favorite ? 'is-favorite' : ''}`}
        aria-label={`${item.favorite ? '取消收藏' : '收藏'}：${item.name}`}
        aria-pressed={item.favorite}
        disabled={!!action || !onFavorite}
        onClick={() => onFavorite?.(item)}
      >
        <Heart size={18} fill={item.favorite ? 'currentColor' : 'none'} />
      </button>
    </article>
  )
}
