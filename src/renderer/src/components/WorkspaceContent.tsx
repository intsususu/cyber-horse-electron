import { useCallback, useRef, useState } from 'react'
import { CircleHelp, Square } from 'lucide-react'
import { MediaLibrary } from './MediaLibrary'
import { pageNames, type Page } from '../data/catalog'
import type { Workspace } from '../hooks/use-workspace'
import { Workbench } from './Workbench'
import { TaskPanel } from './TaskPanel'
import { LogsPanel } from './LogsPanel'
import { SettingsPage } from './SettingsPage'
import { Modal } from './Modal'
import { PreparationPreview } from './PreparationPreview'
import { PipelinePreview } from './PipelinePreview'
import type { PathKey } from '../../../shared/contracts'
import type { MediaProcessState } from '../../../shared/media-library'

export function WorkspaceContent({
  page,
  workspace,
  navigate,
  settingsTarget,
  libraryVisit,
}: {
  page: Page
  workspace: Workspace
  navigate: (page: Page, path?: PathKey) => void
  settingsTarget?: PathKey
  libraryVisit: number
}) {
  const processingPage = page === 'overview' || page === 'queue'
  const [showDemo, setShowDemo] = useState(false)
  const seenMedia = useRef(
    new Map<string, { serial: number; message: string; finished: boolean }>(),
  )
  const onMediaProcesses = useCallback(
    (processes: MediaProcessState[]) => {
      for (const process of processes) {
        const previous = seenMedia.current.get(process.id)
        const prefix = `媒体库 · ${process.name}：`
        let serial = previous?.serial ?? 0
        for (const entry of process.pipeline?.logs ?? []) {
          if (entry.id <= serial) continue
          workspace.addLog(prefix + entry.text, entry.level, entry.time)
          serial = entry.id
        }
        if (process.message !== previous?.message)
          workspace.addLog(
            prefix + process.message,
            process.status === 'completed'
              ? 'success'
              : process.status === 'failed' || process.status === 'cancelled'
                ? 'warning'
                : 'info',
          )
        const finished = ['completed', 'failed', 'cancelled'].includes(process.status)
        if (finished && !previous?.finished)
          workspace.addLog(prefix + `执行记录：${process.journal}`)
        seenMedia.current.set(process.id, { serial, message: process.message, finished })
      }
    },
    [workspace.addLog],
  )
  return (
    <div className={`page-content page-${page}`}>
      <div className="page-heading">
        <div>
          <h1>{pageNames[page]}</h1>
        </div>
        <div className="heading-actions">
          {processingPage && (
            <button
              className="demo-note"
              title="查看已接入功能与运行方式"
              aria-label="运行说明"
              onClick={() => setShowDemo(true)}
            >
              <CircleHelp size={18} />
              运行说明
            </button>
          )}
          {workspace.running && (
            <button
              className="secondary-button"
              aria-label={
                workspace.run.preparation
                  ? '停止预处理'
                  : workspace.run.pipeline
                    ? '停止处理'
                    : '停止任务'
              }
              disabled={
                workspace.run.preparation?.status === 'cancelling' ||
                workspace.run.pipeline?.status === 'cancelling'
              }
              onClick={workspace.cancel}
            >
              <Square size={15} />
              {workspace.run.preparation?.status === 'cancelling' ? '正在停止…' : '停止'}
            </button>
          )}
        </div>
      </div>

      {page === 'overview' && <Workbench workspace={workspace} navigate={navigate} />}

      {page === 'queue' && (
        <div className="workspace-body queue-layout">
          <TaskPanel workspace={workspace} onMediaProcesses={onMediaProcesses} />
          <LogsPanel logs={workspace.logs} />
        </div>
      )}

      <MediaLibrary key={libraryVisit} active={page === 'library'} workspace={workspace} />
      {page === 'settings' && <SettingsPage workspace={workspace} target={settingsTarget} />}
      {workspace.preparation.plan && (
        <PreparationPreview key={workspace.preparation.plan.id} workspace={workspace} />
      )}
      {workspace.pipeline.plan && (
        <PipelinePreview key={workspace.pipeline.plan.id} workspace={workspace} />
      )}
      {showDemo && (
        <Modal title="运行说明" onClose={() => setShowDemo(false)}>
          <p className="demo-description">
            工作台的独立预处理与四步流程已接入实际处理。运行前检查工具并预览清单，新产物校验成功后直接清理旧文件。停止后请按执行记录核对源目录和输出目录。外部模型和在线服务仍需实机验收。
          </p>
        </Modal>
      )}
    </div>
  )
}
