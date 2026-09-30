import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { ExecutionRecordRequest } from '../../../shared/execution-record'
import { openExecutionRecord } from '../lib/execution-record'

export function ExecutionRecordLink({ kind, id, path }: ExecutionRecordRequest & { path: string }) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const open = async () => {
    if (opening) return
    setOpening(true)
    setError('')
    try {
      await openExecutionRecord(window.cyberHorse, { kind, id })
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : ''
      setError(message || '无法打开执行记录，请稍后重试。')
    } finally {
      setOpening(false)
    }
  }
  return (
    <div className="execution-record-link">
      <span>执行记录：</span>
      <button
        className="text-button"
        title="打开包含本任务执行日志的文本记录"
        aria-label="打开执行记录与日志"
        disabled={opening}
        onClick={() => void open()}
      >
        <span>{opening ? '正在打开…' : path}</span>
        <ExternalLink size={14} aria-hidden="true" />
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
