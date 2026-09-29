import { Monitor } from 'lucide-react'
import type { Theme } from '../../../shared/contracts'

export const themeOptions = [
  { value: 'light', label: '浅色', name: '浅色模式' },
  { value: 'eva', label: '初号机', name: '初号机主题' },
  { value: 'dark', label: '深色', name: '深色模式' },
  { value: 'system', label: '跟随系统', name: '跟随系统' },
] as const

export function ThemePicker({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  value: Theme
  onChange: (theme: Theme) => void
  disabled?: boolean
  compact?: boolean
}) {
  return (
    <div
      className={compact ? 'theme-picker compact' : 'theme-picker'}
      role="group"
      aria-label="外观模式"
    >
      {themeOptions.map((theme) => (
        <button
          key={theme.value}
          className={`theme-choice ${value === theme.value ? 'selected' : ''}`}
          title={theme.name}
          aria-label={compact ? theme.name : `主题：${theme.label}`}
          aria-pressed={value === theme.value}
          disabled={disabled}
          onClick={() => onChange(theme.value)}
        >
          <span className={`theme-swatch swatch-${theme.value}`}>
            {theme.value === 'system' && <Monitor size={15} />}
          </span>
          {!compact && <span>{theme.label}</span>}
        </button>
      ))}
    </div>
  )
}
