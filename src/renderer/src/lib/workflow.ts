import type { MediaFile } from '../../../shared/contracts'
import type { PreparationState } from '../../../shared/preparation'
import type { PipelineState, PipelineProgress } from '../../../shared/pipeline'

export type RunScope = { files: MediaFile[]; source: string; mode?: 'all' | 'selected' }
export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'cancelled' | 'failed' | 'skipped'
export type DemoTask = {
  id: string
  title: string
  status: TaskStatus
  progress: number
  current?: PipelineProgress
  completed?: number
  total?: number
  skipped?: number
  startedAt?: string
  endedAt?: string
}
export type RunState = {
  id: number
  tasks: DemoTask[]
  scope?: RunScope
  preparation?: PreparationState
  pipeline?: PipelineState
}
export type RunAction =
  | { type: 'preparation'; state: PreparationState }
  | { type: 'pipeline'; state: PipelineState }
  | {
      type: 'start'
      tasks: { id: string; title: string }[]
      now: string
      id: number
      scope?: RunScope
    }
  | { type: 'tick'; now: string }
  | { type: 'cancel'; now: string }
  | { type: 'clear' }
export const emptyRun: RunState = { id: 0, tasks: [] }
export function isRunning(state: RunState): boolean {
  return (
    !!(state.pipeline && ['running', 'cancelling'].includes(state.pipeline.status)) ||
    state.tasks.some((task) => task.status === 'running')
  )
}
export function runReducer(state: RunState, action: RunAction): RunState {
  if (action.type === 'pipeline') {
    const next = action.state
    if (Date.parse(next.startedAt) < state.id) return state
    return {
      id: Date.parse(next.startedAt),
      pipeline: next,
      scope: { files: next.files, source: next.source, mode: next.mode },
      tasks: next.tasks.map((task) => ({
        ...task,
        startedAt:
          task.startedAt && new Date(task.startedAt).toLocaleTimeString('zh-CN', { hour12: false }),
        endedAt:
          task.endedAt && new Date(task.endedAt).toLocaleTimeString('zh-CN', { hour12: false }),
      })),
    }
  }
  if (action.type === 'preparation') {
    const next = action.state
    if (Date.parse(next.startedAt) < state.id) return state
    const localTime = (value: string) =>
      new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
    return {
      id: Date.parse(next.startedAt),
      preparation: next,
      tasks: [
        {
          id: 'prepare',
          title: '提取清理并重命名',
          status: next.status === 'cancelling' ? 'running' : next.status,
          progress: Math.floor((next.completed / Math.max(1, next.total)) * 100),
          startedAt: localTime(next.startedAt),
          endedAt: next.endedAt ? localTime(next.endedAt) : undefined,
        },
      ],
    }
  }
  if (action.type === 'start') {
    if (isRunning(state) || action.tasks.length === 0) return state
    return {
      id: action.id,
      ...(action.scope
        ? { scope: { ...action.scope, files: action.scope.files.map((file) => ({ ...file })) } }
        : {}),
      tasks: action.tasks.map((task, index) => ({
        ...task,
        status: index === 0 ? 'running' : 'pending',
        progress: 0,
        ...(index === 0 ? { startedAt: action.now } : {}),
      })),
    }
  }
  if (action.type === 'clear') return isRunning(state) ? state : emptyRun
  if (state.preparation || state.pipeline) return state
  if (action.type === 'cancel')
    return {
      ...state,
      tasks: state.tasks.map((task) =>
        task.status === 'running' || task.status === 'pending'
          ? { ...task, status: 'cancelled', endedAt: action.now }
          : task,
      ),
    }
  const active = state.tasks.findIndex((task) => task.status === 'running')
  if (active === -1) return state
  const tasks = state.tasks.map((task) => ({ ...task }))
  const task = tasks[active]!
  task.progress = Math.min(100, task.progress + 10)
  if (task.progress === 100) {
    task.status = 'succeeded'
    task.endedAt = action.now
    const next = tasks[active + 1]
    if (next) {
      next.status = 'running'
      next.startedAt = action.now
    }
  }
  return { ...state, tasks }
}
export const statusNames: Record<TaskStatus, string> = {
  pending: '等待中',
  running: '运行中',
  succeeded: '已完成',
  cancelled: '已取消',
  failed: '失败',
  skipped: '已跳过',
}
