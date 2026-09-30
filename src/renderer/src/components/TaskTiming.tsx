import { taskDuration, taskTimestamp } from '../lib/task-time'

type TimingProps = {
  startedAt?: string | null
  endedAt?: string | null
  status: string
  now: number
}

export function TaskDuration({
  startedAt,
  endedAt,
  status,
  now,
  total = false,
}: TimingProps & { total?: boolean }) {
  const start = taskTimestamp(startedAt)
  const end = status === 'interrupted' ? null : taskTimestamp(endedAt)
  const active = status === 'running' || status === 'cancelling'
  if (start === null && ['pending', 'cancelled', 'skipped'].includes(status)) return null
  const duration =
    start !== null && (active || end !== null) ? taskDuration(start, end ?? now) : null
  const label = active ? '已运行' : total ? '总耗时' : '耗时'
  return (
    <span
      className="queue-duration"
      title={duration ? undefined : '未记录完整起止时间，无法计算耗时'}
      aria-label={duration ? undefined : `${label}未记录`}
    >
      {label}：{duration ?? '—'}
    </span>
  )
}

export function TaskTiming({ startedAt, endedAt, status, now }: TimingProps) {
  const start = taskTimestamp(startedAt)
  // 中断历史的结束时间是重新打开应用时的确认时间，不能用于计算执行耗时。
  const end = status === 'interrupted' ? null : taskTimestamp(endedAt)
  const active = status === 'running' || status === 'cancelling'
  const duration =
    start !== null && (active || end !== null) ? taskDuration(start, end ?? now) : null
  const date = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
  return (
    <div className="queue-card-meta queue-timing">
      {start !== null ? (
        <span>
          开始：<time dateTime={startedAt!}>{date(start)}</time>
        </span>
      ) : (
        <span>
          {status === 'pending'
            ? '尚未开始'
            : ['cancelled', 'skipped'].includes(status)
              ? '未执行'
              : '开始时间未记录'}
        </span>
      )}
      {end !== null && (
        <span>
          结束：<time dateTime={endedAt!}>{date(end)}</time>
        </span>
      )}
      {!active && start !== null && end === null && <span>结束时间未记录</span>}
      {(start !== null || !['pending', 'cancelled', 'skipped'].includes(status)) && (
        <span>
          {active ? '已运行' : '耗时'}：{duration ?? '未记录'}
        </span>
      )}
    </div>
  )
}
