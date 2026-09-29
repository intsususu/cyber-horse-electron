import type { MediaDownload, MediaProcessState } from '../../../shared/media-library'
import type { DemoTask } from './workflow'

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
): QueueEntry[] {
  const downloadIds = new Set(processes.map((process) => process.downloadId))
  return [
    ...tasks.map((task): QueueEntry => ({ kind: 'workbench', id: `workbench:${task.id}`, task })),
    ...processes.map((task): QueueEntry => ({ kind: 'process', id: `process:${task.id}`, task })),
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
