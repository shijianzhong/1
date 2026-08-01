import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** 思考过程折叠块（灰色，默认展开，可折叠） */
export function ThinkingBlock({ text, collapsed }: { text: string; collapsed?: boolean }) {
  const { t } = useTranslation(['common'])
  const [open, setOpen] = useState(!collapsed)
  // 外部 collapsed 变化时同步（回复完成 → 折叠；重试 → 展开）
  useEffect(() => {
    setOpen(!collapsed)
  }, [collapsed])
  return (
    <div className="thinking-block">
      <button
        type="button"
        className="thinking-block__toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="thinking-block__label">{t('common:thinking.label')}</span>
        <span className="thinking-block__arrow">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="thinking-block__content">{text}</div>
      ) : null}
    </div>
  )
}
