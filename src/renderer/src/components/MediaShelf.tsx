import { useEffect, useRef, type ReactNode } from 'react'

export function MediaShelf({
  title,
  label,
  className,
  listClassName,
  count,
  children,
}: {
  title: string
  label: string
  className: string
  listClassName: string
  count?: number
  children: ReactNode
}) {
  const sectionRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const section = sectionRef.current
    const list = listRef.current
    if (!section || !list) return

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      const maxScroll = list.scrollWidth - list.clientWidth
      if (maxScroll <= 0) return

      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? list.clientWidth
            : 1
      const nextScroll = Math.max(0, Math.min(maxScroll, list.scrollLeft + event.deltaY * unit))
      if (nextScroll === list.scrollLeft) return

      event.preventDefault()
      list.scrollLeft = nextScroll
    }

    section.addEventListener('wheel', handleWheel, { passive: false })
    return () => section.removeEventListener('wheel', handleWheel)
  }, [])

  return (
    <section ref={sectionRef} className={`media-shelf ${className}`} aria-label={label}>
      <h3>
        {title} {count ? <span>{count}</span> : null}
      </h3>
      <div ref={listRef} className={listClassName} aria-label={`${title}列表`}>
        {children}
      </div>
    </section>
  )
}
