export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const index = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 1 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB'][index]}`
}
export const formatRate = (value: number | null | undefined) =>
  value == null ? '—' : `${formatBytes(value)}/s`

export function formatModifiedAt(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
