import type { MediaDownload, MediaProcessState } from '../../../shared/media-library'
import type { DemoTask } from './workflow'
import type { TaskView } from '../../../shared/task-workspace'

export function workspaceTaskDownload(view: TaskView, downloads: MediaDownload[]) {
  if (view.task.origin !== 'media-library') return undefined
  const linkedId = view.task.context?.media?.downloadId
  if (linkedId) return downloads.find((download) => download.id === linkedId)
  // 兼容旧清单：仅按已登记的完整本地来源路径匹配，不按番号或影片标题猜测。
  const pathKey = (path: string) => path.replace(/\\/g, '/').toLowerCase()
  const candidates = downloads.filter(
    (download) =>
      download.status === 'completed' &&
      download.ended &&
      Date.parse(download.ended) <= Date.parse(view.task.createdAt) &&
      view.task.files.some((file) =>
        file.sources.some(
          (source) =>
            !source.copy &&
            pathKey(source.path) === pathKey(download.path) &&
            source.stamp.size === download.received,
        ),
      ),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

export type QueueTab = 'active' | 'completed' | 'unfinished'
export type QueueEntry =
  | { kind: 'workbench'; id: string; task: DemoTask }
  | { kind: 'process'; id: string; task: MediaProcessState }
  | { kind: 'download'; id: string; task: MediaDownload }

export function queueTab(entry: QueueEntry): QueueTab {
  const status = entry.task.status
  if (['pending', 'running', 'cancelling'].includes(status)) return 'active'
  if (status === 'succeeded' || status === 'completed') return 'completed'
  return 'unfinished'
}

export function buildTaskQueue(
  tasks: DemoTask[],
  downloads: MediaDownload[],
  processes: MediaProcessState[],
  workspaceTasks: TaskView[] = [],
  pipelineId?: string,
): QueueEntry[] {
  const downloadIds = new Set(processes.map((process) => process.downloadId))
  for (const view of workspaceTasks) {
    const download = workspaceTaskDownload(view, downloads)
    if (download) downloadIds.add(download.id)
  }
  const workspaceIds = new Set(workspaceTasks.map((view) => view.task.id))
  return [
    ...(pipelineId && workspaceIds.has(pipelineId) ? [] : tasks).map((task): QueueEntry => ({
      kind: 'workbench',
      id: `workbench:${task.id}`,
      task,
    })),
    ...processes
      .filter((task) => !task.workspaceTaskId || !workspaceIds.has(task.workspaceTaskId))
      .map((task): QueueEntry => ({ kind: 'process', id: `process:${task.id}`, task })),
    ...downloads
      .filter((task) => !downloadIds.has(task.id))
      .map((task): QueueEntry => ({ kind: 'download', id: `download:${task.id}`, task })),
  ]
}

export function queueGroups(entries: QueueEntry[], tab: QueueTab) {
  const selected = entries.filter((entry) => queueTab(entry) === tab)
  if (tab !== 'active')
    return [{ title: tab === 'completed' ? '已完成任务' : '失败、取消与跳过', entries: selected }]
  return [
    { title: '正在执行', entries: selected.filter((entry) => entry.task.status !== 'pending') },
    { title: '等待执行', entries: selected.filter((entry) => entry.task.status === 'pending') },
  ].filter((group) => group.entries.length)
}
