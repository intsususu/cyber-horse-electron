import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ChevronDown, ChevronUp, Terminal } from 'lucide-react'
import type { LogEntry } from '../hooks/use-workspace'

function displayTime(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
    : value
}

export function LogsPanel({ logs }: { logs: LogEntry[] }) {
  const [filter, setFilter] = useState<'all' | 'warning'>('all')
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const visible = logs.filter((log) => filter === 'all' || log.level === 'warning').slice(-30)
  useEffect(() => {
    if (follow.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [logs, filter, expanded])

  function exportLogs() {
    const content = logs
      .map(
        (log) =>
          `[${log.time}] [${log.level === 'success' ? '完成' : log.level === 'warning' ? '提示' : '信息'}] ${log.text}`,
      )
      .join('\n')
    const url = URL.createObjectURL(
      new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'Cyber-Horse-运行日志.txt'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <section className={`panel logs-panel ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <div className="section-header">
        <h2>
          <button
            className="logs-toggle"
            aria-expanded={expanded}
            aria-controls="queue-log-lines"
            aria-label={expanded ? '收起运行日志' : '展开运行日志'}
            onClick={() => {
              follow.current = true
              setExpanded(!expanded)
            }}
          >
            <Terminal size={18} />
            运行日志
            {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        </h2>
        {!expanded && (
          <span className="logs-summary">
            {logs.length} 条日志
            {logs.some((log) => log.level === 'warning')
              ? ` · ${logs.filter((log) => log.level === 'warning').length} 条提示`
              : ''}
          </span>
        )}
        <div className="log-actions">
          {expanded && (
            <select
              aria-label="筛选日志"
              value={filter}
              onChange={(event) => {
                follow.current = true
                setFilter(event.target.value as typeof filter)
              }}
            >
              <option value="all">全部日志</option>
              <option value="warning">仅提示</option>
            </select>
          )}
          <button
            className="icon-button"
            onClick={exportLogs}
            aria-label="导出日志"
            title="导出日志"
          >
            <ArrowDownToLine size={18} />
          </button>
        </div>
      </div>
      <div
        id="queue-log-lines"
        hidden={!expanded}
        ref={scrollRef}
        className="log-lines"
        role="log"
        aria-label="运行日志"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32
        }}
      >
        {visible.map((log) => (
          <div className="log-line" key={log.id}>
            <time title={log.time}>{displayTime(log.time)}</time>
            <span className={`log-level ${log.level}`}>
              {log.level === 'success' ? '完成' : log.level === 'warning' ? '提示' : '信息'}
            </span>
            <span>{log.text}</span>
          </div>
        ))}
        {!visible.length && (
          <p className="log-empty">{filter === 'warning' ? '暂无提示日志' : '暂无运行日志'}</p>
        )}
      </div>
    </section>
  )
}
