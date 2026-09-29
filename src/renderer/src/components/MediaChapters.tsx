import { useEffect, useState } from 'react'
import type { MediaDetail } from '../../../shared/media-library'
import { MediaShelf } from './MediaShelf'

function ChapterImage({ id, index }: { id: string; index: number }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void window.cyberHorse
      ?.getMediaImage({ id, kind: 'Chapter', index })
      .then((value) => {
        if (active) setImage(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [id, index])
  return image ? <img src={image} alt="" loading="lazy" /> : <span>暂无预览图</span>
}

function time(seconds: number) {
  const total = Math.floor(seconds)
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

export function MediaChapters({
  detail,
  visible,
  disabled,
  onPlay,
}: {
  detail: MediaDetail
  visible: boolean
  disabled: boolean
  onPlay: (seconds: number) => void
}) {
  return (
    <MediaShelf
      title="章节"
      label="视频章节"
      className="media-chapter-section"
      listClassName="media-chapters"
      count={detail.chapters.length}
    >
      {detail.chapters.length ? (
        <>
          {detail.chapters.map((item) => (
            <button
              key={item.index}
              className="media-chapter"
              aria-label={`播放${item.name}，从 ${time(item.startSeconds)} 开始`}
              disabled={disabled}
              onClick={() => onPlay(item.startSeconds)}
            >
              <span className="media-chapter-image">
                {visible && item.hasImage ? (
                  <ChapterImage
                    key={`${detail.id}:${item.index}`}
                    id={detail.id}
                    index={item.index}
                  />
                ) : (
                  <span>{visible ? '暂无预览图' : '预览已隐藏'}</span>
                )}
              </span>
              <span className="media-chapter-caption">{time(item.startSeconds)}</span>
            </button>
          ))}
        </>
      ) : (
        <p className="media-section-empty">服务器未返回章节信息。</p>
      )}
    </MediaShelf>
  )
}
