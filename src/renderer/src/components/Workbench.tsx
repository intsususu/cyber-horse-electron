import { ArrowRight, Check, FolderOpen, LoaderCircle, Play, Settings2 } from 'lucide-react'
import type { PathKey, WorkDirectoryKey } from '../../../shared/contracts'
import { pathLabels, workbenchSteps, type Page } from '../data/catalog'
import type { Workspace } from '../hooks/use-workspace'
import { statusNames } from '../lib/workflow'
import { stageLabel, fileCountLabel, speedLabel } from '../lib/task-progress'
import { InputPanel } from './InputPanel'

export function Workbench({
  workspace,
  navigate,
}: {
  workspace: Workspace
  navigate: (page: Page, path?: PathKey) => void
}) {
  const blocked = workspace.running || workspace.starting || workspace.inputs.busy
  const preparation = workspace.run.tasks.find((task) => task.id === 'prepare')
  const prepared = !!workspace.settings.paths.download && !!workspace.settings.paths.preprocess
  const selectedCount = workspace.selectedWorkbenchIds.length
  const allSteps = selectedCount === workbenchSteps.length
  const runLabel = allSteps
    ? '运行全部'
    : selectedCount
      ? `运行所选 ${selectedCount} 步`
      : '请选择步骤'
  async function openWorkDirectory(key: WorkDirectoryKey) {
    if (!window.cyberHorse) {
      workspace.setToast('请在桌面应用中打开工作目录。')
      return
    }
    try {
      await window.cyberHorse.openWorkDirectory(key)
    } catch {
      workspace.setToast('无法打开工作目录，请检查路径或访问权限。')
    }
  }
  return (
    <div className="workspace-body workbench-layout">
      <section className="preparation-bar" aria-label="独立预处理">
        <span className="preparation-icon">
          <FolderOpen size={22} />
        </span>
        <h2>提取清理并重命名</h2>
        <button
          className="secondary-button preparation-run"
          disabled={blocked}
          title={prepared ? '预览提取、清理与重命名清单，确认后执行' : '设置下载目录和预处理目录'}
          aria-label={prepared ? '开始预处理' : '配置预处理目录'}
          onClick={() => (prepared ? void workspace.startPreparation() : navigate('settings'))}
        >
          {preparation?.status === 'running' ? (
            <LoaderCircle className="spin" size={18} />
          ) : prepared ? (
            <Play size={18} />
          ) : (
            <Settings2 size={18} />
          )}
          {preparation?.status === 'running' ? '预处理中' : prepared ? '开始预处理' : '配置预处理'}
        </button>
        {preparation && (
          <span className="preparation-state">
            {preparation.status === 'running'
              ? `${preparation.progress}%`
              : statusNames[preparation.status]}
          </span>
        )}
      </section>
      <section className="workbench-flow" aria-label="后续四步流程">
        <div className="workbench-flow-header">
          <div className="workbench-flow-title">
            <h2>处理流程</h2>
            <span className="flow-selection-count">已选 {selectedCount} / 4 步</span>
            {!allSteps && (
              <button
                className="text-button reset-steps"
                disabled={blocked}
                onClick={workspace.selectAllWorkbenchSteps}
              >
                全选步骤
              </button>
            )}
          </div>
          <button
            className="primary-button"
            disabled={blocked || !workspace.inputs.canRun || !selectedCount}
            aria-label={
              workspace.running
                ? workspace.run.preparation
                  ? '预处理进行中'
                  : workspace.run.pipeline
                    ? '处理进行中'
                    : '演示进行中'
                : workspace.starting
                  ? '正在读取文件'
                  : allSteps
                    ? '运行全部流程'
                    : runLabel
            }
            onClick={() => void workspace.startWorkbench()}
          >
            {workspace.running ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}{' '}
            {workspace.running ? '运行中' : workspace.starting ? '读取中…' : runLabel}
          </button>
        </div>
        <div className="workbench-steps">
          {workbenchSteps.map((step, index) => {
            const task = workspace.run.tasks.find((task) => task.id === step.id)
            const active = task?.status === 'running'
            const included = workspace.selectedWorkbenchIds.includes(step.id)
            const directory = workspace.settings.paths[step.directoryKey]
            return (
              <div className="pipeline-stage" key={step.id}>
                <div
                  className={`workbench-step ${included ? 'included' : 'excluded'} ${active ? 'active' : ''}`}
                >
                  <label className="step-selection" htmlFor={`include-${step.id}`}>
                    <span className="workbench-step-number">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="workbench-step-copy">
                      <strong>{step.title}</strong>
                      {task && (
                        <span
                          className={`workbench-step-status ${task.status}`}
                          aria-label={`${step.title}：${active ? stageLabel(task) : statusNames[task.status]}`}
                          title={active ? speedLabel(task.current) : undefined}
                        >
                          {active ? stageLabel(task) : statusNames[task.status]}
                        </span>
                      )}
                      {task?.total !== undefined && (
                        <span className="workbench-step-status">{fileCountLabel(task)}</span>
                      )}
                    </span>
                  </label>
                  <div className="step-controls">
                    <label className="step-participation">
                      <input
                        id={`include-${step.id}`}
                        type="checkbox"
                        checked={included}
                        disabled={blocked}
                        aria-label={`参与流程：${step.title}`}
                        title={included ? `取消${step.title}` : `选择${step.title}`}
                        onChange={() => workspace.toggleWorkbenchStep(step.id)}
                      />
                      <span className="step-check" aria-hidden="true">
                        <Check size={13} />
                      </span>
                      <span>{included ? '参与流程' : '未参与'}</span>
                    </label>
                    <button
                      className="icon-button step-action"
                      disabled={!directory || !window.cyberHorse}
                      aria-label={`打开${pathLabels[step.directoryKey]}`}
                      title={directory || `请先设置${pathLabels[step.directoryKey]}`}
                      onClick={() => void openWorkDirectory(step.directoryKey)}
                    >
                      <FolderOpen size={18} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {index < workbenchSteps.length - 1 && (
                  <ArrowRight className="pipeline-arrow" size={18} aria-hidden="true" />
                )}
              </div>
            )
          })}
        </div>
      </section>
      <InputPanel workspace={workspace} navigate={navigate} />
    </div>
  )
}
