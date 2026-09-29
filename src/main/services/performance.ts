import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cpus, freemem, totalmem, type CpuInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { PerformanceSnapshot } from '../../shared/contracts'
import { windowsMetricsScript } from './windows-metrics'

type CpuTimes = { idle: number; total: number }
export function cpuTotals(values: CpuInfo[]): CpuTimes {
  return values.reduce(
    (total, cpu) => ({
      idle: total.idle + cpu.times.idle,
      total: total.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  )
}
export function cpuUsage(previous: CpuTimes, current: CpuTimes): number | null {
  const elapsed = current.total - previous.total
  const idle = current.idle - previous.idle
  return elapsed <= 0 || idle < 0 ? null : Math.max(0, Math.min(100, (1 - idle / elapsed) * 100))
}
const adapterSchema = z.object({
  id: z.string(),
  name: z.string(),
  received: z.number().nonnegative(),
  sent: z.number().nonnegative(),
})
type Adapter = z.infer<typeof adapterSchema>
export function networkRates(previous: Adapter[], current: Adapter[], seconds: number) {
  if (seconds <= 0 || seconds > 15) return null
  const rates = { receive: 0, send: 0 }
  for (const adapter of current) {
    const old = previous.find((item) => item.id === adapter.id)
    if (!old) continue
    rates.receive += Math.max(0, adapter.received - old.received) / seconds
    rates.send += Math.max(0, adapter.sent - old.sent) / seconds
  }
  return rates
}
const sampleSchema = z.object({
  gpu: z.number().min(0).max(100).nullable(),
  gpuState: z.enum(['loading', 'ready', 'unavailable']),
  gpuName: z.string(),
  network: z.array(adapterSchema).max(256),
  networkOk: z.boolean(),
})

export class PerformanceMonitor {
  private worker: ChildProcessWithoutNullStreams | null = null
  private timer: NodeJS.Timeout | null = null
  private previousCpu = cpuTotals(cpus())
  private usage: number | null = null
  private lastRequest = 0
  private startedAt = 0
  private lastWorkerSample = 0
  private previousNetwork: { adapters: Adapter[]; at: number } | null = null
  private gpu: PerformanceSnapshot['gpu'] = {
    usage: null,
    state: 'loading',
    sampledAt: null,
    name: '',
  }
  private network: PerformanceSnapshot['network'] = {
    receive: null,
    send: null,
    state: 'loading',
    sampledAt: null,
    interfaces: [],
  }

  snapshot(): PerformanceSnapshot {
    this.lastRequest = Date.now()
    if (!this.timer) this.start()
    const now = Date.now()
    const total = totalmem()
    const used = total - freemem()
    const processors = cpus()
    const fresh = (at: number | null) => now - (at ?? this.startedAt) < 15000
    return {
      sampledAt: now,
      cpu: { usage: this.usage, model: processors[0]?.model ?? 'CPU', cores: processors.length },
      memory: { used, total, usage: total ? (used / total) * 100 : 0 },
      gpu: fresh(this.gpu.sampledAt)
        ? this.gpu
        : { ...this.gpu, usage: null, state: 'unavailable' },
      network: fresh(this.network.sampledAt)
        ? this.network
        : { ...this.network, receive: null, send: null, state: 'unavailable' },
    }
  }

  private start() {
    this.previousCpu = cpuTotals(cpus())
    this.usage = null
    this.previousNetwork = null
    this.gpu = { usage: null, state: 'loading', sampledAt: null, name: '' }
    this.network = { receive: null, send: null, state: 'loading', sampledAt: null, interfaces: [] }
    const startedAt = Date.now()
    this.startedAt = startedAt
    this.lastWorkerSample = startedAt
    this.timer = setInterval(() => {
      if (Date.now() - this.lastRequest > 10000) {
        this.stop()
        return
      }
      const current = cpuTotals(cpus())
      this.usage = cpuUsage(this.previousCpu, current)
      this.previousCpu = current
      if (Date.now() - startedAt > 15000) {
        if (!this.gpu.sampledAt) this.gpu.state = 'unavailable'
        if (!this.network.sampledAt) this.network.state = 'unavailable'
      }
      if (this.worker && Date.now() - this.lastWorkerSample > 15000) {
        this.worker.kill()
        this.worker = null
        this.unavailable()
      }
      if (process.platform === 'win32' && !this.worker && Date.now() - startedAt > 30000) {
        this.stop()
        this.start()
      }
    }, 2000)
    this.timer.unref()
    if (process.platform !== 'win32') {
      this.unavailable()
      return
    }
    const executable = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const worker = spawn(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(windowsMetricsScript, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: 'pipe', shell: false },
    )
    this.worker = worker
    let buffer = ''
    worker.stdout.setEncoding('utf8')
    worker.stdout.on('data', (data: string) => {
      if (this.worker !== worker) return
      buffer += data
      if (buffer.length > 262144) {
        worker.kill()
        this.unavailable()
        return
      }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        try {
          const sample = sampleSchema.parse(JSON.parse(line))
          const now = Date.now()
          this.lastWorkerSample = now
          this.gpu = {
            usage: sample.gpuState === 'ready' ? sample.gpu : null,
            state: sample.gpuState,
            sampledAt: now,
            name: sample.gpuName,
          }
          const rates =
            sample.networkOk && this.previousNetwork
              ? networkRates(
                  this.previousNetwork.adapters,
                  sample.network,
                  (now - this.previousNetwork.at) / 1000,
                )
              : null
          this.network = {
            receive: rates?.receive ?? null,
            send: rates?.send ?? null,
            state: !sample.networkOk ? 'unavailable' : rates ? 'ready' : 'loading',
            sampledAt: now,
            interfaces: sample.network.map((adapter) => adapter.name),
          }
          this.previousNetwork = sample.networkOk ? { adapters: sample.network, at: now } : null
        } catch {
          this.unavailable()
        }
      }
    })
    worker.stderr.resume()
    worker.on('error', () => this.unavailable())
    worker.on('exit', () => {
      if (this.worker === worker) {
        this.worker = null
        this.unavailable()
      }
    })
  }

  private unavailable() {
    this.gpu = { ...this.gpu, usage: null, state: 'unavailable' }
    this.network = { ...this.network, receive: null, send: null, state: 'unavailable' }
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.worker?.kill()
    this.worker = null
    this.previousNetwork = null
  }
}
