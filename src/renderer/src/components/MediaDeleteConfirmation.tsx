import { useId, useRef } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { MediaDeletionConfirmation } from '../../../shared/media-library'
import { Modal } from './Modal'

export function MediaDeleteConfirmation({
  confirmation,
  onResolve,
}: {
  confirmation: MediaDeletionConfirmation
  onResolve: (confirmed: boolean) => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  return (
    <Modal
      title="删除服务器媒体"
      className="media-delete-modal"
      descriptionId={descriptionId}
      initialFocusRef={cancelRef}
      onClose={() => onResolve(false)}
    >
      <div className="media-delete-content" id={descriptionId}>
        <div className="media-delete-icon" aria-hidden="true">
          <TriangleAlert size={24} />
        </div>
        <div className="media-delete-copy">
          <p>确定从 Emby 删除以下媒体？</p>
          <strong className="media-delete-name">{confirmation.name}</strong>
          <p className="media-delete-warning">
            这可能永久删除服务器上的媒体文件，无法在本应用中恢复。
          </p>
        </div>
      </div>
      <div className="media-delete-actions">
        <button ref={cancelRef} className="secondary-button" onClick={() => onResolve(false)}>
          取消
        </button>
        <button className="secondary-button media-delete-confirm" onClick={() => onResolve(true)}>
          永久删除
        </button>
      </div>
    </Modal>
  )
}
