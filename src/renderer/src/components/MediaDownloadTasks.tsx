import type { MediaDownload, MediaProcessState } from '../../../shared/media-library'
import type { PipelineTask } from '../../../shared/pipeline'
import { fileCountLabel, speedLabel, stageLabel } from '../lib/task-progress'
import { TaskDuration, TaskTiming } from './TaskTiming'
import { ExecutionRecordLink } from './ExecutionRecordLink'

const processStatus = {
  pending: '排队中',
  running: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}
const stepStatus = {
  pending: '等待执行',
  running: '处理中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
}
const labels = {
  running: '下载中',
  cancelling: '正在取消',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
  interrupted: '已中断',
}
function ProcessStep({ task, now }: { task: PipelineTask; now: number }) {
  const active = task.status === 'running'
  const percent = active ? task.current?.percent : task.status === 'succeeded' ? 100 : null
  const description = active
    ? task.current
      ? stageLabel(task)
      : '等待工具进度反馈…'
    : ['failed', 'cancelled', 'skipped'].includes(task.status)
      ? task.message
      : ''
  return (
    <div className="media-process-step">
      <div className="media-process-step-heading">
        <span>{task.title}</span>
        <div className="queue-step-meta">
          <TaskDuration
            startedAt={task.startedAt}
            endedAt={task.endedAt}
            status={task.status}
            now={now}
          />
          <span className={`task-status ${task.status}`}>{stepStatus[task.status]}</span>
        </div>
      </div>
      {description && (
        <p>
          {description}
          {active && speedLabel(task.current) && ` · ${speedLabel(task.current)}`}
        </p>
      )}
      {(active || task.total > 1 || !!task.failed || !!task.skipped) && (
        <p>{fileCountLabel(task)}</p>
      )}
      {active && (
        <progress aria-label={`${task.title}当前阶段进度`} value={percent ?? undefined} max={100} />
      )}
    </div>
  )
}
function DownloadProgress({ job }: { job: MediaDownload }) {
  return (
    <div className="queue-download-progress">
      <div className="queue-progress-copy">
        <span>
          已下载 {(job.received / 1024 ** 2).toFixed(1)} MiB
          {job.status !== 'completed' &&
            (job.total !== null ? ` / ${(job.total / 1024 ** 2).toFixed(1)} MiB` : ' · 总大小未知')}
        </span>
      </div>
      {['running', 'cancelling'].includes(job.status) && (
        <progress
          aria-label={`下载进度：${job.name}`}
          value={job.total ? job.received : undefined}
          max={job.total || 1}
        />
      )}
    </div>
  )
}

function DownloadStep({ job, now }: { job: MediaDownload; now: number }) {
  return (
    <div className="media-process-step">
      <div className="media-process-step-heading">
        <span>下载原文件</span>
        <div className="queue-step-meta">
          <TaskDuration startedAt={job.started} endedAt={job.ended} status={job.status} now={now} />
          <span className={`task-status ${job.status}`}>{labels[job.status]}</span>
        </div>
      </div>
      <DownloadProgress job={job} />
      {['failed', 'cancelled', 'interrupted'].includes(job.status) && <p>{job.message}</p>}
    </div>
  )
}

