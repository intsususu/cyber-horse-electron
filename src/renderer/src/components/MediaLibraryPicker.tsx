import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { MediaLibrary } from '../../../shared/media-library'

export function MediaLibraryPicker({
  libraries,
  value,
  disabled,
  onChange,
}: {
  libraries: MediaLibrary[]
  value: string
  disabled: boolean
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const options = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = Math.max(
    0,
    libraries.findIndex((item) => item.id === value),
  )
  const selected = libraries[selectedIndex]

  useLayoutEffect(() => {
    if (open) options.current[selectedIndex]?.focus()
  }, [open, selectedIndex])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const choose = (id: string) => {
    setOpen(false)
    trigger.current?.focus()
    onChange(id)
  }
  const handleOptionKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (event.key === 'ArrowDown') next = (index + 1) % libraries.length
    else if (event.key === 'ArrowUp') next = (index - 1 + libraries.length) % libraries.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = libraries.length - 1
    else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
      return
    } else return
    event.preventDefault()
    options.current[next]?.focus()
  }

  return (
    <div className="media-library-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="media-library-picker-trigger"
        aria-label={`选择媒体库：${selected?.name ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? 'media-library-options' : undefined}
        disabled={disabled}
        title={selected?.name}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span>{selected?.name}</span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="media-library-options"
          id="media-library-options"
          role="listbox"
          aria-label="媒体库"
        >
          {libraries.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                options.current[index] = node
              }}
              type="button"
              role="option"
              aria-selected={item.id === value}
              tabIndex={-1}
              title={item.name}
              onClick={() => choose(item.id)}
              onKeyDown={(event) => handleOptionKey(event, index)}
            >
              <span>{item.name}</span>
              {item.id === value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
