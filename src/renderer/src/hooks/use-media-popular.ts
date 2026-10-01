import { useCallback, useEffect, useRef, useState } from 'react'
import type { PopularState } from '../../../shared/media-popular'

export const popularError = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : '无法读取热门推荐，请重试。'

export function useMediaPopular(ready: boolean) {
  const [state, setState] = useState<PopularState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const locked = useRef(false)
  const refresh = useCallback(async () => {
    if (!window.cyberHorse || locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.cyberHorse.refreshMediaPopular()
      if (mounted.current) setState(result)
    } catch (error) {
      if (mounted.current) setError(popularError(error))
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    if (!ready)
      return () => {
        mounted.current = false
      }
    const api = window.cyberHorse
    if (!api) {
      setError('请在桌面应用中连接 Emby，浏览器预览不能读取媒体库。')
      return () => {
        mounted.current = false
      }
    }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const read = async (initial = false) => {
      try {
        const result = await api.getMediaPopular()
        if (!active) return
        setState(result)
        setError('')
        if (initial && !result.index && !result.scanning && !result.error) await refresh()
      } catch (error) {
        if (active) setError(popularError(error))
      } finally {
        if (active) timer = setTimeout(() => void read(), 2000)
      }
    }
    void read(true)
    return () => {
      mounted.current = false
      active = false
      clearTimeout(timer)
    }
  }, [ready, refresh])
  const cancel = async () => {
    try {
      await window.cyberHorse?.cancelMediaPopular()
    } catch (error) {
      if (mounted.current) setError(popularError(error))
    }
  }
  return { state, busy, error: error || state?.error || '', refresh, cancel }
}
