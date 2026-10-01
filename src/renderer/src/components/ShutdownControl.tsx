import { useEffect, useRef, useState } from 'react'
import { Power, Timer } from 'lucide-react'
import type { ShutdownRequest, ShutdownState } from '../../../shared/shutdown'
import { Modal } from './Modal'

export function ShutdownControl({
  setToast,
  addLog,
}: {
  setToast: (text: string) => void
  addLog: (text: string) => void
}) {
  const [state, setState] = useState<ShutdownState | null>(null)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ShutdownRequest['mode']>('timer')
  const [minutes, setMinutes] = useState(30)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const phase = useRef<ShutdownState['phase']>('idle')
  useEffect(() => {
    if (!window.cyberHorse?.getShutdownState) return
    let mounted = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await window.cyberHorse!.getShutdownState()
        if (!mounted) return
        setState(next)
        setError((current) => (current === '关机状态读取失败，请重试。' ? '' : current))
        if (
          next.phase !== phase.current &&
          ['countdown', 'failed', 'requested'].includes(next.phase)
        ) {
          setToast(next.message)
          addLog(next.message)
        }
        phase.current = next.phase
      } catch {
        if (mounted) setError('关机状态读取失败，请重试。')
      } finally {
        if (mounted) timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => {
      mounted = false
      clearTimeout(timer)
    }
  }, [addLog, setToast])

  const active = !!state && ['waiting', 'countdown'].includes(state.phase)
  const submitted = !!state && ['executing', 'requested'].includes(state.phase)
  const supported = !!state?.supported
  const seconds = state?.remainingSeconds ?? 0
  const countdown = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  const cancel = async () => {
    if (!window.cyberHorse || pending) return
    setPending(true)
    try {
      const next = await window.cyberHorse.cancelShutdown()
      phase.current = next.phase
      setState(next)
      setToast(next.message)
      addLog(next.message)
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : '取消关机失败，请重试。')
    } finally {
      setPending(false)
    }
  }
  const start = async () => {
    if (!window.cyberHorse || pending) return
    setPending(true)
    setError('')
    try {
      const next = await window.cyberHorse.startShutdown(
        mode === 'timer' ? { mode, minutes } : { mode },
      )
      phase.current = next.phase
      setState(next)
      setToast(next.message)
      addLog(next.message)
      setOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设置关机失败，请重试。')
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <button
        className={`shutdown-button ${active ? 'counting' : ''}`}
        aria-label={
          active ? (state.phase === 'waiting' ? '取消任务结束后关机' : '取消倒计时') : '定时关机'
        }
        title={state?.message ?? '定时关机'}
        disabled={pending || submitted}
        onClick={() => (active ? void cancel() : setOpen(true))}
      >
        <Power size={16} />
        <span>
          {active
            ? state.phase === 'waiting'
              ? '取消任务结束后关机'
              : `取消倒计时 ${countdown}`
            : submitted
              ? '已请求关机'
              : '定时关机'}
        </span>
      </button>
      {open && (
        <Modal title="定时关机" onClose={() => setOpen(false)}>
          <div className="shutdown-modal-icon">
            <Timer size={30} />
          </div>
          <fieldset className="shutdown-modes">
            <legend>关机方式</legend>
            <label>
              <input
                type="radio"
                name="shutdown-mode"
                checked={mode === 'timer'}
                onChange={() => setMode('timer')}
              />
              按时间倒计时
            </label>
            <label>
              <input
                type="radio"
                name="shutdown-mode"
                checked={mode === 'tasks'}
                onChange={() => setMode('tasks')}
              />
              所有任务结束后关机（包含失败）
            </label>
          </fieldset>
          {mode === 'timer' ? (
            <>
              <label className="minutes-field">
                倒计时时长
                <span>
                  <input
                    type="number"
                    min="1"
                    max="720"
                    value={minutes}
                    onChange={(event) => setMinutes(Number(event.target.value))}
                  />
                  分钟
                </span>
              </label>
              <div className="duration-options">
                {[15, 30, 60, 120].map((value) => (
                  <button
                    className={minutes === value ? 'selected' : ''}
                    key={value}
                    onClick={() => setMinutes(value)}
                  >
                    {value} 分钟
                  </button>
                ))}
              </div>
              <p className="shutdown-description">
                任务失败或到时仍有任务执行、待确认，会取消此次关机。
              </p>
            </>
          ) : (
            <p className="shutdown-description">
              等待预处理、工作台流程、媒体库处理和下载全部结束；失败、取消也视为结束。结束后倒计时
              60
              秒，可随时取消。新增任务会继续等待，待确认收尾的任务须先处理。当前无任务时等待下一次任务。
            </p>
          )}
          <p className="shutdown-description">
            仅本次运行有效，关闭应用即取消计划。
            {state?.testMode
              ? '当前使用关机替身，不会执行系统关机。'
              : '开启后将请求 Windows 系统关机，请先保存其他应用中的工作。'}
          </p>
          {!supported && (
            <p className="shutdown-description">
              {window.cyberHorse
                ? '关机能力未就绪或当前系统不支持。'
                : '请在 Windows 桌面应用中使用定时关机。'}
            </p>
          )}
          {error && (
            <p className="shutdown-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="primary-button modal-primary"
            disabled={
              !supported ||
              pending ||
              (mode === 'timer' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 720))
            }
            onClick={() => void start()}
          >
            <Timer size={16} />
            {pending ? '正在设置…' : mode === 'timer' ? '开始倒计时' : '开启任务结束后关机'}
          </button>
        </Modal>
      )}
    </>
  )
}
