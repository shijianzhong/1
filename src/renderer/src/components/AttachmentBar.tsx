import { X, FileText, FolderPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from '@shared/types'

interface AttachmentBarProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function AttachmentBar({ attachments, onRemove }: AttachmentBarProps) {
  const { t } = useTranslation(['home'])
  if (attachments.length === 0) return null

  return (
    <div className="attachment-bar">
      {attachments.map((att) => (
        <div key={att.id} className="attachment-chip">
          {att.type === 'image' && att.dataUrl ? (
            <img src={att.dataUrl} alt={att.name} className="attachment-chip__img" />
          ) : att.type === 'folder' ? (
            <FolderPlus size={16} className="attachment-chip__icon" />
          ) : (
            <FileText size={16} className="attachment-chip__icon" />
          )}
          <div className="attachment-chip__info">
            <span className="attachment-chip__name">{att.name}</span>
            <span className="attachment-chip__size">{formatSize(att.size)}</span>
          </div>
          <button
            className="attachment-chip__remove"
            onClick={() => onRemove(att.id)}
            aria-label={t('home:attachment.remove')}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
