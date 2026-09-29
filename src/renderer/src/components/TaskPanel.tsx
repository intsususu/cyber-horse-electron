import { useEffect, useRef, useState } from 'react'
import { ListVideo, Trash2 } from 'lucide-react'
import type { MediaDownload, MediaProcessState } from '../../../shared/media-library'
import type { Workspace } from '../hooks/use-workspace'
import { buildTaskQueue, queueGroups, queueTab, type QueueTab } from '../lib/task-queue'
import { MediaDownloadTask, MediaProcessTask } from './MediaDownloadTasks'
import { WorkbenchTask } from './WorkbenchTask'

const tabs: { id: QueueTab; label: string; empty: string; description: string }[] = [
  {
    id: 'active',
    label: '进行中',
    empty: '当前没有进行中的任务',
    description: '已结束的任务可在“已完成”或“未完成”中查看。',
  },
  {
    id: 'completed',
    label: '已完成',
    empty: '暂无已完成任务',
    description: '处理成功的任务会自动移到这里。',
  },
  {
    id: 'unfinished',
    label: '未完成',
    empty: '暂无未完成记录',
    description: '失败、取消、中断和跳过的任务会保留在这里。',
  },
]

export function TaskPanel({
  workspace,
  onMediaProcesses,
}: {
  workspace: Workspace
  onMediaProcesses: (processes: MediaProcessState[]) => void
}) {
  const [mediaJobs, setMediaJobs] = useState<MediaDownload[]>([])
  const [mediaProcesses, setMediaProcesses] = useState<MediaProcessState[]>([])
  const [mediaError, setMediaError] = useState('')
  const [clearError, setClearError] = useState('')
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [tab, setTab] = useState<QueueTab>('active')
  const mediaRevision = useRef(0)
  const clearingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const revision = mediaRevision.current
      try {
        if (clearingRef.current) return
        const [jobs, processes] = await Promise.all([
          window.cyberHorse?.getMediaDownloads(),
          window.cyberHorse?.getMediaProcesses(),
        ])
        if (active && revision === mediaRevision.current) {
          if (jobs) setMediaJobs(jobs)
          if (processes) {
            setMediaProcesses(processes)
            onMediaProcesses(processes)
          }
          setMediaError('')
        }
      } catch {
        if (active && revision === mediaRevision.current)
          setMediaError('媒体库任务读取失败，正在重试；已显示的状态可能不是最新。')
      } finally {
        if (active) {
          setLoading(false)
          timer = setTimeout(() => void poll(), 750)
        }
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [onMediaProcesses])
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0)
  }, [tab])
  const entries = buildTaskQueue(workspace.run.tasks, mediaJobs, mediaProcesses)
  const counts = { active: 0, completed: 0, unfinished: 0 }
  for (const entry of entries) counts[queueTab(entry)]++
  const executing = entries.filter(
    (entry) => queueTab(entry) === 'active' && entry.task.status !== 'pending',
  ).length
  const anyRunning =
    workspace.running ||
    counts.active > 0 ||
    mediaJobs.some((job) => ['running', 'cancelling'].includes(job.status))
  const groups = queueGroups(entries, tab)
  const currentTab = tabs.find((item) => item.id === tab)!
  const clearRecords = async () => {
    if (clearingRef.current || loading || mediaError || anyRunning || !entries.length) return
    clearingRef.current = true
    setClearing(true)
    setClearError('')
    mediaRevision.current++
    try {
      await window.cyberHorse?.clearMediaTasks()
      workspace.dispatch({ type: 'clear' })
      setMediaJobs([])
      setMediaProcesses([])
      setMediaError('')
    } catch {
      setClearError('媒体库任务记录清除失败，请重试。')
    } finally {
      mediaRevision.current++
      clearingRef.current = false
      setClearing(false)
    }
  }
  return (
    <section className="panel task-panel">
      <div className="section-header queue-header">
        <div className="queue-tabs" role="tablist" aria-label="任务状态">
          {tabs.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                tabRefs.current[index] = node
              }}
              id={`queue-tab-${item.id}`}
              role="tab"
              aria-selected={tab === item.id}
              aria-controls="queue-task-list"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : -1
                if (next < 0) return
                event.preventDefault()
                setTab(tabs[next]!.id)
                tabRefs.current[next]?.focus()
              }}
            >
              {item.label}
              <span className="count-label">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <button
          className="text-button"
          disabled={clearing || loading || !!mediaError || anyRunning || !entries.length}
          title={
            anyRunning
              ? '任务结束后可清空全部展示记录，文件不受影响'
              : '清空全部已结束的展示记录，文件不受影响'
          }
          onClick={() => void clearRecords()}
        >
          <Trash2 size={14} />
          {clearing ? '正在清空…' : '清空记录'}
        </button>
      </div>
      {(clearError || mediaError || workspace.pipeline.error) && (
        <p className="queue-error" role="alert">
          {clearError || mediaError || workspace.pipeline.error}
        </p>
      )}
      <div
        ref={scrollRef}
        id="queue-task-list"
        role="tabpanel"
        aria-labelledby={`queue-tab-${tab}`}
        tabIndex={0}
        className="queue-scroll"
      >
        {loading && (
          <p className="queue-loading" role="status">
            正在读取媒体库任务…
          </p>
        )}
        {groups.map(
          (group) =>
            group.entries.length > 0 && (
              <section className="queue-group" key={group.title} aria-label={group.title}>
                <h2>
                  {group.title}
                  <span>{group.entries.length}</span>
                </h2>
                {group.entries.map((entry) =>
                  entry.kind === 'workbench' ? (
                    <WorkbenchTask key={entry.id} task={entry.task} workspace={workspace} />
                  ) : entry.kind === 'process' ? (
                    <MediaProcessTask
                      key={entry.id}
                      job={entry.task}
                      download={mediaJobs.find((job) => job.id === entry.task.downloadId)}
                      onError={setMediaError}
                    />
                  ) : (
                    <MediaDownloadTask key={entry.id} job={entry.task} onError={setMediaError} />
                  ),
                )}
              </section>
            ),
        )}
        {!counts[tab] && !loading && !mediaError && (
          <div className="empty-queue">
            <ListVideo size={28} strokeWidth={1.5} />
            <div>
              <h3>{currentTab.empty}</h3>
              <p>{currentTab.description}</p>
            </div>
          </div>
        )}
      </div>
      <div className="task-bottom">
        <span>
          <span className={`status-dot ${anyRunning ? 'pulse' : ''}`} />
          {executing ? `正在运行 ${executing} 项` : counts.active ? '等待执行' : '空闲'}
          {counts.active > executing ? ` · 等待 ${counts.active - executing} 项` : ''}
        </span>
        <span>
          已完成 {counts.completed} / {entries.length}
        </span>
      </div>
    </section>
  )
}
