import type { Plugin } from 'vite'

// React 热更新需要开发期内联模块；构建产物保持严格脚本策略。
export function devCsp(): Plugin {
  return {
    name: 'cyber-horse-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
    },
  }
}
