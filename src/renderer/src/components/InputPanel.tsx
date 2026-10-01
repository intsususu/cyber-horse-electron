import { useState } from 'react'
import {
  Broom,
  FileVideo,
  Files,
  FolderOpen,
  LoaderCircle,
  MoreVertical,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import type { Workspace } from '../hooks/use-workspace'
import type { Page } from '../data/catalog'
import { formatBytes, formatModifiedAt } from '../lib/format'
import { statusNames } from '../lib/workflow'
import { Modal } from './Modal'

export function InputPanel({
  workspace,
  navigate,
}: {
  workspace: Workspace
  navigate: (page: Page) => void
}) {
  const { inputs, running } = workspace
  const [open, setOpen] = useState(false)
  const [fileMenu, setFileMenu] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const all = inputs.selection?.files ?? []
  const filtered = all.filter((file) =>
    file.relativePath.toLowerCase().includes(query.toLowerCase()),
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50))
  const currentPage = Math.min(page, pageCount - 1)
  const blocked = running || workspace.starting || inputs.busy
  const preparation = workspace.run.tasks.find((task) => task.id === 'prepare')
  const prepared = !!workspace.settings.paths.download && !!workspace.settings.paths.preprocess
  const allSelected = all.length > 0 && inputs.files.length === all.length
  const partiallySelected = inputs.files.length > 0 && !allSelected
  async function openDirectory() {
    if (!window.cyberHorse) {
      workspace.setToast('请在桌面应用中打开工作目录。')
      return
    }
    try {
      await window.cyberHorse.openWorkDirectory(inputs.source)
    } catch {
      workspace.setToast('无法打开工作目录，请检查路径或访问权限。')
    }
  }
  const showFiles = () => {
    setQuery('')
    setPage(0)
    setOpen(true)
  }
  return (
    <>
      <section className="panel input-panel" aria-label="工作目录">
        <div className="input-toolbar">
          <button
            className="icon-button directory-trigger"
            disabled={!inputs.directory || !window.cyberHorse}
            aria-label={inputs.source === 'preprocess' ? '打开预处理目录' : '打开当前工作目录'}
            title={inputs.directory || '请先设置工作目录'}
            onClick={() => void openDirectory()}
          >
            <FolderOpen size={26} aria-hidden="true" />
          </button>
          <button
            className="icon-button preparation-run"
            disabled={blocked}
            title={
              preparation?.status === 'running'
                ? '文件预处理中'
                : prepared
                  ? '文件预处理：提取清理并重命名，预览确认后执行'
                  : '配置预处理：设置下载目录和预处理目录'
            }
            aria-label={prepared ? '文件预处理' : '配置预处理目录'}
            onClick={() => (prepared ? void workspace.startPreparation() : navigate('settings'))}
          >
            {preparation?.status === 'running' ? (
              <LoaderCircle className="spin" size={26} aria-hidden="true" />
            ) : (
              <Broom size={26} aria-hidden="true" />
            )}
          </button>
          <button
            className="icon-button input-refresh"
            disabled={blocked || !inputs.directory}
            title="刷新文件"
            aria-label="刷新"
            onClick={() => void inputs.refresh()}
          >
            <RefreshCw size={26} className={inputs.busy ? 'spin' : ''} aria-hidden="true" />
          </button>
          <label className="subdirectory-option">
            <input
              type="checkbox"
              checked={inputs.recursive}
              disabled={blocked}
              onChange={(event) => void inputs.setRecursive(event.target.checked)}
            />
            含子目录
          </label>
          <div className="scope-switch" role="group" aria-label="处理范围">
            <button
              disabled={blocked}
              aria-pressed={inputs.scope === 'all'}
              onClick={inputs.selectAll}
            >
              目录全部
            </button>
            <button
              disabled={blocked || !all.length}
              aria-pressed={inputs.scope === 'selected'}
              onClick={() => {
                if (inputs.scope === 'all') inputs.clear()
                showFiles()
              }}
            >
              手动选择
            </button>
          </div>
          <button
            className="icon-button"
            disabled={blocked || !all.length}
            title="查看并勾选文件"
            aria-label="查看并勾选文件"
            onClick={showFiles}
          >
            <Search size={21} />
          </button>
        </div>
        {inputs.busy && (
          <div className="input-notice">
            <LoaderCircle className="spin" size={17} />
            正在读取…
          </div>
        )}
        {inputs.error && !inputs.busy && (
          <div className="input-error" role="alert">
            {inputs.error}
            <button
              className="text-button"
              disabled={blocked}
              onClick={() => void inputs.refresh()}
            >
              重试
            </button>
          </div>
        )}
        <div className="input-file-preview" role="region" aria-label="工作台文件清单" tabIndex={0}>
          <div className="input-file-header">
            <label className="input-select-all">
              <input
                type="checkbox"
                aria-label="全选文件"
                title="全选或取消全部文件"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = partiallySelected
                }}
                disabled={blocked || !all.length || !!inputs.error}
                onChange={(event) => (event.target.checked ? inputs.selectAll() : inputs.clear())}
              />
              <span>文件名</span>
            </label>
            <span>文件大小</span>
            <span>最近修改时间</span>
            <span />
          </div>
          {all.slice(0, 100).map((file) => (
            <div className="input-file-row" key={file.path}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`勾选 ${file.relativePath}`}
                  disabled={blocked}
                  checked={inputs.scope === 'all' || inputs.selected.has(file.path)}
                  onChange={() => inputs.toggle(file.path)}
                />
                <FileVideo size={21} />
                <span title={file.path}>{file.relativePath}</span>
              </label>
              <span className="file-size">{formatBytes(file.size)}</span>
              <span className="file-modified">{formatModifiedAt(file.modifiedAt)}</span>
              <button
                className="icon-button"
                disabled={blocked}
                title="文件操作"
                aria-label={`文件操作：${file.relativePath}`}
                onClick={() => setFileMenu(file.path)}
              >
                <MoreVertical size={19} />
              </button>
            </div>
          ))}
          {all.length > 100 && (
            <button className="input-more text-button" onClick={showFiles}>
              查看全部 {all.length} 个文件
            </button>
          )}
          {!all.length && !inputs.busy && !inputs.error && (
            <div className="input-list-empty">
              <Files size={30} />
              <span>{inputs.selection ? '暂无视频' : '选择工作目录'}</span>
              {!inputs.directory && (
                <button className="secondary-button" onClick={() => navigate('settings')}>
                  配置目录
                </button>
              )}
            </div>
          )}
        </div>
        {(inputs.selection || inputs.scope === 'selected') && (
          <div className="input-selection-status" aria-live="polite">
            <span>
              {inputs.scope === 'all'
                ? `${all.length} 个视频`
                : `已选 ${inputs.files.length} / ${all.length} 个`}
              {running ? ' · 运行中' : ''}
            </span>
            {preparation && (
              <span className="preparation-state">
                预处理：
                {preparation.status === 'running'
                  ? `${preparation.progress}%`
                  : statusNames[preparation.status]}
              </span>
            )}
            {inputs.scope === 'selected' && (
              <button className="text-button" disabled={blocked} onClick={inputs.clear}>
                清空选择
              </button>
            )}
          </div>
        )}
      </section>
      {fileMenu && (
        <Modal title="文件操作" onClose={() => setFileMenu(null)}>
          <p className="directory-path">{fileMenu}</p>
          <div className="directory-actions">
            <button
              className="primary-button"
              disabled={blocked}
              onClick={() => {
                inputs.only(fileMenu)
                setFileMenu(null)
              }}
            >
              仅选此文件
            </button>
            <button
              className="secondary-button"
              disabled={blocked}
              onClick={() => {
                inputs.toggle(fileMenu)
                setFileMenu(null)
              }}
            >
              {inputs.scope === 'all' || inputs.selected.has(fileMenu) ? '取消选择' : '选择文件'}
            </button>
          </div>
        </Modal>
      )}
      {open && (
        <Modal title="选择处理文件" className="files-modal" onClose={() => setOpen(false)}>
          <div className="file-search">
            <Search size={18} />
            <input
              aria-label="筛选文件"
              placeholder="搜索文件"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(0)
              }}
            />
            {query && (
              <button className="icon-button" aria-label="清除筛选" onClick={() => setQuery('')}>
                <X size={16} />
              </button>
            )}
          </div>
          <div className="file-selection-toolbar">
            <strong>
              已选 {inputs.files.length} / {all.length} 个
            </strong>
            <button className="text-button" disabled={blocked} onClick={inputs.selectAll}>
              全选全部文件
            </button>
            <button className="text-button" disabled={blocked} onClick={inputs.clear}>
              取消全选
            </button>
          </div>
          <div className="file-selection-list" role="region" aria-label="可选视频文件" tabIndex={0}>
            {filtered.slice(currentPage * 50, (currentPage + 1) * 50).map((file) => (
              <div className="file-selection-row" key={file.path}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`选择文件 ${file.relativePath}`}
                    checked={inputs.scope === 'all' || inputs.selected.has(file.path)}
                    disabled={blocked}
                    onChange={() => inputs.toggle(file.path)}
                  />
                  <span title={file.path}>{file.relativePath}</span>
                </label>
                <small>{formatBytes(file.size)}</small>
                <span className="file-modified">{formatModifiedAt(file.modifiedAt)}</span>
                <button
                  className="text-button"
                  aria-label={`仅选 ${file.relativePath}`}
                  disabled={blocked}
                  onClick={() => inputs.only(file.path)}
                >
                  仅选此项
                </button>
              </div>
            ))}
            {!filtered.length && <p className="file-no-result">没有匹配的文件</p>}
          </div>
          <div className="file-selection-footer">
            <span>
              {currentPage + 1} / {pageCount} 页
            </span>
            <button
              className="text-button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </button>
            <button
              className="text-button"
              disabled={currentPage + 1 >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </button>
            <button className="primary-button" onClick={() => setOpen(false)}>
              完成选择
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
