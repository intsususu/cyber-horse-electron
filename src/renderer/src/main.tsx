import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'
import './styles/workbench.css'
import './styles/app-statusbar.css'
import './styles/preparation.css'
import './styles/task-queue.css'

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* 不记录可能包含用户路径的完整错误。 */
    // 即使业务界面出错，也显示恢复界面，避免窗口一直隐藏。
    void window.cyberHorse?.windowReady?.().catch(() => {})
  }
  render() {
    if (this.state.failed)
      return (
        <div className="fatal-error">
          <h1>工作台遇到了问题</h1>
          <p>本地配置已保留，请重新加载。</p>
          <button onClick={() => window.location.reload()}>重新加载</button>
        </div>
      )
    return this.props.children
  }
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
