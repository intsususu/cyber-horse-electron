import { useState } from 'react'
import { Modal } from './Modal'
import type { Workspace } from '../hooks/use-workspace'
import { formatBytes } from '../lib/format'

const actionNames = { extract: '提取', rename: '重命名', cleanup: '删除残留' }
export function PreparationPreview({ workspace }: { workspace: Workspace }) {
  const preparation = workspace.preparation
  const plan = preparation.plan!
  const [page, setPage] = useState(0)
  const total = plan.items.length + plan.cleanupDirectories.length
  const pages = Math.max(1, Math.ceil(total / 50))
  return (
    <Modal title="预处理清单" className="preparation-preview" onClose={preparation.close}>
      <div className="preparation-summary">
        <p>提取下载目录中至少 1 GiB 的文件，规范视频编号；同时整理预处理目录顶层的视频名称。</p>
        <p>
          大文件和已有视频直接移动；清单内的小视频、字幕及其他下载残留将直接删除，不保留副本。文件处理完成后，仅移除清单中的空文件夹。
        </p>
        <p className="preparation-counts">
          {Object.entries(actionNames)
            .map(
              ([action, label]) =>
                `${label} ${plan.items.filter((item) => item.action === action).length} 项`,
            )
            .join(' · ')}
          {` · 清理空文件夹 ${plan.cleanupDirectories.length} 项`}
        </p>
      </div>
      {plan.warnings.map((warning) => (
        <p className="preparation-warning" key={warning}>
          {warning}
        </p>
      ))}
      <div className="preparation-files" role="region" aria-label="预处理文件清单" tabIndex={0}>
        {plan.items.slice(page * 50, (page + 1) * 50).map((item) => (
          <div className="preparation-file" key={item.id}>
            <strong>
              {actionNames[item.action]} · {formatBytes(item.size)}
            </strong>
            <span>来源：{item.source}</span>
            <span>{item.target ? `输出：${item.target}` : '直接删除，不保留副本'}</span>
            {item.note && <small>{item.note}</small>}
          </div>
        ))}
        {plan.cleanupDirectories
          .slice(
            Math.max(0, page * 50 - plan.items.length),
            Math.max(0, (page + 1) * 50 - plan.items.length),
          )
          .map((path) => (
            <div className="preparation-file" key={path}>
              <strong>清理空文件夹</strong>
              <span>目录：{path}</span>
              <small>处理完成后仅在文件夹为空时移除；新出现的文件会保留。</small>
            </div>
          ))}
        {!total && <p>没有需要处理的文件或文件夹。</p>}
      </div>
      <div className="preparation-pagination">
        <button className="text-button" disabled={page === 0} onClick={() => setPage(page - 1)}>
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
        <summary>执行说明</summary>
        <p>
          所有操作仅限清单内的文件。大文件移动成功后才删除下载残留；中断时已完成操作保留，尚未处理的文件留在原处。
        </p>
      </details>
      {preparation.error && (
        <p className="preparation-error" role="alert">
          {preparation.error}
        </p>
      )}
      <div className="preparation-actions">
        <button
          className="secondary-button"
          disabled={preparation.pending}
          onClick={preparation.close}
        >
          返回
        </button>
        <button
          className="primary-button"
          disabled={preparation.pending || !total || !!preparation.error}
          onClick={() => void preparation.confirm()}
        >
          {preparation.pending ? '正在复核…' : '确认执行预处理'}
        </button>
      </div>
    </Modal>
  )
}
