import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'

export function Modal({
  title,
  children,
  onClose,
  className = '',
  descriptionId,
  initialFocusRef,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
  descriptionId?: string
  initialFocusRef?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    initialFocusRef?.current?.focus()
    return () => {
      dialog?.close()
      previous?.focus()
    }
  }, [initialFocusRef])
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭弹窗">
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  )
}
