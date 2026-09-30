import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  defaultSettings,
  parseStoredSettings,
  settingsSchema,
  type Settings,
  type SettingsResult,
  type Theme,
} from '../../../shared/contracts'
import { emptyRun, isRunning, runReducer } from '../lib/workflow'
import { useInputSelection } from './use-input-selection'
import { useEnvironmentHealth } from './use-environment-health'
import { usePreparation } from './use-preparation'
import { usePipeline } from './use-pipeline'
import type { PipelineStep } from '../../../shared/pipeline'
import { workbenchSteps } from '../data/catalog'

export type LogEntry = {
  id: number
  time: string
  level: 'info' | 'success' | 'warning'
  text: string
}
const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })
export function useWorkspace() {
  const [settings, setSettings] = useState<Settings>(structuredClone(defaultSettings))
  const [loaded, setLoaded] = useState(false)
  const [configWarning, setConfigWarning] = useState('')
  const environment = useEnvironmentHealth(settings.paths, loaded)
  const [toast, setToast] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: 0, time: time(), level: 'info', text: '应用已启动，等待运行。' },
  ])
  const [run, dispatch] = useReducer(runReducer, emptyRun)
  const running = isRunning(run)
  const [starting, setStarting] = useState(false)
  const [selectedWorkbenchIds, setSelectedWorkbenchIds] = useState<string[]>(() =>
    workbenchSteps.map((step) => step.id),
  )
  const startingRef = useRef(false)
  const runningRef = useRef(false)
  const sequence = useRef(0)
  const latestSettings = useRef(settings)
  const settingsQueue = useRef<Promise<void>>(Promise.resolve())
  const addLog = useCallback(
    (text: string, level: LogEntry['level'] = 'info', loggedAt = time()) => {
      setLogs((current) => [
        ...current.slice(-199),
        { id: ++sequence.current, time: loggedAt, level, text },
      ])
    },
    [],
  )
  const preparation = usePreparation(dispatch, setToast, addLog)
  const pipeline = usePipeline(dispatch, setToast, addLog)
  const inputs = useInputSelection(
    setToast,
    settings.paths.preprocess,
    loaded,
    running ||
      starting ||
      preparation.pending ||
      !!preparation.plan ||
      pipeline.pending ||
      !!pipeline.plan,
  )
  const refreshedPreparation = useRef('')
  const observedTaskCounts = useRef<{ id: string; counts: Record<string, number> } | null>(null)
  useEffect(() => {
    const result = run.pipeline
    if (!result) return
    const previous =
      observedTaskCounts.current?.id === result.id ? observedTaskCounts.current.counts : {}
    const counts = Object.fromEntries(result.tasks.map((task) => [task.id, task.completed]))
    observedTaskCounts.current = { id: result.id, counts }
    if (
      (result.status === 'running' || result.status === 'cancelling') &&
      result.tasks.some((task) => task.completed > (previous[task.id] ?? 0))
    )
      void inputs.refreshAfterTask()
  }, [run.pipeline, inputs])
  useEffect(() => {
    const result = run.preparation ?? run.pipeline
    if (
      !result?.endedAt ||
      result.id === refreshedPreparation.current ||
      running ||
      starting ||
      preparation.pending ||
      inputs.busy
    )
      return
    refreshedPreparation.current = result.id
    if (
      result === run.pipeline &&
      result.tasks.find((task) => task.id === 'scrape')?.completed &&
      result.tasks.at(-1)?.id === 'scrape'
    )
      inputs.followScrapeResult(
        result.resultFiles.filter(
          (path) => !result.failures?.some((failure) => failure.file === path),
        ),
      )
    else if (inputs.directory) void inputs.refresh()
  }, [run.preparation, run.pipeline, running, starting, preparation.pending, inputs])
  useEffect(() => {
    let active = true
    let revision = 0
    const apply = (result: SettingsResult) => {
      if (!active) return
      latestSettings.current = result.settings
      setSettings(result.settings)
      setConfigWarning(result.warning ?? '')
      setLoaded(true)
      if (result.warning) setToast(result.warning)
    }
    const unsubscribe = window.cyberHorse?.onSettingsChanged((result) => {
      ++revision
      apply(result)
    })
    async function load() {
      const requestRevision = ++revision
      try {
        if (window.cyberHorse) {
          const result = await window.cyberHorse.getSettings()
          if (requestRevision === revision) apply(result)
        } else {
          const raw = localStorage.getItem('cyber-horse-preview')
          if (raw) {
            const migrated = parseStoredSettings(JSON.parse(raw))
            apply({ settings: migrated })
            localStorage.setItem('cyber-horse-preview', JSON.stringify(migrated))
          }
        }
      } catch {
        if (active && requestRevision === revision) {
          setConfigWarning('配置读取失败，当前显示内容可能未同步；请重新进入窗口重试。')
          setToast('配置读取失败，请重新进入窗口重试。')
        }
      } finally {
        if (active && requestRevision === revision) setLoaded(true)
      }
    }
    const refresh = () => {
      if (window.cyberHorse) void load()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    // 开发热更新、窗口后台停留或错过推送后，以磁盘配置重新校准。
    // 配置页自行合并变化字段，不覆盖未变化字段的表单草稿。
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    void load()
    return () => {
      active = false
      ++revision
      unsubscribe?.()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      document.documentElement.dataset.theme =
        settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [settings.theme])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4500)
    return () => window.clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    runningRef.current = running
  }, [running])
  async function saveSettings(next: Settings) {
    const validated = settingsSchema.parse(next)
    const operation = settingsQueue.current
      .catch(() => {})
      .then(async () => {
        if (window.cyberHorse) await window.cyberHorse.saveSettings(validated)
        else localStorage.setItem('cyber-horse-preview', JSON.stringify(validated))
        latestSettings.current = validated
        setSettings(validated)
      })
    settingsQueue.current = operation
    return operation
  }
  async function updateSettings(change: (current: Settings) => Settings, allowInvalidFile = false) {
    const operation = settingsQueue.current
      .catch(() => {})
      .then(async () => {
        const current = window.cyberHorse
          ? await window.cyberHorse.getSettings()
          : { settings: latestSettings.current }
        if (current.warning && !allowInvalidFile) throw new Error(current.warning)
        const validated = settingsSchema.parse(change(current.settings))
        if (window.cyberHorse) await window.cyberHorse.saveSettings(validated)
        else localStorage.setItem('cyber-horse-preview', JSON.stringify(validated))
        latestSettings.current = validated
        setSettings(validated)
        setConfigWarning('')
      })
    settingsQueue.current = operation
    return operation
  }
  async function changeTheme(theme: Theme) {
    try {
      await updateSettings((current) => ({ ...current, theme }))
    } catch {
      setToast('主题保存失败，请检查配置文件内容和应用数据目录权限。')
    }
  }
  function toggleWorkbenchStep(id: string) {
    if (
      runningRef.current ||
      startingRef.current ||
      inputs.busy ||
      pipeline.pending ||
      pipeline.plan ||
      preparation.pending ||
      preparation.plan
    )
      return
    if (!workbenchSteps.some((step) => step.id === id)) return
    setSelectedWorkbenchIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }
  function selectAllWorkbenchSteps() {
    if (
      runningRef.current ||
      startingRef.current ||
      inputs.busy ||
      pipeline.pending ||
      pipeline.plan ||
      preparation.pending ||
      preparation.plan
    )
      return
    setSelectedWorkbenchIds(workbenchSteps.map((step) => step.id))
  }
  async function startWorkbench(steps: string[] = selectedWorkbenchIds) {
    if (
      runningRef.current ||
      startingRef.current ||
      inputs.busy ||
      preparation.pending ||
      preparation.plan ||
      pipeline.pending ||
      pipeline.plan
    )
      return
    // 按固定顺序冻结步骤；不因用户勾选顺序改变执行顺序，也不补入未选步骤。
    const tasks = workbenchSteps.filter((step) => steps.includes(step.id))
    if (!tasks.length) {
      setToast('请至少选择一个处理步骤。')
      return
    }
    const returnFocus = document.activeElement as HTMLElement | null
    startingRef.current = true
    setStarting(true)
    try {
      const scope = await inputs.prepareRun()
      if (scope)
        await pipeline.preview(
          {
            steps: tasks.map((task) => task.id as PipelineStep),
            source: inputs.source,
            recursive: inputs.recursive,
            selection:
              scope.mode === 'all'
                ? { mode: 'all' }
                : { mode: 'selected', relativePaths: scope.files.map((file) => file.relativePath) },
          },
          returnFocus,
        )
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }
  async function startPreparation() {
    if (
      runningRef.current ||
      startingRef.current ||
      inputs.busy ||
      preparation.pending ||
      preparation.plan ||
      pipeline.pending ||
      pipeline.plan
    )
      return
    if (!settings.paths.download || !settings.paths.preprocess || !window.cyberHorse) {
      setToast('请在桌面应用中配置并保存下载目录和预处理目录。')
      return
    }
    await preparation.preview()
  }
  function cancel() {
    if (run.pipeline) {
      void pipeline.cancel()
      return
    }
    if (run.preparation) {
      void preparation.cancel()
      return
    }
  }
  return {
    configWarning,
    settings,
    inputs,
    starting:
      starting || preparation.pending || !!preparation.plan || pipeline.pending || !!pipeline.plan,
    preparation,
    pipeline,
    startPreparation,
    startWorkbench,
    selectedWorkbenchIds,
    toggleWorkbenchStep,
    selectAllWorkbenchSteps,
    loaded,
    saveSettings,
    updateSettings,
    changeTheme,
    ...environment,
    toast,
    setToast,
    logs,
    setLogs,
    run,
    dispatch,
    running,
    cancel,
    addLog,
  }
}
export type Workspace = ReturnType<typeof useWorkspace>
