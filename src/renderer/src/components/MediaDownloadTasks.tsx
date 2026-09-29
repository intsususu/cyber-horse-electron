import type { MediaDownload, MediaProcessState } from '../../../shared/media-library'
import type { PipelineTask } from '../../../shared/pipeline'
import { fileCountLabel, speedLabel, stageLabel } from '../lib/task-progress'

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
function ProcessStep({ task }: { task: PipelineTask }) {
  const active = task.status === 'running'
  const percent = active ? task.current?.percent : task.status === 'succeeded' ? 100 : null
  const description = active
    ? task.current
      ? stageLabel(task)
      : '等待工具进度反馈…'
    : task.message
  return (
    <div className="media-process-step">
      <div className="media-process-step-heading">
        <span>{task.title}</span>
        <span>{stepStatus[task.status]}</span>
      </div>
      <p>
        {description}
        {active && speedLabel(task.current) && ` · ${speedLabel(task.current)}`}
      </p>
      <p>{fileCountLabel(task)}</p>
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
        <span>{labels[job.status]}</span>
        <span>
          已下载 {(job.received / 1024 ** 2).toFixed(1)} MiB
          {job.total !== null ? ` / ${(job.total / 1024 ** 2).toFixed(1)} MiB` : ' · 总大小未知'}
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

export function MediaProcessTask({
  job,
  download,
  onError,
}: {
  job: MediaProcessState
  download?: MediaDownload
  onError: (message: string) => void
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
        <span className={`task-status ${job.status}`}>{processStatus[job.status]}</span>
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
      {job.status !== 'pending' && <p className="queue-message">{job.message}</p>}
      {active && download && !job.pipeline && <DownloadProgress job={download} />}
      {current && <ProcessStep task={current} />}
      {job.status !== 'pending' && (
        <details className="queue-details">
          <summary>执行记录位置与步骤详情</summary>
          {download && !active && <DownloadProgress job={download} />}
          {job.pipeline?.tasks
            .filter((task) => task.id !== current?.id)
            .map((task) => (
              <ProcessStep key={task.id} task={task} />
            ))}
          <p>执行记录：{job.journal}</p>
        </details>
      )}
    </article>
  )
}

export function MediaDownloadTask({
  job,
  onError,
}: {
  job: MediaDownload
  onError: (message: string) => void
}) {
  const active = ['running', 'cancelling'].includes(job.status)
  return (
    <article className={`queue-card media-download-task ${active ? 'is-running' : ''}`}>
      <div className="queue-card-heading">
        <div className="queue-card-title">
          <span className="queue-source">媒体库 · 下载</span>
          <strong title={job.name}>{job.name}</strong>
        </div>
        <span className={`task-status ${job.status}`}>{labels[job.status]}</span>
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
      <p className="queue-message">{job.message}</p>
      <details className="queue-details">
        <summary>文件位置与时间</summary>
        <p>{job.status === 'completed' ? job.path : job.temporary}</p>
        <p>
          开始：{new Date(job.started).toLocaleString('zh-CN')}
          {job.ended ? ` · 结束：${new Date(job.ended).toLocaleString('zh-CN')}` : ''}
        </p>
      </details>
    </article>
  )
}
