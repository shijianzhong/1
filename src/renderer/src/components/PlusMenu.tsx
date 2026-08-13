import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Image, FileText, FolderPlus, Plus } from 'lucide-react'
import type { Attachment } from '@shared/types'

interface PlusMenuProps {
  onAttach: (attachment: Attachment) => void
}

export function PlusMenu({ onAttach }: PlusMenuProps) {
  const { t } = useTranslation(['home'])
  const [open, setOpen] = useState(false)

  const handleSelect = useCallback(
    async (type: 'image' | 'file' | 'folder') => {
      setOpen(false)
      const result = await window.one.app.selectAttachment(type)
      if (result.ok && result.data) {
        onAttach(result.data)
      }
    },
    [onAttach],
  )

  return (
    <div className="plus-menu">
      <svg className="plus-menu__svg" aria-hidden="true">
        <defs>
          <filter id="gooey-filter">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
              result="gooey"
            />
            <feBlend in="SourceGraphic" in2="gooey" />
          </filter>
        </defs>
      </svg>
      <div className={`plus-menu__container${open ? ' plus-menu__container--open' : ''}`}>
        <button
          className="plus-menu__item"
          style={{
            transform: open ? 'translate(-40px, -28px) scale(1)' : 'translate(0, 0) scale(0)',
            opacity: open ? 1 : 0,
          }}
          onClick={() => void handleSelect('image')}
          title={t('home:attachment.image')}
          aria-label={t('home:attachment.image')}
        >
          <Image size={16} />
        </button>
        <button
          className="plus-menu__item"
          style={{
            transform: open ? 'translate(0, -48px) scale(1)' : 'translate(0, 0) scale(0)',
            opacity: open ? 1 : 0,
          }}
          onClick={() => void handleSelect('file')}
          title={t('home:attachment.file')}
          aria-label={t('home:attachment.file')}
        >
          <FileText size={16} />
        </button>
        <button
          className="plus-menu__item"
          style={{
            transform: open ? 'translate(40px, -28px) scale(1)' : 'translate(0, 0) scale(0)',
            opacity: open ? 1 : 0,
          }}
          onClick={() => void handleSelect('folder')}
          title={t('home:attachment.folder')}
          aria-label={t('home:attachment.folder')}
        >
          <FolderPlus size={16} />
        </button>
        <button
          className="plus-menu__toggle"
          onClick={() => setOpen((v) => !v)}
          title={open ? t('home:attachment.close') : t('home:attachment.add')}
          aria-label={open ? t('home:attachment.close') : t('home:attachment.add')}
          aria-expanded={open}
        >
          <Plus size={18} style={{ transform: open ? 'rotate(45deg)' : 'rotate(0deg)' }} />
        </button>
      </div>
    </div>
  )
}
