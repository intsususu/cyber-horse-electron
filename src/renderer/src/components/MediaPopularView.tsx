import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Heart,
  Info,
  Layers,
  Search,
  X,
  RefreshCw,
  UserRound,
} from 'lucide-react'
import { Cover, MediaVideoCard } from './MediaVideoCard'
import type { LibraryVideo } from '../../../shared/media-library'
import type { PopularPageQuery } from '../../../shared/media-popular'
import { popularError, type useMediaPopular } from '../hooks/use-media-popular'

export function MediaPopularView({
  visible,
  onToggleVisible,
  popular,
  onOpenVideo,
  revision,
  active,
}: {
  visible: boolean
  onToggleVisible: () => void
  popular: ReturnType<typeof useMediaPopular>
  onOpenVideo: (id: string) => void
  revision: string
  active: boolean
}) {
  const [selection, setSelection] = useState<{ kind: 'series' | 'actors'; id: string } | null>(null)
  const [homeKind, setHomeKind] = useState<'series' | 'actors'>('series')
  const kind = selection?.kind ?? 'series'
  const index = popular.state?.index
  const groups = index?.groups[kind] ?? []
  const selected = groups.find((group) => group.id === selection?.id)
  const listBackButton = useRef<HTMLButtonElement>(null)
  const home = useRef<HTMLDivElement>(null)
  const previousSelection = useRef(selection)
  const rankingPositions = useRef({ series: 0, actors: 0 })
  const switchRanking = (nextKind: 'series' | 'actors') => {
    rankingPositions.current[homeKind] =
      home.current?.querySelector('.popular-ranking-scroll')?.scrollTop ?? 0
    setHomeKind(nextKind)
  }
  const grid = useRef<HTMLDivElement>(null)
  const lastVideoId = useRef<string | null>(null)
  const scrollPosition = useRef(0)
  const [items, setItems] = useState<LibraryVideo[]>([])
  const [next, setNext] = useState(0)
  const [missing, setMissing] = useState(0)
  const [total, setTotal] = useState(0)
  const [sort, setSort] = useState<NonNullable<PopularPageQuery['sort']>>('PlayCount')
  const [favorites, setFavorites] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const searchInput = useRef<HTMLInputElement>(null)
  const reloadRequested = useRef(false)
  const [listError, setListError] = useState('')
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const listLock = useRef(false)
  const load = async (start: number) => {
    if (!selection || !index || !window.cyberHorse || listLock.current) return
    const request = sequence.current
    listLock.current = true
    setLoading(true)
    setListError('')
    try {
      const page = await window.cyberHorse.getMediaPopularPage({
        ...selection,
        updatedAt: index.updatedAt,
        start,
        sort,
        favorites,
        searchTerm,
        reload: start === 0 && reloadRequested.current,
      })
      if (request !== sequence.current) return
      setItems((current) => (start ? [...current, ...page.items] : page.items))
      setNext(page.next)
      setMissing(page.missing)
      setTotal(page.total)
      reloadRequested.current = false
    } catch (error) {
      if (request === sequence.current) setListError(popularError(error))
    } finally {
      if (request === sequence.current) {
        listLock.current = false
        setLoading(false)
      }
    }
  }
  useEffect(() => {
    setSelection(null)
  }, [index?.updatedAt, index?.identity])
  useEffect(() => {
    sequence.current++
    listLock.current = false
    setItems([])
    setNext(0)
    setMissing(0)
    setTotal(0)
    setListError('')
    setLoading(false)
    if (selection) void load(0)
    if (grid.current) grid.current.scrollTop = 0
    return () => {
      sequence.current++
    }
  }, [selection, index?.updatedAt, sort, favorites, searchTerm, refreshKey])
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])
  useLayoutEffect(() => {
    if (active && lastVideoId.current) {
      grid.current
        ?.querySelector<HTMLButtonElement>(
          `[data-video-id="${lastVideoId.current}"] .media-card-open`,
        )
        ?.focus({ preventScroll: true })
      if (grid.current) grid.current.scrollTop = scrollPosition.current
    }
  }, [active])
  useLayoutEffect(() => {
    if (selection) listBackButton.current?.focus()
    else if (previousSelection.current) {
      const previous = previousSelection.current
      const buttons = home.current?.querySelectorAll<HTMLButtonElement>('[data-group-id]')
      Array.from(buttons ?? [])
        .find(
          (button) =>
            button.dataset.groupId === previous.id && button.dataset.groupKind === previous.kind,
        )
        ?.focus({ preventScroll: true })
    }
    const list = home.current?.querySelector('.popular-ranking-scroll')
    if (list) list.scrollTop = rankingPositions.current[homeKind]
    previousSelection.current = selection
  }, [selection, homeKind])

  return (
    <div className="media-popular">
      {!selected && (
        <div className="media-toolbar popular-home-toolbar" aria-label="热门榜单浏览工具">
          <div className="media-sort popular-tabs" role="tablist" aria-label="热门榜单分类">
            {(['series', 'actors'] as const).map((value) => (
              <button
                key={value}
                id={`popular-tab-${value}`}
                role="tab"
                aria-selected={homeKind === value}
                aria-controls="popular-ranking-panel"
                tabIndex={homeKind === value ? 0 : -1}
                onClick={() => switchRanking(value)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const nextKind =
                    event.key === 'Home'
                      ? 'series'
                      : event.key === 'End'
                        ? 'actors'
                        : homeKind === 'series'
                          ? 'actors'
                          : 'series'
                  switchRanking(nextKind)
                  document.getElementById(`popular-tab-${nextKind}`)?.focus()
                }}
              >
                {value === 'series' ? <Layers size={16} /> : <UserRound size={16} />}
                {value === 'series' ? '热门系列' : '热门演员'}
              </button>
            ))}
          </div>
          <div className="media-toolbar-actions popular-tools">
            <span>
              {index
                ? `更新于 ${new Date(index.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                : '尚未初始化'}
            </span>
            <button
              className="icon-button"
              aria-label={popular.state?.scanning ? '正在扫描' : index ? '更新榜单' : '初始化扫描'}
              title={popular.state?.scanning ? '正在扫描' : index ? '更新榜单' : '初始化扫描'}
              disabled={popular.busy || popular.state?.scanning || !window.cyberHorse}
              onClick={() => void popular.refresh()}
            >
              <RefreshCw size={17} />
            </button>
            {popular.state?.scanning && (
              <button className="text-button" onClick={() => void popular.cancel()}>
                取消扫描
              </button>
            )}
            <button
              className="icon-button"
              aria-label={visible ? '隐藏热门封面' : '显示热门封面'}
              title={visible ? '隐藏热门封面' : '显示热门封面'}
              onClick={onToggleVisible}
            >
              {visible ? <Eye size={17} /> : <EyeOff size={17} />}
            </button>
          </div>
        </div>
      )}
      {selected && (
        <>
          <div className="media-toolbar popular-media-toolbar" aria-label="关联视频浏览工具">
            <button
              ref={listBackButton}
              className="icon-button media-back-button"
              aria-label="返回热门推荐"
              title="返回热门推荐"
              onClick={() => setSelection(null)}
            >
              <ArrowLeft size={18} />
            </button>
            <h3 className="popular-current-name" title={selected.name}>
              {selected.name}
            </h3>
            <div className="media-toolbar-actions">
              <div className="media-sort" role="group" aria-label="关联视频排序">
                {(
                  [
                    ['DateCreated', '加入日期'],
                    ['DatePlayed', '播放日期'],
                    ['PlayCount', '播放次数'],
                  ] as const
                ).map(([value, label]) => (
                  <button key={value} aria-pressed={sort === value} onClick={() => setSort(value)}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="media-toolbar-divider" aria-hidden="true" />
              <button
                className="media-favorites"
                aria-pressed={favorites}
                onClick={() => setFavorites(!favorites)}
              >
                <Heart size={16} fill={favorites ? 'currentColor' : 'none'} />
                我的收藏
              </button>
              <span className="media-toolbar-divider" aria-hidden="true" />
              <button
                className="icon-button"
                aria-label="搜索当前关联视频"
                title="搜索当前系列或演员的视频"
                aria-expanded={searchOpen}
                onClick={() => setSearchOpen(!searchOpen)}
              >
                <Search size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="刷新关联视频"
                title="重新读取当前视频列表"
                disabled={loading}
                onClick={() => {
                  reloadRequested.current = true
                  setRefreshKey((value) => value + 1)
                }}
              >
                <RefreshCw size={17} />
              </button>
              <button
                className="icon-button"
                aria-label={visible ? '隐藏热门封面' : '显示热门封面'}
                title={visible ? '隐藏热门封面' : '显示热门封面'}
                onClick={onToggleVisible}
              >
                {visible ? <Eye size={17} /> : <EyeOff size={17} />}
              </button>
            </div>
          </div>
          {searchOpen && (
            <form
              className="media-search-form popular-search-form"
              role="search"
              onSubmit={(event) => {
                event.preventDefault()
                setSearchTerm(searchDraft.trim())
              }}
            >
              <input
                ref={searchInput}
                aria-label="搜索当前关联视频的名称"
                placeholder="在当前系列或演员中搜索影片名称"
                value={searchDraft}
                maxLength={200}
                onChange={(event) => setSearchDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setSearchOpen(false)
                    setSearchTerm('')
                    setSearchDraft('')
                  }
                }}
              />
              <button className="primary-button" type="submit">
                搜索
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭并清除搜索"
                onClick={() => {
                  setSearchOpen(false)
                  setSearchTerm('')
                  setSearchDraft('')
                }}
              >
                <X size={17} />
              </button>
            </form>
          )}
        </>
      )}
      {popular.error && (
        <div className="popular-notice" role="alert">
          {popular.error}
        </div>
      )}
      {popular.state?.scanning && (
        <div className="popular-notice" role="status">
          {popular.state.progress}
        </div>
      )}
      {!selected && !index && !popular.state?.scanning && (
        <div className="popular-notice">
          <Info size={16} />
          <span>首次进入将读取当前账号可访问的影片和合集，生成个人偏好榜单。</span>
        </div>
      )}
      {selected ? (
        <div className="popular-list-page">
          <section className="popular-selection" aria-label="关联视频">
            <div className="popular-list-summary">
              <span>{kind === 'series' ? '系列影片' : '演员作品'}</span>
              <span>
                {loading && !items.length ? '正在读取…' : `已加载 ${items.length} / ${total} 部`}
                {searchTerm && <> · 搜索“{searchTerm}”</>}
                {(favorites || searchTerm) && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setFavorites(false)
                      setSearchTerm('')
                      setSearchDraft('')
                    }}
                  >
                    清除筛选
                  </button>
                )}
              </span>
            </div>
            <div
              className="media-scroll popular-videos-scroll"
              ref={grid}
              tabIndex={0}
              aria-label="热门关联视频清单"
            >
              <div className="media-grid popular-video-grid">
                {items.map((item) => (
                  <div key={item.id} data-video-id={item.id}>
                    <MediaVideoCard
                      item={item}
                      visible={visible}
                      revision={`${revision}:${refreshKey}`}
                      onOpen={(id) => {
                        scrollPosition.current = grid.current?.scrollTop ?? 0
                        lastVideoId.current = id
                        onOpenVideo(id)
                      }}
                    />
                  </div>
                ))}
              </div>
              {loading && (
                <p className="popular-ranking-note" role="status">
                  正在读取视频…
                </p>
              )}
              {missing > 0 && (
                <p className="popular-ranking-note">
                  {missing} 部视频已移除或不可访问，可更新榜单后重试。
                </p>
              )}
              {listError && <p role="alert">{listError}</p>}
              {!loading && !listError && items.length === 0 && (
                <p className="popular-empty">
                  {favorites || searchTerm ? '没有符合条件的视频' : '暂无可访问的视频'}
                </p>
              )}
              {!loading && (listError || next < total) && (
                <button className="secondary-button" onClick={() => void load(next)}>
                  {listError ? '重试加载' : '加载更多'}
                </button>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="popular-home" ref={home}>
          <div className="popular-home-summary">
            <span>Top 15 · 当前账号 · 累计热度</span>
            <details className="popular-ranking-info" key={homeKind}>
              <summary className="icon-button" aria-label="榜单统计说明" title="榜单统计说明">
                <Info size={16} />
              </summary>
              <div className="popular-info-content">
                <p>累计播放 60% · 收藏 25% · 作品数 15%。应用运行时每 6 小时更新。</p>
                <p>
                  {index
                    ? `已统计 ${index.totals.videos} 部影片 · 累计播放 ${index.totals.plays} 次 · 收藏 ${index.totals.favorites} 部。`
                    : '等待初始化扫描。'}
                </p>
                {homeKind === 'actors' && !!index?.totals.missingPeople && (
                  <p>{index.totals.missingPeople} 部影片缺少演员信息，未计入演员榜。</p>
                )}
              </div>
            </details>
          </div>
          <div
            id="popular-ranking-panel"
            className="popular-ranking-panel"
            role="tabpanel"
            aria-labelledby={`popular-tab-${homeKind}`}
          >
            <section
              className={`popular-ranking ${homeKind === 'series' ? 'popular-ranking-series' : ''}`}
              key={homeKind}
              aria-label={homeKind === 'series' ? '热门系列榜单' : '热门演员榜单'}
            >
              <div
                className={`popular-ranking-scroll ${homeKind === 'series' ? 'popular-series-grid' : ''}`}
                tabIndex={0}
                aria-label={homeKind === 'series' ? '系列排名' : '演员排名'}
              >
                {(index?.groups[homeKind] ?? []).slice(0, 15).map((group, index) => (
                  <button
                    className={
                      homeKind === 'series'
                        ? 'popular-series-card'
                        : 'popular-rank-row popular-actor-row'
                    }
                    key={group.id}
                    data-group-id={group.id}
                    data-group-kind={homeKind}
                    title={group.name}
                    aria-label={`${String(index + 1).padStart(2, '0')} ${group.name}`}
                    onClick={() => {
                      rankingPositions.current[homeKind] =
                        home.current?.querySelector('.popular-ranking-scroll')?.scrollTop ?? 0
                      setSelection({ kind: homeKind, id: group.id })
                      setSort('PlayCount')
                      setFavorites(false)
                      setSearchTerm('')
                      setSearchDraft('')
                      setSearchOpen(false)
                    }}
                  >
                    {homeKind === 'series' ? (
                      <span className="popular-series-art" aria-hidden="true">
                        {group.videoIds.slice(0, 4).map((id) => (
                          <Cover key={id} id={id} visible={visible} revision={revision} lazy />
                        ))}
                      </span>
                    ) : (
                      <>
                        <span className={`popular-rank-number ${index < 3 ? 'is-leading' : ''}`}>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="popular-actor-avatar" aria-hidden="true">
                          <Cover id={group.id} visible={visible} revision={revision} avatar lazy />
                        </span>
                      </>
                    )}
                    <span
                      className={
                        homeKind === 'series' ? 'popular-series-footer' : 'popular-actor-content'
                      }
                    >
                      {homeKind === 'series' && (
                        <span className={`popular-rank-number ${index < 3 ? 'is-leading' : ''}`}>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                      )}
                      <span className="popular-rank-copy">
                        <strong>{group.name}</strong>
                      </span>
                      <ChevronRight size={16} className="popular-rank-arrow" />
                    </span>
                  </button>
                ))}
                {!index?.groups[homeKind].length && (
                  <p className="popular-empty">
                    {popular.state?.scanning
                      ? '正在生成榜单…'
                      : index
                        ? homeKind === 'series'
                          ? '没有可归组的影片合集'
                          : '没有可归组的演员信息'
                        : '等待初始化扫描'}
                  </p>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
