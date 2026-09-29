import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  FolderOpen,
  LoaderCircle,
  RotateCw,
  Wrench,
} from 'lucide-react'
import { pathKeys, toolKeys, type PathKey } from '../../../shared/contracts'
import { pathLabels } from '../data/catalog'
import type { Workspace } from '../hooks/use-workspace'

const groups = [
  { title: '工作目录', keys: pathKeys.filter((key) => !toolKeys.includes(key)), icon: FolderOpen },
  { title: '工具入口', keys: toolKeys, icon: Wrench },
]

export function EnvironmentCheck({
  workspace,
  configure,
}: {
  workspace: Workspace
  configure: (path?: PathKey) => void
}) {
  const pending = workspace.healthStatus === 'idle' || workspace.checking
  const complete = workspace.healthStatus === 'complete'
  const problems = workspace.health.filter((item) => item.status !== 'ready')
  const summary = pending
    ? '正在检测…'
    : workspace.healthStatus === 'unsupported'
      ? '仅桌面可检测'
      : !complete
        ? '检测未完成'
        : problems.length
          ? `${problems.length} 项待处理`
          : '路径检查通过'
  const StatusIcon = pending
    ? LoaderCircle
    : complete && !problems.length
      ? CircleCheck
      : CircleAlert
  return (
    <section
      className="environment-check"
      aria-label="环境检测"
      data-state={workspace.healthStatus}
    >
      <div className="environment-check-heading">
        <StatusIcon
          size={21}
          className={
            pending ? 'spin' : problems.length || !complete ? 'health-warning' : 'health-ready'
          }
          aria-hidden="true"
        />
        <div>
          <h2>环境检测</h2>
          <p aria-live="polite" aria-atomic="true">
            {summary}
          </p>
        </div>
      </div>
      {groups.map(({ title, keys, icon: Icon }) => {
        const items = workspace.health.filter((item) => keys.includes(item.key))
        const issues = items.filter((item) => item.status !== 'ready')
        // 已配置但不可访问的路径优先于空配置，便于先修复失效的环境。
        const first = issues.find((item) => item.status !== 'unconfigured') ?? issues[0]
        const target = first?.key ?? keys[0]
        const detail = pending
          ? '正在检查已保存路径'
          : !complete
            ? '打开配置查看路径'
            : first
              ? `${pathLabels[first.key]} · ${first.message}`
              : `${items.length} 项路径可读取`
        const state = pending
          ? '检测中'
          : !complete
            ? '未验证'
            : issues.length
              ? `${issues.length} 项需处理`
              : '已通过'
        return (
          <button
            key={title}
            className="environment-check-group"
            onClick={() => configure(target)}
            title={`${detail}；点击前往配置`}
            aria-label={`${title}检测：${state}，前往${pathLabels[target!]}配置`}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="environment-check-copy">
              <span>
                <strong>{title}</strong>
                <span
                  className={complete ? (issues.length ? 'health-warning' : 'health-ready') : ''}
                >
                  {state}
                </span>
              </span>
              <small>{detail}</small>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
        )
      })}
      <button
        className="icon-button environment-recheck"
        disabled={pending || workspace.healthStatus === 'unsupported'}
        aria-label="重新检测环境"
        title="重新检测目录与工具入口"
        onClick={() => void workspace.checkHealth()}
      >
        <RotateCw size={18} className={pending ? 'spin' : ''} />
      </button>
      <div className="environment-check-note">
        {workspace.configWarning ? (
          <button
            className="text-button health-warning"
            onClick={() => configure()}
            title={workspace.configWarning}
          >
            配置文件读取异常，前往配置修复 <ArrowUpRight size={14} />
          </button>
        ) : workspace.healthError ? (
          <span className="health-warning" aria-live="polite">
            {workspace.healthError}
          </span>
        ) : (
          <span>检查已保存路径的类型与读取权限；工具运行环境尚未验证。</span>
        )}
      </div>
    </section>
  )
}
