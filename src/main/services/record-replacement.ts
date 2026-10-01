import { rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** 记录文件被短暂占用时有界重试；始终用替换操作，不通过删除原文件绕过权限。 */
export async function replaceRecordFile(
  source: string,
  target: string,
  operation: (source: string, target: string) => Promise<void> = rename,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await operation(source, target)
      return
    } catch (error) {
      if (
        attempt >= 7 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error
      await delay(25 * (attempt + 1))
    }
  }
}
