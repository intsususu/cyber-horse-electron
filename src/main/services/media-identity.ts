import { basename, extname } from 'node:path'
import type { TaskFile } from '../../shared/task-workspace'
import { canonicalVideoName } from './video-name'

export type MediaIdentity = { number: string | null; chinese: boolean; restored: boolean }

/** 命名仅是已有状态证据，不能据此声称实际运行过工具或存在独立字幕轨。 */
export function mediaIdentity(path: string): MediaIdentity {
  const stem = basename(path, extname(path))
  const suffix = /-(UC|U|C|hack)(?:_\d+)?$/i.exec(stem)?.[1]?.toUpperCase()
  return {
    number: /(?:-CD\d+|-part\d+)/i.test(stem)
      ? null
      : (canonicalVideoName(stem)?.replace(/-(?:UC|U|C)$/i, '') ?? null),
    chinese: suffix === 'C' || suffix === 'UC',
    restored: suffix === 'U' || suffix === 'UC' || suffix === 'HACK',
  }
}

export function taskMediaIdentity(file: TaskFile): MediaIdentity {
  return {
    number: file.number,
    chinese: file.marks.chinese.present,
    restored: file.marks.restored.present,
  }
}

/** 应用内部保留 U，MDC 的仅破解入口采用其命名规范中的 hack。 */
export function markedMediaName(path: string, identity: MediaIdentity, mdc = false): string {
  const stem =
    identity.number ?? basename(path, extname(path)).replace(/-(?:UC|U|C|hack)(?:_\d+)?$/i, '')
  const mark = identity.restored
    ? identity.chinese
      ? 'UC'
      : mdc
        ? 'hack'
        : 'U'
    : identity.chinese
      ? 'C'
      : ''
  return `${stem}${mark ? '-' + mark : ''}${extname(path).toLowerCase()}`
}

export function verifyMediaIdentity(path: string, expected: MediaIdentity): void {
  const actual = mediaIdentity(path)
  if (expected.number && actual.number !== expected.number)
    throw new Error('MDC 产物番号与任务不一致，未提交输出。')
  if ((expected.chinese && !actual.chinese) || (expected.restored && !actual.restored))
    throw new Error('MDC 产物丢失中文字幕或破解命名标记，未提交输出；请核对任务文件与 MDC 配置。')
}
