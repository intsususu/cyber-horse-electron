import { ArrowDown, ArrowUp, Cpu, Gauge, MemoryStick, Network } from 'lucide-react'
import { usePerformance } from '../hooks/use-performance'
import { formatBytes, formatRate } from '../lib/format'
import { Modal } from './Modal'

function Sparkline({
  values,
  secondary,
  percent = false,
}: {
  values: (number | null)[]
  secondary?: (number | null)[]
  percent?: boolean
}) {
  const max = percent
    ? 100
    : Math.max(1, ...values.map((v) => v ?? 0), ...(secondary ?? []).map((v) => v ?? 0))
  const path = (points: (number | null)[]) => {
    let previous = false
    return points
      .map((value, index) => {
        if (value == null) {
          previous = false
          return ''
        }
        const command = previous ? 'L' : 'M'
        previous = true
        return `${command}${(((index + 40 - points.length) / 39) * 160).toFixed(1)},${(32 - (value / max) * 29).toFixed(1)}`
      })
      .join(' ')
  }
  return (
    <svg
      className="metric-chart"
      viewBox="0 0 160 36"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="chart-baseline" d="M0 33H160" />
      <path className="chart-primary" d={path(values)} />
      {secondary && <path className="chart-secondary" d={path(secondary)} />}
    </svg>
  )
}
export function PerformancePanel({ compact = false }: { compact?: boolean }) {
  const { sample, history, failed } = usePerformance()
  const [open, setOpen] = useState(false)
  const unavailable = !window.cyberHorse ? '桌面端可用' : failed ? '采集不可用' : '采样中'
  const percent = (number: number | null | undefined) =>
    number == null ? '—' : `${Math.round(number)}%`
  const state = (value: string | undefined) =>
    value === 'unavailable' ? '计数器不可用' : value === 'loading' ? '采样中' : unavailable
  const details = (
    <section className="performance-grid" aria-label="本机性能仪表盘">
      <article className="panel metric-card" data-metric="cpu" title={sample?.cpu.model}>
        <div className="metric-top">
          <span>
            <Cpu size={17} />
            CPU
          </span>
          <strong>{percent(sample?.cpu.usage)}</strong>
        </div>
        <Sparkline values={history.map((item) => item.cpu.usage)} percent />
        <div className="metric-caption">
          {sample?.cpu.usage == null ? unavailable : `${sample.cpu.cores} 逻辑处理器 · 总使用率`}
        </div>
      </article>
      <article
        className="panel metric-card"
        data-metric="gpu"
        title={sample?.gpu.name || 'Windows GPU 引擎计数器'}
      >
        <div className="metric-top">
          <span>
            <Gauge size={17} />
            GPU
          </span>
          <strong>{percent(sample?.gpu.usage)}</strong>
        </div>
        <Sparkline values={history.map((item) => item.gpu.usage)} percent />
        <div className="metric-caption">
          {sample?.gpu.state === 'ready' ? '最忙引擎 · 全部 GPU' : state(sample?.gpu.state)}
        </div>
      </article>
      <article className="panel metric-card" data-metric="memory">
        <div className="metric-top">
          <span>
            <MemoryStick size={17} />
            内存
          </span>
          <strong>{percent(sample?.memory.usage)}</strong>
        </div>
        <Sparkline values={history.map((item) => item.memory.usage)} percent />
        <div className="metric-caption">
          {sample
            ? `${formatBytes(sample.memory.used)} / ${formatBytes(sample.memory.total)}`
            : unavailable}
        </div>
      </article>
      <article
        className="panel metric-card network-metric"
        data-metric="network"
        title={sample?.network.interfaces.join('、') || '活动网卡合计'}
      >
        <div className="metric-top">
          <span>
            <Network size={17} />
            网络
          </span>
          <span className="metric-live">
            {sample?.network.state === 'ready' ? '实时吞吐' : state(sample?.network.state)}
          </span>
        </div>
        <div className="network-rates">
          <span>
            <ArrowDown size={14} />
            {formatRate(sample?.network.receive)}
          </span>
          <span>
            <ArrowUp size={14} />
            {formatRate(sample?.network.send)}
          </span>
        </div>
        <Sparkline
          values={history.map((item) => item.network.receive)}
          secondary={history.map((item) => item.network.send)}
        />
      </article>
    </section>
  )
  if (!compact) return details
  return (
    <>
      <div className="performance-strip" aria-label="本机性能">
        <button
          title={sample?.cpu.usage == null ? unavailable : sample.cpu.model}
          aria-label="查看 CPU 性能"
          onClick={() => setOpen(true)}
        >
          <Cpu size={21} />
          <span>CPU</span>
          <strong>{percent(sample?.cpu.usage)}</strong>
        </button>
        <button
          title={sample?.gpu.state === 'ready' ? sample.gpu.name : state(sample?.gpu.state)}
          aria-label="查看 GPU 性能"
          onClick={() => setOpen(true)}
        >
          <Gauge size={21} />
          <span>GPU</span>
          <strong>{percent(sample?.gpu.usage)}</strong>
        </button>
        <button
          title={
            sample
              ? `${formatBytes(sample.memory.used)} / ${formatBytes(sample.memory.total)}`
              : unavailable
          }
          aria-label="查看内存性能"
          onClick={() => setOpen(true)}
        >
          <MemoryStick size={21} />
          <span>内存</span>
          <strong>{percent(sample?.memory.usage)}</strong>
        </button>
        <button
          title={
            sample?.network.state === 'ready'
              ? sample.network.interfaces.join('、')
              : state(sample?.network.state)
          }
          aria-label="查看网络性能"
          onClick={() => setOpen(true)}
        >
          <Network size={21} />
          <span>网络</span>
          <strong>
            <ArrowDown size={13} />
            {formatRate(sample?.network.receive)} <ArrowUp size={13} />
            {formatRate(sample?.network.send)}
          </strong>
        </button>
      </div>
      {open && (
        <Modal title="本机性能" className="performance-modal" onClose={() => setOpen(false)}>
          {details}
        </Modal>
      )}
    </>
  )
}
import { useState } from 'react'
