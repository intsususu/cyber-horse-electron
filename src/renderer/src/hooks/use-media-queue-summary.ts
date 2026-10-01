import { useEffect, useState } from 'react'

export function useMediaQueueSummary() {
  const [active, setActive] = useState<number | null>(window.cyberHorse ? null : 0)
  const [unified, setUnified] = useState(false)

  useEffect(() => {
    if (!window.cyberHorse) return
    let mounted = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const api = window.cyberHorse!
        if (typeof api.getMediaQueueSummary === 'function') {
          const summary = await api.getMediaQueueSummary()
          if (mounted) {
            setActive(summary.active)
            setUnified(!!summary.unified)
          }
        } else {
          // 开发模式中旧后台仍有任务运行时，保留已有接口以免要求立即重启。
          const [processes, downloads] = await Promise.all([
            api.getMediaProcesses(),
            api.getMediaDownloads(),
          ])
          const linkedDownloads = new Set(processes.map((process) => process.downloadId))
          const activeProcesses = processes.filter((process) =>
            ['pending', 'running'].includes(process.status),
          ).length
          const activeDownloads = downloads.filter(
            (download) =>
              ['running', 'cancelling'].includes(download.status) &&
              !linkedDownloads.has(download.id),
          ).length
          if (mounted) setActive(activeProcesses + activeDownloads)
        }
      } catch {
        if (mounted) setActive(null)
      } finally {
        if (mounted) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      mounted = false
      clearTimeout(timer)
    }
  }, [])

  return { active, unified }
}
