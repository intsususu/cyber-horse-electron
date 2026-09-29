import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import type { PathKey } from '../../../shared/contracts'
import type { Page } from '../data/catalog'
import type { Workspace } from '../hooks/use-workspace'
import { EnvironmentCheck } from './EnvironmentCheck'
import { Modal } from './Modal'
import { PerformancePanel } from './PerformancePanel'

export function AppStatusBar({
  workspace,
  page,
  navigate,
}: {
  workspace: Workspace
  page: Page
  navigate: (page: Page, path?: PathKey) => void
}) {
  const [showEnvironment, setShowEnvironment] = useState(false)
  const { checkHealth } = workspace
  useEffect(() => {
    if (page === 'overview') void checkHealth()
  }, [page, checkHealth])
  const problems = workspace.health.filter((item) => item.status !== 'ready').length
  const environmentStatus = workspace.checking
    ? '检测中'
    : workspace.configWarning
      ? '配置异常'
      : workspace.healthStatus === 'failed'
        ? '检测失败'
        : workspace.healthStatus === 'unsupported'
          ? '仅桌面可检测'
          : workspace.healthStatus !== 'complete'
            ? '未验证'
            : problems
              ? `${problems} 项需处理`
              : '路径可用'
  const environmentWarning = Boolean(
    workspace.configWarning || workspace.healthStatus === 'failed' || problems,
  )
  const EnvironmentIcon = workspace.checking
    ? LoaderCircle
    : workspace.healthStatus === 'complete' && !problems
      ? CircleCheck
      : CircleAlert
  return (
    <>
      <footer className="app-statusbar" aria-label="应用状态栏">
        <PerformancePanel compact />
        <button
          className={`tool-summary ${environmentWarning ? 'health-warning' : ''}`}
          onClick={() => setShowEnvironment(true)}
          title="查看工作目录与工具入口检测"
          aria-label={`查看目录与工具检测：${environmentStatus}`}
          aria-haspopup="dialog"
        >
          <EnvironmentIcon size={19} className={workspace.checking ? 'spin' : ''} />
          <span aria-live="polite">{environmentStatus}</span>
        </button>
      </footer>
      {showEnvironment && (
        <Modal
          title="路径与工具检测"
          className="environment-modal"
          onClose={() => setShowEnvironment(false)}
        >
          <EnvironmentCheck
            workspace={workspace}
            configure={(path) => {
              setShowEnvironment(false)
              navigate('settings', path)
            }}
          />
        </Modal>
      )}
    </>
  )
}
