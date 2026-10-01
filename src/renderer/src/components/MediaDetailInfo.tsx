import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  Download,
  Heart,
  MonitorPlay,
  Globe,
  MoreHorizontal,
  Subtitles,
  Trash2,
  WandSparkles,
} from 'lucide-react'
import type {
  MediaDetail,
  MediaLinkTarget,
  MediaQuery,
  MediaSource,
} from '../../../shared/media-library'
import { mediaCatalogNumber } from '../../../shared/media-links'
import { Select } from './Select'

export function MediaDetailInfo({
  detail,
  source,
  disabled,
  processing,
  processError,
  interactive,
  javbusConfigured,
  onOpenLink,
  onSourceChange,
  onFavorite,
  onDownload,
  onProcess,
  onRemove,
  onFilter,
}: {
  detail: MediaDetail
  source: MediaSource | undefined
  disabled: boolean
  processing: boolean
  processError: string
  interactive: boolean
  javbusConfigured: boolean
  onOpenLink: (target: MediaLinkTarget) => void
  onSourceChange: (id: string) => void
  onFavorite: () => void
  onDownload: (id: string) => void
  onProcess: (kind: 'subtitle' | 'video') => void
  onRemove: () => void
  onFilter: (filter: NonNullable<MediaQuery['filter']>) => void
}) {
  const moreRef = useRef<HTMLDetailsElement>(null)
  const overviewRef = useRef<HTMLParagraphElement>(null)
  const overviewId = useId()
  const [expanded, setExpanded] = useState(false)
  const [hasMoreOverview, setHasMoreOverview] = useState(false)
  const catalogNumber = mediaCatalogNumber(detail)
  const hasOverview = !!detail.overview.trim()
  const formatSize = (item: MediaSource) =>
    item.size === null ? '大小未知' : `${(item.size / 1024 ** 3).toFixed(2)} GiB`

  useLayoutEffect(() => {
    const overview = overviewRef.current
    if (!overview || expanded) return
    const measure = () => setHasMoreOverview(overview.scrollHeight > overview.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(overview)
    return () => observer.disconnect()
  }, [detail.overview, expanded])

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const more = moreRef.current
      if (more && !more.contains(event.target as Node)) more.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  useEffect(() => {
    if (!interactive && moreRef.current) moreRef.current.open = false
  }, [interactive])

  const closeMore = () => {
    if (!moreRef.current) return
    moreRef.current.open = false
    moreRef.current.querySelector('summary')?.focus()
  }

  return (
    <div className="media-detail-info">
      <h2>{detail.name}</h2>
      <dl className="media-facts media-facts-summary">
        <div>
          <dt>年份</dt>
          <dd>{detail.year ?? '未知'}</dd>
        </div>
        <div>
          <dt>时长</dt>
          <dd>{detail.minutes === null ? '未知' : `${detail.minutes} 分钟`}</dd>
        </div>
      </dl>

      <div className="media-detail-actions" role="group" aria-label="媒体操作">
        <button
          className={`${detail.favorite ? 'primary-button' : 'secondary-button'} media-favorite-action`}
          disabled={disabled}
          aria-label={detail.favorite ? '取消收藏' : '收藏'}
          aria-pressed={detail.favorite}
          onClick={onFavorite}
        >
          <Heart size={18} fill={detail.favorite ? 'currentColor' : 'none'} />
          {detail.favorite ? '已收藏' : '收藏'}
        </button>
        <details
          ref={moreRef}
          className="media-more-actions"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              event.currentTarget.open = false
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !event.currentTarget.open) return
            event.preventDefault()
            event.stopPropagation()
            closeMore()
          }}
        >
          <summary>
            <MoreHorizontal size={18} />
            更多操作
          </summary>
          <div className="media-more-panel" role="group" aria-label="更多媒体操作">
            {detail.sources.length > 1 && source && (
              <label className="media-source-picker">
                选择版本
                <Select
                  label="选择媒体版本"
                  value={source.id}
                  disabled={processing || disabled}
                  onChange={onSourceChange}
                  options={detail.sources.map((item, index) => ({
                    value: item.id,
                    label: `版本 ${index + 1} · ${formatSize(item)}`,
                  }))}
                />
              </label>
            )}
            {source && (
              <button
                disabled={disabled || !detail.canDownload}
                title={detail.canDownload ? '下载所选版本到已配置目录' : '账号未获得下载权限'}
                onClick={() => {
                  closeMore()
                  onDownload(source.id)
                }}
              >
                <Download size={17} />
                下载
              </button>
            )}
            {source && (
              <>
                <button
                  disabled={processing || disabled || !detail.canDownload}
                  onClick={() => {
                    closeMore()
                    onProcess('subtitle')
                  }}
                >
                  <Subtitles size={17} />
                  添加中文字幕
                </button>
                <button
                  disabled={processing || disabled || !detail.canDownload}
                  onClick={() => {
                    closeMore()
                    onProcess('video')
                  }}
                >
                  <WandSparkles size={17} />
                  视频破解
                </button>
              </>
            )}
            <button
              className="media-delete"
              disabled={disabled || !detail.canDelete}
              title={detail.canDelete ? '删除服务器媒体，需确认' : '账号未获得删除权限'}
              onClick={() => {
                closeMore()
                onRemove()
              }}
            >
              <Trash2 size={17} />
              删除媒体
            </button>
          </div>
        </details>
        <button
          className="icon-button media-link-action"
          disabled={disabled}
          aria-label="打开 Emby 视频详情"
          title="在浏览器中打开 Emby 视频详情"
          onClick={() => onOpenLink('emby')}
        >
          <MonitorPlay size={20} aria-hidden="true" />
        </button>
        {javbusConfigured && (
          <button
            className="icon-button media-link-action"
            disabled={disabled || !catalogNumber}
            aria-label="打开 JavBus 详情"
            title={catalogNumber ? `在 JavBus 查看 ${catalogNumber}` : '无法识别此视频的唯一番号'}
            onClick={() => onOpenLink('javbus')}
          >
            <Globe size={20} aria-hidden="true" />
          </button>
        )}
      </div>

      {hasOverview && (
        <div className="media-overview-block">
          <p
            ref={overviewRef}
            id={overviewId}
            className={`media-overview ${expanded ? 'is-expanded' : ''}`}
            aria-label="视频简介"
          >
            {detail.overview}
          </p>
          {hasMoreOverview && (
            <button
              className="text-button media-overview-toggle"
              aria-expanded={expanded}
              aria-controls={overviewId}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '收起简介' : '展开简介'}
            </button>
          )}
        </div>
      )}

      {source && (
        <dl className="media-facts media-file-size">
          <div>
            <dt>文件大小</dt>
            <dd>{formatSize(source)}</dd>
          </div>
        </dl>
      )}

      <section className="media-info-section" aria-label="影片信息">
        <h3>影片信息</h3>
        <div className="media-info-content">
          <dl className="media-facts">
            <div>
              <dt>入库</dt>
              <dd>
                {detail.created ? new Date(detail.created).toLocaleDateString('zh-CN') : '未知'}
              </dd>
            </div>
            <div>
              <dt>制作</dt>
              <dd>{detail.studios.map((item) => item.name).join('、') || '暂无'}</dd>
            </div>
          </dl>
          <div className="media-metadata">
            <span className="media-metadata-label">类型</span>
            <div className="media-tags">
              {detail.genres.length ? (
                detail.genres.map((genre, index) => (
                  <button
                    className="media-tag"
                    key={index}
                    disabled={disabled}
                    onClick={() => onFilter({ ...genre, kind: 'genre' })}
                  >
                    {genre.name}
                  </button>
                ))
              ) : (
                <span className="media-section-empty">暂无</span>
              )}
            </div>
          </div>
          <div className="media-metadata">
            <span className="media-metadata-label">演职人员</span>
            <div className="media-people">
              {detail.people.length ? (
                detail.people.map((person, index) => (
                  <button
                    className="media-person"
                    key={index}
                    disabled={disabled}
                    onClick={() => onFilter({ id: person.id, name: person.name, kind: 'person' })}
                  >
                    {person.name}
                    {person.role ? ` · ${person.role}` : ''}
                  </button>
                ))
              ) : (
                <span className="media-section-empty">暂无</span>
              )}
            </div>
          </div>
        </div>
      </section>
      {processing && (
        <p className="media-action-status" role="status">
          正在定位 NAS 原视频并检查处理工具…
        </p>
      )}
      {processError && (
        <p className="media-action-status" role="alert">
          {processError}
        </p>
      )}
    </div>
  )
}
