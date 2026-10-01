import { useState, type RefObject } from 'react'
import type { TaskActionPlan } from '../../../shared/task-workspace'
import { Modal } from './Modal'
import { formatBytes } from '../lib/format'
import { pipelineNames, type PipelineStep } from '../../../shared/pipeline'

const titles = {
  resume: '恢复任务预览',
  keep: '结束并保留文件',
  delete: '永久删除任务文件',
  finish: '结束服务器待确认',
}
export function WorkspaceActionModal({
  plan,
  busy,
  error,
  confirm,
  close,
  returnFocusRef,
}: {
  plan: TaskActionPlan
  busy: boolean
  error: string
  confirm: () => void
  close: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  return (
    <Modal
      title={titles[plan.action]}
      onClose={() => {
        if (!busy) close()
      }}
      className="preparation-preview"
      returnFocusRef={returnFocusRef}
    >
      <div className="preparation-summary">
        <p>{plan.name}</p>
        <p className="workspace-task-path">来源：{plan.directory}</p>
        <p className="workspace-task-path">目标：{plan.destination}</p>
      </div>
      {plan.warnings.map((warning) => (
        <p className="preparation-warning" key={warning}>
          {warning}
        </p>
      ))}
      <div className="preparation-files" role="region" aria-label="受影响文件" tabIndex={0}>
        {plan.summary.map((item) => (
          <div className="preparation-file" key={item.sources[0]}>
            <strong>{item.name}</strong>
            {item.sources.map((path) => (
              <span key={path}>原来源：{path}</span>
            ))}
            <span>
              {item.steps
                .map(
                  (step) =>
                    `${pipelineNames[step.id as PipelineStep] ?? step.id}：${{ pending: '未执行', running: '中断待核对', validating: '待校验', verified: '已校验', skipped: '已跳过', failed: '失败' }[step.state]}`,
                )
                .join(' · ')}
            </span>
            {item.published.map((path) => (
              <span key={path}>已发布：{path}</span>
            ))}
          </div>
        ))}
        {plan.files.map((file) => (
          <div className="preparation-file" key={file.path}>
            <strong>
              {formatBytes(file.size)} · {file.disposition}
            </strong>
            <span>{file.path}</span>
          </div>
        ))}
        {!plan.files.length && <p>任务内没有待操作媒体；将核对已发布结果与执行记录。</p>}
      </div>
      {plan.action === 'delete' && (
        <label className="workspace-delete-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            disabled={busy}
          />
          我确认永久删除列出的任务文件，其中可能包含唯一副本
        </label>
      )}
      {error && (
        <p role="alert" className="preparation-error">
          {error}
        </p>
      )}
      <div className="preparation-actions">
        <button className="secondary-button" onClick={close} disabled={busy}>
          暂不处理
        </button>
        <button
          className="primary-button"
          disabled={busy || (plan.action === 'delete' && !acknowledged)}
          onClick={confirm}
        >
          {busy ? '正在复核…' : `确认${titles[plan.action].replace('预览', '')}`}
        </button>
      </div>
    </Modal>
  )
}
