import type { DesktopApi } from '../../../shared/contracts'
import type { ExecutionRecordRequest } from '../../../shared/execution-record'

const restartMessage =
  '当前窗口仍在使用旧版桌面接口。请等待运行中的任务结束后，完整退出并重新启动应用，再打开执行记录；仅刷新页面无法更新此接口。'

export async function openExecutionRecord(
  api: Partial<Pick<DesktopApi, 'openExecutionRecord'>> | undefined,
  request: ExecutionRecordRequest,
): Promise<void> {
  if (!api) throw new Error('请在桌面应用中打开执行记录。')
  if (typeof api.openExecutionRecord !== 'function') throw new Error(restartMessage)
  try {
    await api.openExecutionRecord(request)
  } catch (error) {
    if (
      error instanceof Error &&
      /No handler registered for ['"]records:open['"]/.test(error.message)
    )
      throw new Error(restartMessage)
    throw error
  }
}
