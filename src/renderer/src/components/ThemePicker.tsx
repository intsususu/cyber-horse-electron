import type { Theme } from '../../../shared/contracts'

export const themeOptions = [
  { value: 'light', label: '浅色', name: '浅色模式' },
  { value: 'dark', label: '深色', name: '深色模式' },
  { value: 'eva', label: '初号机', name: '初号机主题' },
  { value: 'ironman', label: '钢铁侠', name: '钢铁侠主题' },
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
          <span className={`theme-swatch swatch-${theme.value}`} />
          {!compact && <span>{theme.label}</span>}
        </button>
      ))}
    </div>
  )
}
