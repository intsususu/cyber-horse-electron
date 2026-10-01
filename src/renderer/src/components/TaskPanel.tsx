import { useEffect, useRef, useState } from 'react'
import { ListVideo, Trash2 } from 'lucide-react'
import type { MediaDownload, MediaProcessState } from '../../../shared/media-library'
import type { Workspace } from '../hooks/use-workspace'
import {
  buildTaskQueue,
  queueGroups,
  queueTab,
  workspaceTaskDownload,
  type QueueTab,
} from '../lib/task-queue'
import { MediaDownloadTask, MediaProcessTask } from './MediaDownloadTasks'
import { WorkbenchTask } from './WorkbenchTask'
import type { TaskAction, TaskActionPlan, TaskView } from '../../../shared/task-workspace'
import { WorkspaceTaskCard, workspaceTaskTab } from './WorkspaceTaskCard'
import { WorkspaceActionModal } from './WorkspaceActionModal'
import { Modal } from './Modal'

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
  const [clearRequested, setClearRequested] = useState(false)
  const clearTrigger = useRef<HTMLButtonElement | null>(null)
  const clearCancel = useRef<HTMLButtonElement | null>(null)
  const [tab, setTab] = useState<QueueTab>('active')
  const [now, setNow] = useState(Date.now)
  const [workspaceTasks, setWorkspaceTasks] = useState<TaskView[]>([])
  const [diagnostics, setDiagnostics] = useState<{ directory: string; message: string }[]>([])
  const [actionPlan, setActionPlan] = useState<TaskActionPlan | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const actionTrigger = useRef<HTMLElement | null>(null)
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
        const [jobs, processes, tasks] = await Promise.all([
          window.cyberHorse?.getMediaDownloads(),
          window.cyberHorse?.getMediaProcesses(),
          window.cyberHorse?.listWorkspaceTasks?.(),
        ])
        if (active && revision === mediaRevision.current) {
          if (jobs) setMediaJobs(jobs)
          if (tasks) {
            setWorkspaceTasks(tasks.tasks)
            setDiagnostics(tasks.diagnostics)
          }
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
  const entries = buildTaskQueue(
    workspace.run.tasks,
    mediaJobs,
    mediaProcesses,
    workspaceTasks,
    workspace.run.pipeline?.id,
  )
  const visibleWorkspaceTasks = workspaceTasks.filter((view) => workspaceTaskTab(view) === tab)
  const counts = { active: 0, completed: 0, unfinished: 0 }
  for (const entry of entries) counts[queueTab(entry)]++
  for (const view of workspaceTasks) {
    const group = workspaceTaskTab(view)
    if (group) counts[group]++
  }
  const executing =
    entries.filter((entry) => queueTab(entry) === 'active' && entry.task.status !== 'pending')
      .length + workspaceTasks.filter((view) => view.active && view.task.state !== 'queued').length
  const ticking = executing > 0
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  const anyRunning =
    workspace.running ||
    counts.active > 0 ||
    mediaJobs.some((job) => ['running', 'cancelling'].includes(job.status))
  const groups = queueGroups(entries, tab)
  const currentTab = tabs.find((item) => item.id === tab)!
  const describe = (error: unknown) =>
    error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
      : '任务操作失败，请重新预览。'
  const act = async (id: string, action: TaskAction) => {
    if (actionBusy || actionPlan || clearRequested || clearingRef.current) return
    actionTrigger.current = document.activeElement as HTMLElement | null
    setActionBusy(true)
    setActionError('')
    try {
      setActionPlan(await window.cyberHorse!.previewWorkspaceAction({ id, action }))
    } catch (error) {
      setActionError(describe(error))
    } finally {
      setActionBusy(false)
    }
  }
  const confirmAction = async () => {
    if (!actionPlan || actionBusy || clearRequested || clearingRef.current) return
    setActionBusy(true)
    setActionError('')
    try {
      await window.cyberHorse!.confirmWorkspaceAction({
        planId: actionPlan.planId,
        revision: actionPlan.revision,
      })
      setActionPlan(null)
      await workspace.pipeline.reload()
      const result = await window.cyberHorse!.listWorkspaceTasks()
      setWorkspaceTasks(result.tasks)
    } catch (error) {
      setActionError(describe(error))
    } finally {
      setActionBusy(false)
    }
  }
  const clearRecords = async () => {
    if (
      clearingRef.current ||
      !clearRequested ||
      actionBusy ||
      actionPlan ||
      loading ||
      mediaError ||
      anyRunning ||
      (!entries.length && !workspaceTasks.length)
    )
      return
    clearingRef.current = true
    setClearing(true)
    setClearError('')
    mediaRevision.current++
    try {
      await window.cyberHorse?.clearMediaTasks()
      workspace.dispatch({ type: 'clear' })
      setMediaJobs([])
      setMediaProcesses([])
      if (window.cyberHorse?.listWorkspaceTasks)
        setWorkspaceTasks((await window.cyberHorse.listWorkspaceTasks()).tasks)
      setMediaError('')
      setClearRequested(false)
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
          ref={clearTrigger}
          className="text-button"
          disabled={
            clearing ||
            actionBusy ||
            !!actionPlan ||
            loading ||
            !!mediaError ||
            anyRunning ||
            (!entries.length && !workspaceTasks.some((view) => !view.recoverable))
          }
          title={
            anyRunning
              ? '任务结束后可清空全部展示记录，文件不受影响'
              : '清空全部已结束的展示记录，文件不受影响'
          }
          onClick={() => {
            if (!actionBusy && !actionPlan) {
              setClearError('')
              setClearRequested(true)
            }
          }}
        >
          <Trash2 size={14} />
          {clearing ? '正在清空…' : '清空记录'}
        </button>
      </div>
      {(clearError || mediaError || workspace.pipeline.error || (actionError && !actionPlan)) && (
        <p className="queue-error" role="alert">
          {clearError || mediaError || workspace.pipeline.error || actionError}
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
        {diagnostics.map((item) => (
          <p className="queue-error workspace-task-path" key={item.directory}>
            {item.message} · {item.directory}
          </p>
        ))}
        {visibleWorkspaceTasks.map((view) => (
          <WorkspaceTaskCard
            key={view.task.id}
            view={view}
            download={workspaceTaskDownload(view, mediaJobs)}
            busy={actionBusy || clearing || clearRequested}
            act={(id, action) => void act(id, action)}
            open={(id) =>
              void window
                .cyberHorse!.openWorkspaceDirectory({ id })
                .catch((error) => setActionError(describe(error)))
            }
            cancel={(id) =>
              void window
                .cyberHorse!.cancelWorkspaceTask({ id })
                .catch((error) => setActionError(describe(error)))
            }
          />
        ))}
        {groups.map(
          (group) =>
            group.entries.length > 0 && (
              <section className="queue-group" key={group.title} aria-label={group.title}>
                {tab === 'active' && (
                  <h2>
                    {group.title}
                    <span>{group.entries.length}</span>
                  </h2>
                )}
                {group.entries.map((entry) =>
                  entry.kind === 'workbench' ? (
                    <WorkbenchTask
                      key={entry.id}
                      task={entry.task}
                      workspace={workspace}
                      now={now}
                    />
                  ) : entry.kind === 'process' ? (
                    <MediaProcessTask
                      key={entry.id}
                      job={entry.task}
                      download={mediaJobs.find((job) => job.id === entry.task.downloadId)}
                      onError={setMediaError}
                      now={now}
                    />
                  ) : (
                    <MediaDownloadTask
                      key={entry.id}
                      job={entry.task}
                      onError={setMediaError}
                      now={now}
                    />
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
          已完成 {counts.completed} / {counts.active + counts.completed + counts.unfinished}
        </span>
      </div>
      {actionPlan && (
        <WorkspaceActionModal
          plan={actionPlan}
          returnFocusRef={actionTrigger}
          busy={actionBusy}
          error={actionError}
          confirm={() => void confirmAction()}
          close={() => {
            setActionPlan(null)
            setActionError('')
          }}
        />
      )}
      {clearRequested && (
        <Modal
          title="清空全部已结束记录"
          onClose={() => {
            if (!clearing) setClearRequested(false)
          }}
          initialFocusRef={clearCancel}
          returnFocusRef={clearTrigger}
        >
          <p>
            这会清空所有已结束的任务展示记录，包括“已完成”中的记录。待恢复任务和媒体文件会保留。
          </p>
          {clearError && <p role="alert">{clearError}</p>}
          <div className="preparation-actions">
            <button
              ref={clearCancel}
              className="secondary-button"
              disabled={clearing}
              onClick={() => setClearRequested(false)}
            >
              取消
            </button>
            <button
              className="primary-button"
              disabled={clearing || anyRunning}
              onClick={() => void clearRecords()}
            >
              {clearing ? '正在清空…' : '确认清空全部记录'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
