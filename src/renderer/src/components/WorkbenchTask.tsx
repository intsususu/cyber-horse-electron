import { CircleCheck, ListVideo } from 'lucide-react'
import type { Workspace } from '../hooks/use-workspace'
import { statusNames, type DemoTask } from '../lib/workflow'
import { fileCountLabel, speedLabel, stageLabel } from '../lib/task-progress'

export function WorkbenchTask({ task, workspace }: { task: DemoTask; workspace: Workspace }) {
  const { run } = workspace
  const active = task.status === 'running'
  const pending = task.status === 'pending'
  const percent = task.current ? task.current.percent : task.progress
  const detail = run.preparation ?? run.pipeline
  return (
    <article className={`queue-card task-row ${active ? 'is-running' : ''}`}>
      <div className="queue-card-heading">
        <span className={`task-icon ${task.status}`}>
          <ListVideo size={18} />
        </span>
        <div className="queue-card-title">
          <span className="queue-source">工作台{!detail ? ' · 演示' : ''}</span>
          <strong>{task.title}</strong>
        </div>
        <span className={`task-status ${task.status}`}>
          {task.status === 'succeeded' && <CircleCheck size={14} />}
          {active && detail?.status === 'cancelling' ? '正在停止' : statusNames[task.status]}
        </span>
      </div>
      {!pending && (
        <div className="queue-progress-copy">
          <span>
            {task.current
              ? `${active ? '' : '停止于：'}${stageLabel(task)}`
              : run.preparation
                ? run.preparation.message
                : fileCountLabel(task)}
          </span>
          {task.current && (
            <span>
              {fileCountLabel(task)}
              {active && speedLabel(task.current) && ` · ${speedLabel(task.current)}`}
            </span>
          )}
        </div>
      )}
      {active && (
        <div
          className={`task-progress ${percent === null ? 'indeterminate' : ''}`}
          role="progressbar"
          aria-label={`${task.title}${task.current ? '当前阶段进度' : '文件完成进度'}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={
            task.current ? stageLabel(task) : fileCountLabel(task) || `${task.progress}%`
          }
        >
          <span style={{ width: `${percent ?? 100}%` }} />
        </div>
      )}
      {!pending && (
        <div className="queue-card-meta">
          <span>
            {task.startedAt ? `开始于 ${task.startedAt}` : '尚未开始'}
            {task.endedAt ? ` · 结束于 ${task.endedAt}` : ''}
          </span>
          {run.scope && <span>{run.scope.files.length} 个文件</span>}
        </div>
      )}
      {detail && !pending && (
        <details className="queue-details">
          <summary>处理结果与执行记录</summary>
          {run.scope && (
            <p>
              {run.scope.mode === 'selected' ? '仅选中文件' : '目录全部视频'} · {run.scope.source}
            </p>
          )}
          <p>{detail.message}</p>
          {run.preparation && (
            <p>
              已完成 {run.preparation.completed} / {run.preparation.total}{' '}
              项；清单内的下载残留按执行结果直接删除，中断时请核对已完成项。
            </p>
          )}
          {run.pipeline && (
            <>
              <p>以下为各步骤提交过的位置；后续步骤成功后会清理对应的本地文件。</p>
              {run.pipeline.outputs.map((path) => (
                <p key={path}>输出：{path}</p>
              ))}
            </>
          )}
          <p>执行记录：{detail.journal}</p>
        </details>
      )}
    </article>
  )
}
