export function taskTimestamp(value?: string | null): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function taskDuration(start: number, end: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  const seconds = Math.floor((end - start) / 1000)
  if (seconds < 1) return '不足 1 秒'
  const parts = [
    [Math.floor(seconds / 86400), '天'],
    [Math.floor((seconds % 86400) / 3600), '小时'],
    [Math.floor((seconds % 3600) / 60), '分'],
    [seconds % 60, '秒'],
  ] as const
  return parts
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value} ${unit}`)
    .join(' ')
}
