import { useCallback, useEffect, useRef, useState } from 'react'
import type { HealthItem, Settings } from '../../../shared/contracts'

type CheckState = {
  key: string
  status: 'idle' | 'checking' | 'complete' | 'failed' | 'unsupported'
  items: HealthItem[]
  error: string
}

export function useEnvironmentHealth(paths: Settings['paths'], loaded: boolean) {
  // 只以已保存路径作为检查依据，主题及其他配置变化不触发复检。
  const key = JSON.stringify(paths)
  const [state, setState] = useState<CheckState>({ key, status: 'idle', items: [], error: '' })
  const request = useRef<{ key: string; promise: Promise<void>; cancel: () => void } | null>(null)
  const generation = useRef(0)
  const checkHealth = useCallback((): Promise<void> => {
    if (!loaded) return Promise.resolve()
    if (request.current?.key === key) return request.current.promise
    request.current?.cancel()
    const id = ++generation.current
    if (!window.cyberHorse) {
      setState({
        key,
        status: 'unsupported',
        items: [],
        error: '浏览器预览使用独立配置，未读取桌面配置文件；请在桌面窗口查看检测结果。',
      })
      return Promise.resolve()
    }
    setState({ key, status: 'checking', items: [], error: '' })
    let timer: ReturnType<typeof setTimeout>
    let cancel = () => {}
    const deadline = new Promise<HealthItem[]>((_, reject) => {
      timer = setTimeout(() => reject(new Error('检查超时')), 8000)
      cancel = () => {
        clearTimeout(timer)
        reject(new Error('检查已取消'))
      }
    })
    const promise = Promise.race([window.cyberHorse.checkPaths(), deadline])
      .then((items) => {
        if (generation.current === id) setState({ key, status: 'complete', items, error: '' })
      })
      .catch(() => {
        if (generation.current === id)
          setState({
            key,
            status: 'failed',
            items: [],
            error: '检测未完成，请重试；当前无法确认路径状态。',
          })
      })
      .finally(() => {
        clearTimeout(timer)
        if (generation.current === id) request.current = null
      })
    request.current = { key, promise, cancel }
    return promise
  }, [key, loaded])

  useEffect(() => {
    void checkHealth()
    return () => {
      ++generation.current
      request.current?.cancel()
      request.current = null
    }
  }, [checkHealth])

  const current =
    state.key === key ? state : { ...state, status: 'idle' as const, items: [], error: '' }
  return {
    health: current.items,
    healthStatus: current.status,
    healthError: current.error,
    checking: current.status === 'checking',
    checkHealth,
  }
}
