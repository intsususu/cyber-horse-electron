import type { TaskAction, TaskView } from '../../../shared/task-workspace'
import { pipelineNames, type PipelineStep } from '../../../shared/pipeline'
import { FolderOpen } from 'lucide-react'
import { ExecutionRecordLink } from './ExecutionRecordLink'
import { stageLabel, speedLabel } from '../lib/task-progress'
import type { MediaDownload } from '../../../shared/media-library'
import { formatBytes, formatModifiedAt } from '../lib/format'

const stateNames = {
  queued: '等待执行',
  running: '正在执行',
  cancelling: '正在停止',
  interrupted: '中断待确认',
  failed: '失败待处理',
  cancelled: '已取消',
  finalizing: '待收尾',
  completed: '已完成',
  removed: '已移除',
}
const stepNames = {
  pending: '未执行',
  running: '执行中',
  validating: '待校验',
  verified: '已校验',
  skipped: '已跳过',
  failed: '失败',
}
export function workspaceTaskTab(view: TaskView) {
  // 保留内部移除记录以合并关联下载；只有文件收尾成功后才从队列消失。
  const deleted =
    view.task.removalAction === 'delete' ||
    (!view.task.removalAction && view.task.message === '任务内已识别文件已按用户确认永久删除。')
  if (
    deleted &&
    view.task.state === 'removed' &&
    !view.active &&
    !view.recoverable &&
    !view.directory
  )
    return null
  return view.active
    ? 'active'
    : ['completed', 'removed'].includes(view.task.state) && !view.recoverable
      ? 'completed'
      : 'unfinished'
}
export function WorkspaceTaskCard({
  view,
  busy,
  act,
  open,
  cancel,
  download,
}: {
  view: TaskView
  busy: boolean
  act: (id: string, action: TaskAction) => void
  open: (id: string) => void
  cancel: (id: string) => void
  download?: MediaDownload
}) {
  const task = view.task
  const step = task.files
    .flatMap((file) => file.steps)
    .find((value) => ['running', 'validating'].includes(value.state))
  const current = step && view.progress?.[step.id as PipelineStep]
  return (
    <article
      className={`queue-card workspace-task-card ${view.active && task.state !== 'queued' ? 'is-running' : ''}`}
    >
      <div className="queue-card-heading">
        <div className="queue-card-title">
          <span className="queue-source">
            {task.origin === 'media-library' ? '媒体库' : '工作台'} · 独立任务
          </span>
          <strong>{task.context?.media?.name || download?.name || task.name}</strong>
        </div>
        <span className="task-status">
          {task.state === 'completed' && view.directory
            ? view.active
              ? '正在收尾'
              : '待清理'
            : !view.active && view.recoverable && ['queued', 'running'].includes(task.state)
              ? '中断待确认'
              : stateNames[task.state]}
        </span>
        {view.active && (
          <button className="text-button" disabled={busy} onClick={() => cancel(task.id)}>
            取消任务
          </button>
        )}
      </div>
      <p className="queue-progress-copy">{view.diagnostic || task.message}</p>
      {view.active && step && current && (
        <div className="workspace-step-current">
          <p>
            {pipelineNames[step.id as PipelineStep]} ·{' '}
            {stageLabel({ id: step.id as PipelineStep, current } as Parameters<
              typeof stageLabel
            >[0])}
            {speedLabel(current) ? ` · ${speedLabel(current)}` : ''}
          </p>
          <progress
            aria-label={`${pipelineNames[step.id as PipelineStep]}当前阶段进度`}
            max={100}
            value={current.percent ?? undefined}
          />
          <p>
            已完成{' '}
            {
              task.files.filter((file) =>
                ['verified', 'skipped'].includes(
                  file.steps.find((value) => value.id === step.id)!.state,
                ),
              ).length
            }
            /{task.files.length} 个文件
          </p>
        </div>
      )}
      <details className="queue-details">
        <summary>文件、步骤与实际目录</summary>
        {download && (
          <p>
            下载：{formatBytes(download.received)} ·{' '}
            {download.ended ? formatModifiedAt(Date.parse(download.ended)) : '尚未结束'}
          </p>
        )}
        <p className="workspace-task-path">
          任务目录：{view.directory || '已清理；执行记录保存在应用数据目录'}
        </p>
        <p className="workspace-task-path">最终目录：{task.destination.root}</p>
        <ExecutionRecordLink kind="workspace-tasks" id={task.id} path="查看本任务执行记录与日志" />
        <div
          className="workspace-task-files"
          tabIndex={0}
          role="region"
          aria-label="任务文件和步骤"
        >
          {task.files.map((file) => (
            <div key={file.id}>
              <strong>{file.name}</strong>
              <p>
                {file.steps
                  .map(
                    (step) =>
                      `${pipelineNames[step.id as PipelineStep] ?? step.id}：${stepNames[step.state]}`,
                  )
                  .join(' · ')}
              </p>
              {file.publications.map((value) => (
                <p className="workspace-task-path" key={value.target}>
                  {value.state === 'cleaned' ? '已发布' : '发布中'}：{value.target}
                </p>
              ))}
            </div>
          ))}
        </div>
      </details>
      {view.directory && (
        <div className="workspace-task-actions">
          <button className="text-button" disabled={busy} onClick={() => open(task.id)}>
            <FolderOpen size={15} />
            查看任务目录
          </button>
          {view.recoverable && !view.active && (
            <>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => act(task.id, 'resume')}
              >
                {task.context?.sync?.state === 'pending' &&
                task.files.every((file) =>
                  file.publications.every((value) => value.state === 'cleaned'),
                )
                  ? '重试收尾'
                  : '恢复任务'}
              </button>
              <button className="text-button" disabled={busy} onClick={() => act(task.id, 'keep')}>
                结束并保留文件
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => act(task.id, 'delete')}
              >
                永久删除任务文件
              </button>
              {task.state === 'finalizing' && task.context?.sync?.state === 'pending' && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => act(task.id, 'finish')}
                >
                  结束服务器待确认
                </button>
              )}
            </>
          )}
        </div>
      )}
    </article>
  )
}
