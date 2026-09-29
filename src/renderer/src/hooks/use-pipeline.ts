import { useCallback, useEffect, useRef, useState, type Dispatch } from 'react'
import type { PipelinePlan, PipelineState, PipelineRequest } from '../../../shared/pipeline'
import type { RunAction } from '../lib/workflow'

const describe = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '处理失败，请重新预览后重试。'
export function usePipeline(
  dispatch: Dispatch<RunAction>,
  notify: (text: string) => void,
  addLog: (text: string, level?: 'info' | 'success' | 'warning') => void,
) {
  const [plan, setPlan] = useState<PipelinePlan | null>(null)
  const [state, setState] = useState<PipelineState | null>(null)
  const [pending, setPending] = useState(!!window.cyberHorse)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const last = useRef('')
  const seenLogs = useRef({ id: '', serial: 0 })
  const trigger = useRef<HTMLElement | null>(null)
  const apply = useCallback(
    (next: PipelineState | null) => {
      if (!next) return
      setState(next)
      dispatch({ type: 'pipeline', state: next })
      if (seenLogs.current.id !== next.id) seenLogs.current = { id: next.id, serial: 0 }
      for (const entry of next.logs) {
        if (entry.id <= seenLogs.current.serial) continue
        addLog(entry.text, entry.level)
        seenLogs.current.serial = entry.id
      }
      const signature = next.id + ':' + next.status
      if (signature === last.current) return
      last.current = signature
      const finished = !['running', 'cancelling'].includes(next.status)
      addLog(
        `处理 · ${next.message}`,
        next.status === 'succeeded' ? 'success' : finished ? 'warning' : 'info',
      )
      if (finished) {
        notify(next.message)
        addLog(`执行记录：${next.journal}`)
      }
    },
    [dispatch, notify, addLog],
  )
  useEffect(() => {
    let active = true
    if (!window.cyberHorse) return
    void window.cyberHorse
      .getPipelineState()
      .then((next) => {
        if (active) apply(next)
      })
      .catch(() => {
        if (active) notify('无法读取处理状态，请重新打开应用后检查。')
      })
      .finally(() => {
        if (active) setPending(false)
      })
    return () => {
      active = false
    }
  }, [apply, notify])
  const running = !!state && ['running', 'cancelling'].includes(state.status)
  useEffect(() => {
    if (!running || !window.cyberHorse) return
    let active = true
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await window.cyberHorse!.getPipelineState()
        if (active) {
          apply(next)
          setError('')
        }
      } catch {
        if (active) setError('暂时无法读取进度，仍在尝试同步。')
      }
      if (active) timer = window.setTimeout(() => void poll(), 700)
    }
    void poll()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [running, apply])
  async function preview(request: PipelineRequest, returnFocus?: HTMLElement | null) {
    if (lock.current || running) return
    if (!window.cyberHorse) {
      notify('处理需要在桌面应用中运行。')
      return
    }
    trigger.current = returnFocus ?? (document.activeElement as HTMLElement | null)
    lock.current = true
    setPending(true)
    setError('')
    try {
      setPlan(await window.cyberHorse.previewPipeline(request))
    } catch (error) {
      notify(describe(error))
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  async function confirm() {
    if (!plan || lock.current || !window.cyberHorse) return
    lock.current = true
    setPending(true)
    setError('')
    try {
      apply(await window.cyberHorse.startPipeline({ planId: plan.id }))
      setPlan(null)
    } catch (error) {
      setError(describe(error))
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  async function cancel() {
    try {
      await window.cyberHorse?.cancelPipeline()
      apply(await window.cyberHorse!.getPipelineState())
    } catch {
      notify('停止请求未送达，请重试；不要手动清理正在处理的文件。')
    }
  }
  return {
    plan,
    state,
    pending,
    error,
    running,
    preview,
    confirm,
    cancel,
    close: () => {
      if (!lock.current) {
        setPlan(null)
        setError('')
        window.requestAnimationFrame(() => trigger.current?.focus())
      }
    },
  }
}
