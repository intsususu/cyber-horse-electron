import { useState } from 'react'
import { pipelineNames } from '../../../shared/pipeline'
import type { Workspace } from '../hooks/use-workspace'
import { Modal } from './Modal'

export function PipelinePreview({ workspace }: { workspace: Workspace }) {
  const pipeline = workspace.pipeline
  const plan = pipeline.plan!
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(plan.relatedFiles.length / 50))
  return (
    <Modal title="处理清单" className="preparation-preview" onClose={pipeline.close}>
      <div className="preparation-summary">
        <p>{plan.steps.map((step) => pipelineNames[step]).join(' → ')}</p>
        <p>
          {plan.mode === 'all' ? '目录全部视频' : '仅选中文件'} · {plan.files.length} 个视频
        </p>
        <p>工作目录：{plan.source}</p>
        <p>确认一次后，所选步骤将按上述顺序自动执行；步骤之间无需再次确认。</p>
      </div>
      {plan.warnings.map((warning) => (
        <p className="preparation-warning" key={warning}>
          {warning}
        </p>
      ))}
      <div className="preparation-files" role="region" aria-label="处理文件清单" tabIndex={0}>
        {plan.relatedFiles.slice(page * 50, (page + 1) * 50).map((item) => (
          <div className="preparation-file" key={item.video}>
            <strong>{item.video}</strong>
            {item.files
              .filter((path) => path !== item.video)
              .map((path) => (
                <span key={path}>相关文件：{path}</span>
              ))}
          </div>
        ))}
      </div>
      <div className="preparation-pagination">
        <button className="text-button" disabled={!page} onClick={() => setPage(page - 1)}>
          上一页
        </button>
        <span>
          {page + 1} / {pages}
        </span>
        <button
          className="text-button"
          disabled={page + 1 >= pages}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </div>
      <details className="preparation-details">
        <summary>输出位置与清理规则</summary>
        {plan.destinations.map(({ step, directory }) => (
          <p key={step}>
            {pipelineNames[step]}：{directory}
          </p>
        ))}
        <p>
          新产物校验成功后直接删除被替换的源文件；NAS
          整批归档成功后删除对应本地文件。处理过程只使用配置目录，不保留恢复副本。
        </p>
        <p>
          已检查命令行能力：{plan.tools.join('、') || '归档不需要外部工具'}
          。模型、登录与网络状态将在运行时确认。
        </p>
      </details>
      {pipeline.error && (
        <p className="preparation-error" role="alert">
          {pipeline.error}
        </p>
      )}
      <div className="preparation-actions">
        <button className="secondary-button" disabled={pipeline.pending} onClick={pipeline.close}>
          返回
        </button>
        <button
          className="primary-button"
          disabled={pipeline.pending || !!pipeline.error}
          onClick={() => void pipeline.confirm()}
        >
          {pipeline.pending ? '正在复核…' : '确认运行所选步骤'}
        </button>
      </div>
    </Modal>
  )
}
