import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import '../styles/select.css'

export type SelectOption = { value: string; label: string; detail?: string }

// 弹层保留在控件的 DOM 内，使用顶层展示，兼容模态框、全屏和局部滚动区域。
export function Select({
  value,
  options,
  onChange,
  label,
  listLabel = label,
  disabled = false,
  editable = false,
  className = '',
  triggerClassName = '',
  menuClassName = '',
  icon,
  title,
  menuMinWidth = 0,
  boundarySelector,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  label: string
  listLabel?: string
  disabled?: boolean
  editable?: boolean
  className?: string
  triggerClassName?: string
  menuClassName?: string
  icon?: ReactNode
  title?: string
  menuMinWidth?: number
  boundarySelector?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement | HTMLInputElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const id = useId()
  const selected = options.findIndex((option) => option.value === value)
  const display = options[selected]?.label ?? value
  const focusOnOpen = useRef(false)

  function close(restore = false) {
    setOpen(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }
  function show(focus: boolean) {
    if (disabled) return
    focusOnOpen.current = focus
    if (open && focus) optionRefs.current[Math.max(0, selected)]?.focus()
    setOpen(true)
  }
  useLayoutEffect(() => {
    const panel = menu.current
    if (!open || !panel) return
    panel.showPopover()
    const place = () => {
      const rect = root.current!.getBoundingClientRect()
      const boundary = boundarySelector
        ? root.current!.closest(boundarySelector)?.getBoundingClientRect()
        : undefined
      const left = Math.max(8, (boundary?.left ?? 0) + 8)
      const right = Math.min(window.innerWidth - 8, (boundary?.right ?? window.innerWidth) - 8)
      const width = Math.min(Math.max(rect.width, menuMinWidth), right - left)
      const below =
        Math.min(window.innerHeight, boundary?.bottom ?? window.innerHeight) - rect.bottom - 8
      const above = rect.top - Math.max(0, boundary?.top ?? 0) - 8
      const up = below < Math.min(280, panel.scrollHeight) && above > below
      panel.style.width = `${width}px`
      panel.style.maxHeight = `${Math.max(40, Math.min(320, up ? above : below))}px`
      panel.style.left = `${Math.max(left, Math.min(rect.left, right - width))}px`
      panel.style.top = `${up ? rect.top - panel.getBoundingClientRect().height : rect.bottom}px`
    }
    place()
    if (focusOnOpen.current)
      optionRefs.current[Math.max(0, selected)]?.focus({ preventScroll: true })
    optionRefs.current[Math.max(0, selected)]?.scrollIntoView({ block: 'nearest' })
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close()
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && !panel.contains(event.target)) place()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', place)
    return () => {
      if (panel.isConnected && panel.matches(':popover-open')) panel.hidePopover()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', place)
    }
  }, [open, menuMinWidth, boundarySelector])
  useEffect(() => {
    if (disabled) close()
  }, [disabled])

  const key = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      show(true)
    }
  }
  const choose = (option: SelectOption) => {
    close(true)
    onChange(option.value)
  }
  return (
    <div ref={root} className={`app-select ${className}`} data-open={open}>
      {editable ? (
        <div className="app-select-editable">
          <input
            ref={(node) => {
              trigger.current = node
            }}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={id}
            aria-autocomplete="list"
            disabled={disabled}
            value={display}
            maxLength={100}
            onClick={() => show(false)}
            onKeyDown={key}
            onChange={(event) => {
              onChange(
                options.find((item) => item.label === event.target.value)?.value ??
                  event.target.value,
              )
              show(false)
            }}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={`展开${label}`}
            disabled={disabled}
            onClick={() => (open ? close(true) : show(true))}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          ref={(node) => {
            trigger.current = node
          }}
          className={`app-select-trigger ${triggerClassName}`}
          aria-label={label}
          title={title ?? display}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={id}
          disabled={disabled}
          onClick={() => (open ? close() : show(true))}
          onKeyDown={key}
        >
          {icon}
          <span>{display}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div
          ref={menu}
          id={id}
          popover="manual"
          role="listbox"
          aria-label={listLabel}
          className={`app-select-menu ${menuClassName}`}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              title={option.detail ?? option.label}
              ref={(node) => {
                optionRefs.current[index] = node
              }}
              onClick={() => choose(option)}
              onKeyDown={(event) => {
                let next = index
                if (event.key === 'ArrowDown') next = (index + 1) % options.length
                else if (event.key === 'ArrowUp')
                  next = (index + options.length - 1) % options.length
                else if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = options.length - 1
                else if (event.key === 'Escape') {
                  key(event)
                  return
                } else return
                event.preventDefault()
                event.stopPropagation()
                optionRefs.current[next]?.focus()
              }}
            >
              <span>
                {option.label}
                {option.detail && option.detail !== option.label && <small>{option.detail}</small>}
              </span>
              {option.value === value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
