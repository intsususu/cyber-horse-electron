import { useEffect, useState } from 'react'
import type { PerformanceSnapshot } from '../../../shared/contracts'

export function usePerformance() {
  const [sample, setSample] = useState<PerformanceSnapshot | null>(null)
  const [history, setHistory] = useState<PerformanceSnapshot[]>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    let pending = false
    async function poll() {
      if (disposed || pending) return
      window.clearTimeout(timer)
      if (!document.hidden && window.cyberHorse) {
        pending = true
        try {
          const next = await window.cyberHorse.getPerformance()
          if (!disposed) {
            setSample(next)
            setHistory((current) => [...current.slice(-39), next])
            setFailed(false)
          }
        } catch {
          if (!disposed) {
            setFailed(true)
            setSample(null)
          }
        } finally {
          pending = false
        }
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), 2000)
    }
    const visible = () => {
      if (!document.hidden) void poll()
    }
    void poll()
    document.addEventListener('visibilitychange', visible)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  return { sample, history, failed }
}
