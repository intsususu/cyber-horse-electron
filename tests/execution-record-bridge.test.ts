import { describe, expect, it, vi } from 'vitest'
import { openExecutionRecord } from '../src/renderer/src/lib/execution-record'

const request = { kind: 'media-process' as const, id: '6f878590-15f2-41fa-b05d-b1c6d7bd0a0b' }

describe('执行记录的桌面版本兼容', () => {
  it('旧预加载缺少方法时提示等待任务结束并完整重启', async () => {
    await expect(openExecutionRecord({}, request)).rejects.toThrow('等待运行中的任务结束')
    await expect(openExecutionRecord({}, request)).rejects.toThrow('仅刷新页面无法更新')
    await expect(openExecutionRecord(undefined, request)).rejects.toThrow('请在桌面应用中')
  })
  it('旧主进程缺少处理接口时给出同样的重启提示', async () => {
    const api = {
      openExecutionRecord: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'records:open': Error: No handler registered for 'records:open'",
          ),
        ),
    }
    await expect(openExecutionRecord(api, request)).rejects.toThrow('完整退出并重新启动应用')
  })
  it('新版正常传递标识，文件读取等业务错误保留原提示', async () => {
    const api = { openExecutionRecord: vi.fn().mockResolvedValue(undefined) }
    await openExecutionRecord(api, request)
    expect(api.openExecutionRecord).toHaveBeenCalledWith(request)
    api.openExecutionRecord.mockRejectedValue(new Error('执行记录已移除。'))
    await expect(openExecutionRecord(api, request)).rejects.toThrow('执行记录已移除。')
  })
})
