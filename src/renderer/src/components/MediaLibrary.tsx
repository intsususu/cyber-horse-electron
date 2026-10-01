import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ArrowLeft, Eye, EyeOff, Film, Heart, Play, RefreshCw, Search } from 'lucide-react'
import type { LibraryVideo } from '../../../shared/media-library'
import type { Workspace } from '../hooks/use-workspace'
import { useMediaLibrary } from '../hooks/use-media-library'
import { MediaPlayer } from './MediaPlayer'
import { MediaLibraryPicker } from './MediaLibraryPicker'
import { MediaChapters } from './MediaChapters'
import { MediaDetailInfo } from './MediaDetailInfo'
import { MediaShelf } from './MediaShelf'
import { MediaContextMenu, type MediaContextState } from './MediaContextMenu'
import { MediaDeleteConfirmation } from './MediaDeleteConfirmation'
import { Cover, MediaVideoCard } from './MediaVideoCard'
import { VlcMediaPlayer } from './VlcMediaPlayer'
import '../styles/media-library.css'

export function MediaLibrary({
  active,
  workspace,
  entryId,
  onExit,
  coverVisible,
}: {
  active: boolean
  workspace: Workspace
  entryId?: string
  onExit?: () => void
  coverVisible?: boolean
}) {
  const library = useMediaLibrary(workspace, active, entryId, coverVisible)
  const entryBack = useRef<HTMLButtonElement>(null)
  const [source, setSource] = useState('')
  const [queueingItems, setQueueingItems] = useState<Set<string>>(() => new Set())
  const queueingRef = useRef(new Set<string>())
  const [processError, setProcessError] = useState('')
  const [contextMenu, setContextMenu] = useState<MediaContextState | null>(null)
  const [searchDraft, setSearchDraft] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const contextRequest = useRef(0)
  const contextTrigger = useRef<HTMLElement | null>(null)
  const deleteTrigger = useRef<HTMLElement | null>(null)
  const restoreDeleteFocus = useRef(false)
  const [playback, setPlayback] = useState<{
    id: string
    sourceId: string
    startSeconds: number
    useVlc: boolean
    startMuted: boolean
  } | null>(null)
  const playTrigger = useRef<HTMLElement | null>(null)
  const { view, busy, action, visible } = library
  useEffect(() => {
    if (!action && !library.deletion && restoreDeleteFocus.current) {
      restoreDeleteFocus.current = false
      deleteTrigger.current?.focus({ preventScroll: true })
    }
  }, [action, library.deletion])
  const listing = view?.kind === 'wall' || view?.kind === 'search' ? view : null
  const searchLibrary = library.libraries.find((item) => item.id === listing?.query.libraryId)
  useEffect(() => {
    if (active && view?.kind === 'search') searchInput.current?.focus({ preventScroll: true })
  }, [active, view?.kind])
  const revision = JSON.stringify([workspace.settings.mediaServer, workspace.settings.privacyCover])
  const detailId = view?.kind === 'detail' ? view.detail.id : ''
  useEffect(() => {
    if (entryId && detailId) entryBack.current?.focus()
  }, [entryId, detailId])
  const selectedSource =
    view?.kind === 'detail'
      ? (view.detail.sources.find((item) => item.id === source) ?? view.detail.sources[0])
      : undefined
  const playing = active && playback?.id === detailId && playback?.sourceId === selectedSource?.id
  const play = (startSeconds = 0) => {
    if (!selectedSource || busy || action) return
    playTrigger.current = document.activeElement as HTMLElement | null
    setPlayback({
      id: detailId,
      sourceId: selectedSource.id,
      startSeconds,
      useVlc: workspace.settings.player.useVlc,
      startMuted: workspace.settings.player.startMuted,
    })
  }
  const closePlayback = () => {
    setPlayback(null)
    requestAnimationFrame(() => playTrigger.current?.focus({ preventScroll: true }))
  }
  useEffect(() => {
    setPlayback(null)
  }, [active, detailId, selectedSource?.id, revision])
  const closeContextMenu = (restoreFocus: boolean) => {
    contextRequest.current++
    setContextMenu(null)
    if (restoreFocus)
      requestAnimationFrame(() => contextTrigger.current?.focus({ preventScroll: true }))
  }
  const openContextMenu = (event: MouseEvent<HTMLElement>, item: LibraryVideo) => {
    event.preventDefault()
    if (!active || busy || action || playing) return
    const trigger = event.currentTarget
    contextTrigger.current =
      trigger instanceof HTMLButtonElement ? trigger : trigger.querySelector('.media-card-open')
    const bounds = trigger.getBoundingClientRect()
    const keyboardPosition = event.clientX === 0 && event.clientY === 0
    const request = ++contextRequest.current
    const detail = view?.kind === 'detail' && view.detail.id === item.id ? view.detail : null
    setContextMenu({
      item,
      detail,
      loading: !detail,
      error: '',
      sourceId: detail?.sources[0]?.id ?? '',
      x: keyboardPosition ? bounds.left + 24 : event.clientX,
      y: keyboardPosition ? bounds.top + 24 : event.clientY,
      request,
    })
    if (detail) return
    void window
      .cyberHorse!.getMediaDetail(item.id)
      .then((result) => {
        if (request !== contextRequest.current) return
        setContextMenu((current) =>
          current?.request === request
            ? { ...current, detail: result, loading: false, sourceId: result.sources[0]?.id ?? '' }
            : current,
        )
      })
      .catch((error) => {
        if (request !== contextRequest.current) return
        setContextMenu((current) =>
          current?.request === request
            ? {
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : '无法读取媒体信息。',
              }
            : current,
        )
      })
  }
  useEffect(() => {
    if (!active || playing) {
      contextRequest.current++
      setContextMenu(null)
    }
  }, [active, playing])
  const enqueueProcess = async (
    kind: 'subtitle' | 'video',
    item: LibraryVideo,
    sourceId?: string,
  ) => {
    if (queueingRef.current.has(item.id)) return
    queueingRef.current.add(item.id)
    setQueueingItems(new Set(queueingRef.current))
    setProcessError('')
    const menuRequest = contextMenu?.item.id === item.id ? contextMenu.request : null
    try {
      const result = await window.cyberHorse!.enqueueMediaProcess({
        id: item.id,
        sourceId,
        kind,
        name: item.name,
      })
      workspace.setToast(
        result.alreadyQueued
          ? '此影片已在任务队列中，请勿重复提交。'
          : '媒体处理任务已加入队列，可继续浏览和操作其他视频。进度请到任务队列查看。',
      )
      if (menuRequest && contextRequest.current === menuRequest) closeContextMenu(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法加入媒体任务队列。'
      if (view?.kind === 'detail' && view.detail.id === item.id) setProcessError(message)
      setContextMenu((current) =>
        current?.item.id === item.id ? { ...current, error: message } : current,
      )
    } finally {
      queueingRef.current.delete(item.id)
      setQueueingItems(new Set(queueingRef.current))
    }
  }
  useEffect(() => setSource(''), [detailId])
  const card = (item: LibraryVideo, compact = false) => (
    <MediaVideoCard
      key={item.id}
      item={item}
      compact={compact}
      visible={visible}
      revision={revision}
      busy={busy}
      action={action}
      onOpen={(id) => void library.openDetail(id)}
      onFavorite={(video) => void library.favorite(video)}
      onContextMenu={openContextMenu}
    />
  )
  return (
    <section
      hidden={!active}
      className={`workspace-body panel media-library ${playing ? 'is-playing' : ''}`}
      aria-label="Emby 媒体库"
    >
      <div className="media-browser" inert={playing}>
        <div className="media-toolbar" aria-label="媒体库浏览工具">
          {(onExit || library.history.length > 0) && (
            <button
              ref={entryBack}
              className="icon-button media-back-button"
              title="返回"
              aria-label="返回"
              disabled={busy || !!action}
              onClick={library.history.length > 0 ? library.back : onExit}
            >
              <ArrowLeft size={17} />
            </button>
          )}
          {library.libraries.length > 0 && view?.kind === 'wall' && (
            <MediaLibraryPicker
              libraries={library.libraries}
              value={view.query.libraryId ?? ''}
              allowAll={!!entryId || !view.query.libraryId}
              disabled={busy || !!action}
              onChange={(id) =>
                void library.loadWall(
                  {
                    libraryId: id || undefined,
                    start: 0,
                    limit: 30,
                    sort: 'DateCreated',
                    favorites: false,
                  },
                  false,
                  !!view,
                )
              }
            />
          )}
          {view?.kind === 'search' && (
            <span className="media-search-scope">
              搜索范围：{searchLibrary?.name ?? '全部媒体库'}
            </span>
          )}
          {view?.kind === 'wall' && view.query.filter && (
            <button
              className="text-button media-active-filter"
              title={'清除筛选：' + view.query.filter.name}
              disabled={busy || !!action}
              onClick={() => void library.loadWall({ ...view.query, filter: undefined, start: 0 })}
            >
              {view.query.filter.kind === 'genre' ? '类型' : '演职人员'}：{view.query.filter.name} ×
            </button>
          )}
          <div className="media-toolbar-actions">
            {view?.kind === 'wall' && (
              <>
                <div className="media-sort" role="group" aria-label="媒体排序">
                  {(
                    [
                      ['DateCreated', '加入日期'],
                      ['DatePlayed', '播放日期'],
                      ['PlayCount', '播放次数'],
                    ] as const
                  ).map(([sort, label]) => (
                    <button
                      key={sort}
                      aria-pressed={view.query.sort === sort}
                      disabled={busy || !!action}
                      onClick={() => void library.loadWall({ ...view.query, sort, start: 0 })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="media-toolbar-divider" aria-hidden="true" />
                <button
                  className="media-favorites"
                  aria-pressed={view.query.favorites}
                  disabled={busy || !!action}
                  onClick={() =>
                    void library.loadWall({
                      ...view.query,
                      start: 0,
                      favorites: !view.query.favorites,
                      filter: undefined,
                    })
                  }
                >
                  <Heart size={16} fill={view.query.favorites ? 'currentColor' : 'none'} />
                  我的收藏
                </button>
                <span className="media-toolbar-divider" aria-hidden="true" />
              </>
            )}
            {library.libraries.length > 0 && view?.kind !== 'search' && (
              <button
                className="icon-button"
                title="搜索当前媒体库"
                aria-label="搜索当前媒体库"
                disabled={busy || !!action}
                onClick={() => {
                  setSearchDraft('')
                  library.openSearch()
                }}
              >
                <Search size={17} />
              </button>
            )}
            <button
              className="icon-button media-refresh"
              title="刷新媒体库"
              aria-label="刷新媒体库"
              disabled={busy || !!action}
              onClick={() => void (view ? library.refresh() : library.connect())}
            >
              <RefreshCw size={17} />
            </button>
            <button
              className="icon-button"
              title={visible ? '隐藏所有封面' : '显示所有封面'}
              aria-label={visible ? '隐藏所有封面' : '显示所有封面'}
              onClick={() => library.setVisible(!visible)}
            >
              {visible ? <Eye size={17} /> : <EyeOff size={17} />}
            </button>
          </div>
        </div>
        {library.error && (
          <div className="media-error" role="alert">
            {library.error}
            <button
              className="text-button"
              disabled={busy || !!action}
              onClick={() =>
                view?.kind === 'wall'
                  ? void library.loadWall({ ...view.query, start: 0 })
                  : view?.kind === 'search' && view.query.searchTerm
                    ? void library.loadSearch({ ...view.query, start: 0 })
                    : view?.kind === 'detail'
                      ? void library.openDetail(view.detail.id, false)
                      : void library.connect()
              }
            >
              重试
            </button>
          </div>
        )}
        <div
          className="media-scroll"
          ref={library.scroll}
          tabIndex={0}
          aria-label="媒体内容"
          onScroll={(event) => {
            const element = event.currentTarget
            if (
              !busy &&
              !action &&
              !library.error &&
              listing &&
              listing.page &&
              listing.page.next < listing.page.total &&
              element.scrollHeight - element.scrollTop - element.clientHeight < 160
            )
              void (listing.kind === 'search'
                ? library.loadSearch({ ...listing.query, start: listing.page.next }, true)
                : library.loadWall({ ...listing.query, start: listing.page.next }, true))
          }}
        >
          {!view && (
            <div className="media-empty">
              <Film size={36} />
              <h2>{library.connected ? '此账号暂无可访问的媒体库' : '浏览你的 Emby 媒体库'}</h2>
              <p>
                {busy
                  ? '正在连接…'
                  : library.connected
                    ? '请检查服务器媒体库和账号权限，然后刷新媒体库。'
                    : '在设置中保存服务器配置后，每次进入媒体库会自动连接。'}
              </p>
            </div>
          )}
          {view?.kind === 'search' && (
            <div className="media-search-page">
              <h2>搜索媒体</h2>
              <form
                className="media-search-form"
                role="search"
                onSubmit={(event) => {
                  event.preventDefault()
                  const term = searchDraft.trim()
                  if (!term || busy || action) return
                  void library.loadSearch({
                    ...view.query,
                    start: 0,
                    searchTerm: term,
                    favorites: false,
                    filter: undefined,
                  })
                }}
              >
                <input
                  ref={searchInput}
                  type="search"
                  aria-label="搜索媒体关键词"
                  placeholder="输入媒体名称，例如东营文化"
                  maxLength={200}
                  value={searchDraft}
                  disabled={busy || !!action}
                  onChange={(event) => setSearchDraft(event.target.value)}
                />
                <button
                  className="primary-button"
                  type="submit"
                  disabled={!searchDraft.trim() || busy || !!action}
                >
                  <Search size={17} />
                  搜索
                </button>
              </form>
              {busy && <p className="media-search-summary">正在搜索当前媒体库…</p>}
              {view.query.searchTerm && view.page && (
                <p className="media-search-summary">
                  “{view.query.searchTerm}”在{searchLibrary?.name ?? '全部媒体库'}找到{' '}
                  {view.page.total} 项
                </p>
              )}
            </div>
          )}
          {listing && (
            <>
              <div className="media-grid">{listing.page?.items.map((item) => card(item))}</div>
              {!busy && listing.page?.items.length === 0 && (
                <div className="media-empty">
                  <Film size={32} />
                  <h2>{listing.query.favorites ? '当前媒体库暂无收藏' : '没有匹配的媒体'}</h2>
                  <p>
                    {listing.kind === 'search'
                      ? '请试试其他关键词。'
                      : '可以切换媒体库或调整筛选条件。'}
                  </p>
                </div>
              )}
              {listing.page && listing.page.next < listing.page.total && (
                <button
                  className="secondary-button media-load-more"
                  disabled={busy || !!action}
                  onClick={() =>
                    void (listing.kind === 'search'
                      ? library.loadSearch({ ...listing.query, start: listing.page!.next }, true)
                      : library.loadWall({ ...listing.query, start: listing.page!.next }, true))
                  }
                >
                  加载更多
                </button>
              )}
            </>
          )}
          {view?.kind === 'detail' && (
            <>
              <div className="media-detail">
                <button
                  className="media-cover-play"
                  onContextMenu={(event) => openContextMenu(event, view.detail)}
                  onClick={() => play()}
                  disabled={!selectedSource || busy || !!action}
                  aria-label="播放视频"
                  title={selectedSource ? '播放所选版本' : '暂无可播放版本'}
                >
                  <Cover id={view.detail.id} visible={visible} revision={revision} />
                  <span className="media-cover-play-icon">
                    <Play size={28} fill="currentColor" />
                  </span>
                  <span className="media-cover-play-label">
                    {selectedSource ? '播放视频' : '暂无可播放版本'}
                  </span>
                </button>
                <MediaDetailInfo
                  key={detailId}
                  detail={view.detail}
                  source={selectedSource}
                  disabled={busy || !!action}
                  processing={queueingItems.has(detailId)}
                  processError={processError}
                  interactive={active && !playing}
                  javbusConfigured={!!workspace.settings.mediaServer.javbusUrl}
                  onOpenLink={(target) => void library.openLink(target)}
                  onSourceChange={setSource}
                  onFavorite={() => void library.favorite(view.detail)}
                  onDownload={(id) => void library.download(view.detail.id, id)}
                  onProcess={(kind) => {
                    if (selectedSource) void enqueueProcess(kind, view.detail, selectedSource.id)
                  }}
                  onRemove={() => {
                    deleteTrigger.current = document.activeElement as HTMLElement | null
                    void library.remove(view.detail.id)
                  }}
                  onFilter={(filter) => void library.filter(filter)}
                />
              </div>
              <MediaChapters
                detail={view.detail}
                visible={visible}
                disabled={!selectedSource || busy || !!action}
                onPlay={play}
              />
              <MediaShelf
                title="相关推荐"
                label="相关推荐"
                className="media-related-section"
                listClassName="media-related-list"
                count={view.similar.length}
              >
                {view.similarError ? (
                  <p role="alert">
                    {view.similarError}
                    <button
                      className="text-button"
                      onClick={() => void library.openDetail(view.detail.id, false)}
                    >
                      重试相关视频
                    </button>
                  </p>
                ) : view.similar.length ? (
                  view.similar.map((item) => card(item, true))
                ) : (
                  <p className="media-section-empty">暂无相关推荐。</p>
                )}
              </MediaShelf>
            </>
          )}
        </div>
        <div className="media-footer" aria-live="polite">
          <span>
            {busy
              ? '正在加载…'
              : action
                ? '正在提交操作…'
                : listing?.page
                  ? `已加载 ${listing.page.items.length} / ${listing.page.total} 项`
                  : '就绪'}
          </span>
          {view?.kind === 'wall' && view.query.favorites && (
            <span>
              {view.page?.favoriteDateUnavailable
                ? '服务器未返回收藏时间，沿用所选排序。'
                : '按已加载项目的收藏时间排序。'}
            </span>
          )}
        </div>
      </div>
      {playing &&
        playback &&
        view?.kind === 'detail' &&
        (playback.useVlc ? (
          <VlcMediaPlayer
            key={`vlc:${playback.id}:${playback.sourceId}`}
            detail={view.detail}
            sourceId={playback.sourceId}
            startSeconds={playback.startSeconds}
            onClose={closePlayback}
          />
        ) : (
          <MediaPlayer
            key={`${playback.id}:${playback.sourceId}`}
            detail={view.detail}
            sourceId={playback.sourceId}
            startSeconds={playback.startSeconds}
            startMuted={playback.startMuted}
            onClose={closePlayback}
          />
        ))}
      {contextMenu && active && !playing && (
        <MediaContextMenu
          key={contextMenu.request}
          menu={contextMenu}
          disabled={busy || !!action}
          processing={queueingItems.has(contextMenu.item.id)}
          onSourceChange={(sourceId) =>
            setContextMenu((current) => (current ? { ...current, sourceId } : current))
          }
          onProcess={(kind) => {
            void enqueueProcess(kind, contextMenu.item, contextMenu.sourceId || undefined)
          }}
          onDownload={() => {
            if (!contextMenu.sourceId) return
            void library.download(contextMenu.item.id, contextMenu.sourceId)
            closeContextMenu(false)
          }}
          onFavorite={() => {
            void library.favorite(contextMenu.detail ?? contextMenu.item)
            closeContextMenu(false)
          }}
          onRemove={() => {
            deleteTrigger.current = contextTrigger.current
            void library.remove(contextMenu.item.id)
            closeContextMenu(true)
          }}
          onClose={closeContextMenu}
        />
      )}
      {library.deletion && active && (
        <MediaDeleteConfirmation
          confirmation={library.deletion}
          onResolve={(confirmed) => {
            restoreDeleteFocus.current = !confirmed
            library.resolveDeletion(confirmed)
          }}
        />
      )}
    </section>
  )
}
