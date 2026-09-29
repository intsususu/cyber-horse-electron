import { useEffect, useState } from 'react'
import {
  ArrowRight,
  Boxes,
  Check,
  CircleHelp,
  LayoutGrid,
  ListVideo,
  Maximize2,
  Minus,
  Power,
  Settings2,
  Timer,
  X,
} from 'lucide-react'
import type { Page } from './data/catalog'
import { useWorkspace } from './hooks/use-workspace'
import { useMediaQueueSummary } from './hooks/use-media-queue-summary'
import { AppStatusBar } from './components/AppStatusBar'
import { HorseMark } from './components/HorseMark'
import { Modal } from './components/Modal'
import { WorkspaceContent } from './components/WorkspaceContent'
import { ThemePicker } from './components/ThemePicker'
import type { PathKey } from '../../shared/contracts'

const navigation = [
  { id: 'overview', icon: LayoutGrid, label: '工作台' },
  { id: 'library', icon: Boxes, label: 'EMBY媒体库' },
] as const
export default function App() {
  const workspace = useWorkspace()
  const activeMediaTasks = useMediaQueueSummary()
  const activeWorkbenchTasks = workspace.run.tasks.filter((task) =>
    ['pending', 'running'].includes(task.status),
  ).length
  const activeQueueTasks =
    activeMediaTasks === null ? null : activeWorkbenchTasks + activeMediaTasks
  const [page, setPage] = useState<Page>('overview')
  const [libraryVisit, setLibraryVisit] = useState(0)
  const [settingsTarget, setSettingsTarget] = useState<PathKey>()
  const [modal, setModal] = useState<'shutdown' | 'about' | null>(null)
  const [shutdownMinutes, setShutdownMinutes] = useState(30)
  const [shutdownAt, setShutdownAt] = useState<number | null>(null)
  const [remaining, setRemaining] = useState(0)
  const navigate = (next: Page, path?: PathKey) => {
    if (next === 'library') setLibraryVisit((visit) => visit + 1)
    setSettingsTarget(path)
    setPage(next)
    setModal(null)
    document.querySelector('.main-scroll')?.scrollTo({ top: 0 })
  }
  useEffect(() => {
    if (!shutdownAt) return
    const refresh = () => {
      const seconds = Math.max(0, Math.ceil((shutdownAt - Date.now()) / 1000))
      setRemaining(seconds)
      if (seconds === 0) {
        setShutdownAt(null)
        workspace.setToast('倒计时演示结束，未执行系统关机。')
        workspace.addLog('关机倒计时演示结束，未执行系统关机。')
      }
    }
    refresh()
    const interval = window.setInterval(refresh, 1000)
    return () => window.clearInterval(interval)
  }, [shutdownAt, workspace.addLog, workspace.setToast])
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <HorseMark />
          </div>
          <div>
            <strong>CYBER HORSE</strong>
          </div>
        </div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'selected' : ''}`}
              aria-label={item.label}
              title={item.label}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === 'overview' && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <nav aria-label="底部导航">
          <button
            className={`nav-item ${page === 'queue' ? 'selected' : ''}`}
            aria-label="任务队列"
            aria-describedby={activeQueueTasks ? 'queue-active-count' : undefined}
            aria-current={page === 'queue' ? 'page' : undefined}
            title={activeQueueTasks ? `任务队列 · ${activeQueueTasks} 个待处理任务` : '任务队列'}
            onClick={() => navigate('queue')}
          >
            <ListVideo size={19} strokeWidth={1.7} />
            <span>任务队列</span>
            {activeQueueTasks !== null && activeQueueTasks > 0 && (
              <span
                id="queue-active-count"
                className="nav-count"
                aria-label={`${activeQueueTasks} 个待处理任务`}
              >
                {activeQueueTasks}
              </span>
            )}
          </button>
          <button
            className={`nav-item ${page === 'settings' ? 'selected' : ''}`}
            aria-label="偏好配置"
            aria-current={page === 'settings' ? 'page' : undefined}
            title="偏好配置"
            onClick={() => navigate('settings')}
          >
            <Settings2 size={19} strokeWidth={1.7} />
            <span>偏好配置</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`shutdown-button ${shutdownAt ? 'counting' : ''}`}
            aria-label={shutdownAt ? '取消倒计时' : '定时关机'}
            onClick={() => {
              if (shutdownAt) {
                setShutdownAt(null)
                workspace.setToast('已取消倒计时演示。')
              } else setModal('shutdown')
            }}
          >
            <Power size={16} />
            <span>
              {shutdownAt
                ? `取消倒计时 ${Math.floor(remaining / 60)
                    .toString()
                    .padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`
                : '定时关机'}
            </span>
            {!shutdownAt && <span className="mini-label">演示</span>}
          </button>
          <ThemePicker
            compact
            value={workspace.settings.theme}
            disabled={!workspace.loaded}
            onChange={(theme) => void workspace.changeTheme(theme)}
          />
          <div className="sidebar-meta">
            <span>v0.1.0</span>
            <button
              className="icon-button"
              onClick={() => setModal('about')}
              aria-label="关于此版本"
            >
              <CircleHelp size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="titlebar">
          {window.cyberHorse && (
            <div className="window-controls">
              <button
                aria-label="最小化"
                onClick={() => void window.cyberHorse?.windowControl('minimize')}
              >
                <Minus size={15} />
              </button>
              <button
                aria-label="最大化或还原"
                onClick={() => void window.cyberHorse?.windowControl('maximize')}
              >
                <Maximize2 size={13} />
              </button>
              <button
                aria-label="关闭窗口"
                className="window-close"
                onClick={() => void window.cyberHorse?.windowControl('close')}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </header>
        <main className="main-scroll">
          <WorkspaceContent
            page={page}
            workspace={workspace}
            navigate={navigate}
            settingsTarget={settingsTarget}
            libraryVisit={libraryVisit}
          />
        </main>
        <AppStatusBar workspace={workspace} page={page} navigate={navigate} />
      </div>
      {workspace.toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {workspace.toast}
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => workspace.setToast('')}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {modal === 'shutdown' && (
        <Modal title="定时关机演示" onClose={() => setModal(null)}>
          <div className="shutdown-modal-icon">
            <Timer size={30} />
          </div>
          <p className="modal-description">预览倒计时交互。此版本不会执行系统关机。</p>
          <label className="minutes-field">
            倒计时时长
            <span>
              <input
                type="number"
                min="1"
                max="720"
                value={shutdownMinutes}
                onChange={(event) => setShutdownMinutes(Number(event.target.value))}
              />
              分钟
            </span>
          </label>
          <div className="duration-options">
            {[15, 30, 60, 120].map((minutes) => (
              <button
                className={shutdownMinutes === minutes ? 'selected' : ''}
                key={minutes}
                onClick={() => setShutdownMinutes(minutes)}
              >
                {minutes} 分钟
              </button>
            ))}
          </div>
          <button
            className="primary-button modal-primary"
            disabled={
              !Number.isInteger(shutdownMinutes) || shutdownMinutes < 1 || shutdownMinutes > 720
            }
            onClick={() => {
              setShutdownAt(Date.now() + shutdownMinutes * 60_000)
              setRemaining(shutdownMinutes * 60)
              setModal(null)
              workspace.addLog(`已开启 ${shutdownMinutes} 分钟关机倒计时演示。`)
            }}
          >
            <Timer size={16} />
            开始倒计时演示
          </button>
        </Modal>
      )}
      {modal === 'about' && (
        <Modal title="关于 Cyber Horse" onClose={() => setModal(null)}>
          <div className="about-brand">
            <HorseMark />
            <strong>
              CYBER HORSE<span>.</span>
            </strong>
          </div>
          <p className="modal-description">v0.1.0 · Electron 开发预览</p>
          <p className="about-copy">
            媒体处理工作空间。已实现主题、配置与检查、提取清理并重命名，以及工作台的字幕封装、视频处理、元数据刮削与
            NAS 归档。
          </p>
          <div className="info-strip">
            工作台处理前会预览任务；外部模型和在线服务仍需实机验收。定时关机仅提供倒计时演示。
          </div>
          <button
            className="secondary-button modal-primary"
            onClick={() => {
              setModal(null)
              navigate('overview')
            }}
          >
            打开工作台流程
            <ArrowRight size={16} />
          </button>
        </Modal>
      )}
    </div>
  )
}
