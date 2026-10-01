import type { MediaLibrary } from '../../../shared/media-library'
import { Select } from './Select'

export function MediaLibraryPicker({
  libraries,
  value,
  disabled,
  onChange,
  allowAll = false,
}: {
  libraries: MediaLibrary[]
  value: string
  disabled: boolean
  onChange: (id: string) => void
  allowAll?: boolean
}) {
  const options = [
    ...(allowAll ? [{ value: '', label: '全部媒体库' }] : []),
    ...libraries.map((item) => ({ value: item.id, label: item.name })),
  ]
  const selected = options.find((item) => item.value === value) ?? options[0]
  return (
    <Select
      className="media-library-picker"
      triggerClassName="media-library-picker-trigger"
      menuClassName="media-library-options"
      label={`选择媒体库：${selected?.label ?? ''}`}
      listLabel="媒体库"
      value={selected?.value ?? ''}
      disabled={disabled}
      onChange={onChange}
      options={options}
    />
  )
}
