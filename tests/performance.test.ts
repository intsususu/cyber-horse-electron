import { describe, expect, it } from 'vitest'
import { cpuUsage, networkRates } from '../src/main/services/performance'

describe('真实性能采样的差值计算', () => {
  it('CPU 使用率基于两个采样间的总时间和空闲时间', () => {
    expect(cpuUsage({ total: 1000, idle: 500 }, { total: 1200, idle: 550 })).toBe(75)
    expect(cpuUsage({ total: 1000, idle: 500 }, { total: 1000, idle: 500 })).toBeNull()
    expect(cpuUsage({ total: 1000, idle: 500 }, { total: 1200, idle: 0 })).toBeNull()
  })
  it('按网卡身份累加实际增量，新网卡和计数器重置不产生尖峰', () => {
    const previous = [{ id: 'a', name: '网卡 A', received: 1000, sent: 500 }]
    expect(
      networkRates(
        previous,
        [
          { ...previous[0]!, received: 3000, sent: 1500 },
          { id: 'new', name: '新网卡', received: 999999, sent: 999999 },
        ],
        2,
      ),
    ).toEqual({ receive: 1000, send: 500 })
    expect(networkRates(previous, [{ ...previous[0]!, received: 10, sent: 10 }], 2)).toEqual({
      receive: 0,
      send: 0,
    })
    expect(networkRates(previous, [], 2)).toEqual({ receive: 0, send: 0 })
    expect(networkRates(previous, previous, 20)).toBeNull()
    expect(networkRates(previous, previous, 0)).toBeNull()
  })
})