export function MediaProcessTask({
  job,
  download,
  onError,
  now = Date.now(),
}: {
  job: MediaProcessState
  download?: MediaDownload
  onError: (message: string) => void
  now?: number
}) {
  const active = job.status === 'running'
  const current = active ? job.pipeline?.tasks.find((task) => task.status === 'running') : undefined
  return (
    <article className={`queue-card media-download-task ${active ? 'is-running' : ''}`}>
      <div className="queue-card-heading">
        <div className="queue-card-title">
          <span className="queue-source">
            媒体库 · {job.kind === 'subtitle' ? '中文字幕' : '视频破解'}
          </span>
          <strong title={job.name}>{job.name}</strong>
        </div>
        <div className="queue-card-summary">
          <span className={`task-status ${job.status}`}>{processStatus[job.status]}</span>
          <TaskDuration
            startedAt={job.startedAt}
            endedAt={job.endedAt}
            status={job.status}
            now={now}
            total
          />
        </div>
        {['pending', 'running'].includes(job.status) && (
          <button
            className="text-button"
            onClick={() =>
              void window.cyberHorse
                ?.cancelMediaProcess(job.id)
                .catch(() => onError('取消媒体处理失败。'))
            }
          >
            取消媒体处理
          </button>
        )}
      </div>
      {(job.status === 'failed' ||
        job.status === 'cancelled' ||
        (active && !current && !(download && !job.pipeline))) && (
        <p className="queue-message">{job.message}</p>
      )}
      {active && download && !job.pipeline && <DownloadStep job={download} now={now} />}
      {current && <ProcessStep task={current} now={now} />}
      {job.status !== 'pending' && (
        <details className="queue-details">
          <summary>
            {current || (active && download && !job.pipeline) ? '其他步骤与记录' : '步骤详情'}
          </summary>
          <div className="queue-step-list">
            {download && (job.pipeline || !active) && <DownloadStep job={download} now={now} />}
            {job.pipeline?.tasks
              .filter((task) => task.id !== current?.id)
              .map((task) => (
                <ProcessStep key={task.id} task={task} now={now} />
              ))}
          </div>
          <details className="queue-records">
            <summary>起止时间与执行记录</summary>
            <div className="queue-time-record">
              <span>整个任务</span>
              <TaskTiming
                startedAt={job.startedAt}
                endedAt={job.endedAt}
                status={job.status}
                now={now}
              />
            </div>
            {download && (
              <div className="queue-time-record">
                <span>下载原文件</span>
                <TaskTiming
                  startedAt={download.started}
                  endedAt={download.ended}
                  status={download.status}
                  now={now}
                />
              </div>
            )}
            {job.pipeline?.tasks.map((task) => (
              <div className="queue-time-record" key={task.id}>
                <span>{task.title}</span>
                <TaskTiming
                  startedAt={task.startedAt}
                  endedAt={task.endedAt}
                  status={task.status}
                  now={now}
                />
              </div>
            ))}
            {job.status === 'completed' && <p>{job.message}</p>}
            <ExecutionRecordLink kind="media-process" id={job.id} path={job.journal} />
          </details>
        </details>
      )}
    </article>
  )
}

export function MediaDownloadTask({
  job,
  onError,
  now = Date.now(),
}: {
  job: MediaDownload
  onError: (message: string) => void
  now?: number
}) {
  const active = ['running', 'cancelling'].includes(job.status)
  return (
    <article className={`queue-card media-download-task ${active ? 'is-running' : ''}`}>
      <div className="queue-card-heading">
        <div className="queue-card-title">
          <span className="queue-source">媒体库 · 下载</span>
          <strong title={job.name}>{job.name}</strong>
        </div>
        <div className="queue-card-summary">
          <span className={`task-status ${job.status}`}>{labels[job.status]}</span>
          <TaskDuration
            startedAt={job.started}
            endedAt={job.ended}
            status={job.status}
            now={now}
            total
          />
        </div>
        {active && (
          <button
            className="text-button"
            disabled={job.status === 'cancelling'}
            onClick={() =>
              void window.cyberHorse
                ?.cancelMediaDownload(job.id)
                .catch(() => onError('取消下载失败，请重试。'))
            }
          >
            取消下载
          </button>
        )}
      </div>
      <DownloadProgress job={job} />
      {job.status !== 'completed' && <p className="queue-message">{job.message}</p>}
      <details className="queue-details">
        <summary>文件位置与时间</summary>
        <TaskTiming startedAt={job.started} endedAt={job.ended} status={job.status} now={now} />
        {job.status === 'completed' && <p>{job.message}</p>}
        <p>{job.status === 'completed' ? job.path : job.temporary}</p>
      </details>
    </article>
  )
}
