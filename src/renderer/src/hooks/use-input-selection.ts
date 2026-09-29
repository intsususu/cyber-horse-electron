import { useEffect, useMemo, useRef, useState } from 'react'
import type { InputSelection } from '../../../shared/contracts'

export function useInputSelection(
  notify: (message: string) => void,
  preprocess: string,
  loaded: boolean,
  locked: boolean,
) {
  const [selection, setSelection] = useState<InputSelection | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<'all' | 'selected'>('all')
  const [source, setSource] = useState<'preprocess' | 'current'>('preprocess')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recursive, updateRecursive] = useState(true)
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const busyRef = useRef(false)
  const loadedDefault = useRef<string | null>(null)
  const pendingScrapeFiles = useRef<string[] | null>(null)
  const taskRefreshPending = useRef(false)
  const files = useMemo(
    () => selection?.files.filter((file) => scope === 'all' || selected.has(file.path)) ?? [],
    [selection, selected, scope],
  )
  const directory = source === 'preprocess' ? preprocess : (selection?.directory ?? '')

  function reportError(cause: unknown) {
    const message =
      cause instanceof Error
        ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
        : ''
    const readable =
      message && /[\u4e00-\u9fff]/.test(message) ? message : '文件读取失败，请检查路径或访问权限。'
    setError(readable)
    notify(readable)
  }
  function apply(result: InputSelection, reset: boolean) {
    setSelection(result)
    setError('')
    setSelected(
      new Set(
        result.files
          .filter((file) => reset || scope === 'all' || selected.has(file.path))
          .map((file) => file.path),
      ),
    )
    if (reset) setScope('all')
    if (result.skipped) notify(`${result.skipped} 项无法读取或为链接，已跳过。`)
  }
  async function read(reset = false, value = recursive, target = source, duringRun = false) {
    if (busyRef.current || (locked && !duringRun)) return null
    if (!window.cyberHorse) {
      setError('请在桌面应用中读取工作目录。')
      return null
    }
    busyRef.current = true
    setBusy(true)
    try {
      const result = await window.cyberHorse.refreshInputs({ source: target, recursive: value })
      apply(result, reset)
      updateRecursive(value)
      return result
    } catch (cause) {
      reportError(cause)
      return null
    } finally {
      busyRef.current = false
      setBusy(false)
      if (taskRefreshPending.current) queueMicrotask(() => void refreshAfterTask())
    }
  }
  async function refreshAfterTask() {
    if (!directory) return
    taskRefreshPending.current = true
    if (busyRef.current) return
    taskRefreshPending.current = false
    await read(false, recursive, source, true)
  }
  useEffect(() => {
    if (
      !loaded ||
      locked ||
      busy ||
      source !== 'preprocess' ||
      loadedDefault.current === preprocess
    )
      return
    loadedDefault.current = preprocess
    setSelection(null)
    setSelected(new Set())
    setScope('all')
    setError('')
    if (preprocess)
      void (async () => {
        const result = await read(true, recursive, 'preprocess')
        const produced = pendingScrapeFiles.current
        pendingScrapeFiles.current = null
        if (result && produced) {
          const paths = new Set(produced)
          setScope('selected')
          setSelected(
            new Set(result.files.filter((file) => paths.has(file.path)).map((file) => file.path)),
          )
        }
      })()
  }, [preprocess, loaded, locked, busy, source, refreshEpoch])

  async function chooseDirectory() {
    if (busyRef.current || locked) return
    if (!window.cyberHorse) {
      notify('请在桌面应用中选择工作目录。')
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      const result = await window.cyberHorse.chooseInputs({ mode: 'directory', recursive })
      if (!result) return
      setSource('current')
      apply(result, true)
    } catch (cause) {
      reportError(cause)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  function useDefault() {
    if (busyRef.current || locked) return
    loadedDefault.current = null
    setSource('preprocess')
  }
  function followScrapeResult(paths: string[]) {
    if (busyRef.current || locked) return
    pendingScrapeFiles.current = scope === 'selected' ? paths : null
    loadedDefault.current = null
    setSource('preprocess')
    setRefreshEpoch((current) => current + 1)
  }
  function toggle(path: string) {
    if (busyRef.current || locked) return
    setScope('selected')
    setSelected((current) => {
      const next = new Set(scope === 'all' ? selection?.files.map((file) => file.path) : current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  function selectAll() {
    if (busyRef.current || locked) return
    setScope('all')
    setSelected(new Set(selection?.files.map((file) => file.path) ?? []))
  }
  function selectOnly(paths: string[]) {
    if (busyRef.current || locked) return
    setScope('selected')
    setSelected(new Set(paths))
  }
  async function setRecursive(value: boolean) {
    if (busyRef.current || locked) return
    const previous = recursive
    updateRecursive(value)
    if (directory && !(await read(false, value))) updateRecursive(previous)
  }
  async function prepareRun() {
    if (!directory || (scope === 'selected' && !selected.size)) {
      notify('请先设置工作目录或选择要处理的视频文件。')
      return null
    }
    const result = await read()
    if (!result) return null
    const current = result.files.filter((file) => scope === 'all' || selected.has(file.path))
    if (scope === 'selected' && current.length !== selected.size) {
      notify('部分选中文件已不在工作目录中，已更新清单，请确认范围后重新运行。')
      return null
    }
    if (!current.length) {
      notify('当前范围没有支持的视频文件，未启动任务。')
      return null
    }
    return { files: current, source: result.directory!, mode: scope }
  }
  return {
    selection,
    selected,
    files,
    scope,
    source,
    directory,
    busy,
    error,
    recursive,
    canRun: loaded && !!directory && !error && (scope === 'all' || files.length > 0),
    chooseDirectory,
    useDefault,
    followScrapeResult,
    toggle,
    selectAll,
    prepareRun,
    refresh: () => read(),
    refreshAfterTask,
    setRecursive,
    clear: () => selectOnly([]),
    only: (path: string) => selectOnly([path]),
  }
}
