import type { Settings } from '../../../shared/contracts'

// 文件里变化的字段立即生效；其他字段保留表单草稿，主题始终跟随已保存值。
export function reconcileSettingsDraft(
  draft: Settings,
  previous: Settings,
  next: Settings,
): Settings {
  function reconcile<T extends object>(draftGroup: T, previousGroup: T, nextGroup: T): T {
    const result = { ...draftGroup }
    for (const key of Object.keys(nextGroup) as (keyof T)[])
      if (nextGroup[key] !== previousGroup[key]) result[key] = nextGroup[key]
    return result
  }
  return {
    ...next,
    paths: reconcile(draft.paths, previous.paths, next.paths),
    subtitle: reconcile(draft.subtitle, previous.subtitle, next.subtitle),
    player: reconcile(draft.player, previous.player, next.player),
    mediaServer: reconcile(draft.mediaServer, previous.mediaServer, next.mediaServer),
    privacyCover: reconcile(draft.privacyCover, previous.privacyCover, next.privacyCover),
  }
}
