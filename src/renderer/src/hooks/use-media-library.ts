import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  LibraryPage,
  LibraryVideo,
  MediaDetail,
  MediaLibrary,
  MediaQuery,
  MediaLinkTarget,
} from '../../../shared/media-library'
import type { Workspace } from './use-workspace'

const baseQuery = {
  start: 0,
  limit: 30,
  sort: 'DateCreated' as const,
  favorites: false,
}
type ListingView = {
  kind: 'wall' | 'search'
  query: MediaQuery
  page: LibraryPage | null
  scroll: number
}
type View =
  | ListingView
  | { kind: 'detail'; detail: MediaDetail; similar: LibraryVideo[]; similarError: string }
const isListing = (value: View | null): value is ListingView =>
  value?.kind === 'wall' || value?.kind === 'search'
export function useMediaLibrary(workspace: Workspace, active: boolean) {
  const [libraries, setLibraries] = useState<MediaLibrary[]>([])
  const [connected, setConnected] = useState(false)
  const [view, setView] = useState<View | null>(null)
  const [history, setHistory] = useState<View[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState('')
  const [visible, setVisible] = useState(workspace.settings.privacyCover.defaultEyeOpen)
  const sequence = useRef(0)
  const actionLock = useRef(false)
  const autoAttempt = useRef<string | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const restoreScroll = useRef<number | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const connection = JSON.stringify(workspace.settings.mediaServer)
  useLayoutEffect(() => {
    if (restoreScroll.current === null || !scroll.current) return
    scroll.current.scrollTop = restoreScroll.current
    restoreScroll.current = null
  }, [view])
  const message = (error: unknown) =>
    error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
      : '媒体库请求失败，请重试。'
  const remember = (
    current: View | null = viewRef.current,
    position = scroll.current?.scrollTop ?? 0,
  ) => {
    if (current)
      setHistory((previous) => [
        ...previous.slice(-29),
        isListing(current) ? { ...current, scroll: position } : current,
      ])
  }
  const loadPage = async (
    query: MediaQuery,
    append = false,
    push = false,
    kind: ListingView['kind'] = 'wall',
  ) => {
    const api = window.cyberHorse
    if (!api) return
    if (push) remember()
    const request = ++sequence.current
    const previous = viewRef.current
    setBusy(true)
    setError('')
    if (!append) setView({ kind, query, page: null, scroll: 0 })
    try {
      const page = await api.getMediaPage(query)
      if (request !== sequence.current) return
      const existing = append && isListing(previous) ? (previous.page?.items ?? []) : []
      const items = [
        ...new Map([...existing, ...page.items].map((item) => [item.id, item])).values(),
      ]
      if (query.favorites && items.every((item) => item.favoriteDate))
        items.sort((a, b) => b.favoriteDate!.localeCompare(a.favoriteDate!))
      setView({
        kind,
        query,
        page: { ...page, items },
        scroll: append ? (scroll.current?.scrollTop ?? 0) : 0,
      })
      if (!append && scroll.current) scroll.current.scrollTop = 0
    } catch (error) {
      if (request === sequence.current) setError(message(error))
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }
  const loadWall = (query: MediaQuery, append = false, push = false) =>
    loadPage(query, append, push)
  const loadSearch = (query: MediaQuery, append = false) => loadPage(query, append, false, 'search')
  const openSearch = () => {
    const libraryId = currentListing?.query.libraryId ?? libraries[0]?.id
    if (!libraryId) return
    sequence.current++
    remember()
    setError('')
    setBusy(false)
    setView({ kind: 'search', query: { ...baseQuery, libraryId }, page: null, scroll: 0 })
    if (scroll.current) scroll.current.scrollTop = 0
  }
  const connect = useCallback(async () => {
    const api = window.cyberHorse
    if (!api) {
      setError('浏览器预览无法连接媒体服务器，请使用桌面应用。')
      return
    }
    const request = ++sequence.current
    setBusy(true)
    setError('')
    setView(null)
    setLibraries([])
    setConnected(false)
    setHistory([])
    try {
      const libraries = await api.getMediaLibraries()
      if (request !== sequence.current) return
      setLibraries(libraries)
      setConnected(true)
      if (libraries[0]) await loadWall({ ...baseQuery, libraryId: libraries[0].id })
    } catch (error) {
      if (request === sequence.current) setError(message(error))
    } finally {
      if (request === sequence.current) setBusy(false)
    }
    // 连接仅使用主进程已保存配置。
  }, [])
  useEffect(() => {
    sequence.current++
    autoAttempt.current = null
    setLibraries([])
    setConnected(false)
    setView(null)
    setHistory([])
    setError('')
    setBusy(false)
    return () => {
      sequence.current++
    }
  }, [connection])
  useEffect(() => {
    if (!active) {
      autoAttempt.current = null
      return
    }
    if (
      !workspace.loaded ||
      !window.cyberHorse ||
      !workspace.settings.mediaServer.serverUrl.trim() ||
      !workspace.settings.mediaServer.username.trim() ||
      autoAttempt.current === connection
    )
      return
    // 每次进入页面自动加载一次；失败保留提示，避免自动重试循环。
    autoAttempt.current = connection
    void connect()
  }, [
    active,
    workspace.loaded,
    connection,
    connect,
    workspace.settings.mediaServer.serverUrl,
    workspace.settings.mediaServer.username,
  ])
  useEffect(
    () => setVisible(workspace.settings.privacyCover.defaultEyeOpen),
    [workspace.settings.privacyCover.defaultEyeOpen],
  )
  const openDetail = async (id: string, push = true) => {
    const api = window.cyberHorse
    if (!api) return
    const previous = viewRef.current
    const previousScroll = scroll.current?.scrollTop ?? 0
    const request = ++sequence.current
    setBusy(true)
    setError('')
    try {
      const detail = await api.getMediaDetail(id)
      if (request !== sequence.current) return
      if (push) remember(previous, previousScroll)
      setView({ kind: 'detail', detail, similar: [], similarError: '' })
      setBusy(false)
      if (scroll.current) scroll.current.scrollTop = 0
      try {
        const similar = await api.getMediaSimilar(id)
        if (request === sequence.current)
          setView((current) =>
            current?.kind === 'detail' ? { ...current, similar, similarError: '' } : current,
          )
      } catch (error) {
        if (request === sequence.current)
          setView((current) =>
            current?.kind === 'detail' ? { ...current, similarError: message(error) } : current,
          )
      }
    } catch (error) {
      if (request === sequence.current) setError(message(error))
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }
  const mutateViews = (id: string, favorite: boolean | null) => {
    const update = (value: View): View => {
      const updateItems = (items: LibraryVideo[], onlyFavorite = false) =>
        items
          .filter((v) => v.id !== id || (favorite !== null && (!onlyFavorite || favorite)))
          .map((v) => (v.id === id ? { ...v, favorite: favorite! } : v))
      if (isListing(value))
        return {
          ...value,
          page: value.page
            ? {
                ...value.page,
                items: updateItems(value.page.items, value.query.favorites),
                total: Math.max(
                  0,
                  value.page.total -
                    (value.page.items.some((v) => v.id === id) &&
                    (favorite === null || (value.query.favorites && !favorite))
                      ? 1
                      : 0),
                ),
                next: Math.max(
                  0,
                  value.page.next -
                    (value.page.items.some((v) => v.id === id) &&
                    (favorite === null || (value.query.favorites && !favorite))
                      ? 1
                      : 0),
                ),
              }
            : null,
        }
      return {
        ...value,
        detail:
          value.detail.id === id && favorite !== null
            ? { ...value.detail, favorite }
            : value.detail,
        similar: updateItems(value.similar),
      }
    }
    setView((v) => (v ? update(v) : v))
    setHistory((values) =>
      values
        .filter((v) => favorite !== null || v.kind !== 'detail' || v.detail.id !== id)
        .map(update),
    )
  }
  const perform = async (key: string, fn: () => Promise<void>) => {
    if (actionLock.current) return
    actionLock.current = true
    setAction(key)
    setError('')
    try {
      await fn()
    } catch (error) {
      setError(message(error))
    } finally {
      actionLock.current = false
      setAction('')
    }
  }
  const back = () => {
    sequence.current++
    setBusy(false)
    setError('')
    const previous = history.at(-1)
    if (!previous) return
    restoreScroll.current = isListing(previous) ? previous.scroll : 0
    setView(previous)
    setHistory((values) => values.slice(0, -1))
  }
  const currentListing = isListing(view) ? view : [...history].reverse().find(isListing)
  return {
    libraries,
    connected,
    view,
    busy,
    error,
    action,
    visible,
    setVisible,
    scroll,
    history,
    connect,
    loadWall,
    loadSearch,
    openSearch,
    openDetail,
    back,
    currentListing,
    openLink: (target: MediaLinkTarget) =>
      perform('link', async () => {
        if (view?.kind !== 'detail') return
        await window.cyberHorse!.openMediaLink({ id: view.detail.id, target })
      }),
    favorite: (item: LibraryVideo) =>
      perform(item.id, async () => {
        const request = sequence.current
        const favorite = await window.cyberHorse!.setMediaFavorite({
          id: item.id,
          favorite: !item.favorite,
        })
        if (request === sequence.current) mutateViews(item.id, favorite)
      }),
    filter: (filter: MediaQuery['filter']) => {
      if (currentListing)
        void loadWall(
          { ...currentListing.query, start: 0, favorites: false, searchTerm: undefined, filter },
          false,
          true,
        )
    },
    refresh: () =>
      perform('refresh', async () => {
        const request = sequence.current
        const id = view?.kind === 'detail' ? view.detail.id : currentListing?.query.libraryId
        if (!id) return
        await window.cyberHorse!.refreshMediaItem(id)
        if (request !== sequence.current) return
        workspace.setToast('已向 Emby 提交刷新请求，服务端仍可能正在扫描。')
        if (view?.kind === 'detail') await openDetail(id, false)
        else if (currentListing) {
          const query = { ...currentListing.query, start: 0, filter: undefined, favorites: false }
          if (currentListing.kind === 'search' && query.searchTerm) await loadSearch(query)
          else await loadWall(query)
        }
      }),
    download: (id: string, sourceId: string) =>
      perform('download', async () => {
        await window.cyberHorse!.startMediaDownload({ id, sourceId })
        workspace.setToast('下载已开始，可在任务队列查看进度或取消。')
        workspace.addLog('已启动媒体库下载，请在任务队列查看结果。')
      }),
    remove: () =>
      perform('delete', async () => {
        const request = sequence.current
        if (view?.kind !== 'detail') return
        if (await window.cyberHorse!.deleteMediaItem(view.detail.id)) {
          if (request !== sequence.current) return
          mutateViews(view.detail.id, null)
          if (currentListing) {
            setHistory([])
            const query = { ...currentListing.query, start: 0 }
            if (currentListing.kind === 'search' && query.searchTerm) await loadSearch(query)
            else await loadWall(query)
          } else setView(null)
          workspace.setToast('服务器已删除该媒体项目。')
        }
      }),
  }
}
