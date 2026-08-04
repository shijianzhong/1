import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  /** 主文本（如"暂无内容"） */
  title?: string
  /** 副文本（如描述说明） */
  hint?: string
  /** 仅显示文本时的简化模式 */
  text?: string
  /** 危险态（如加载失败） */
  danger?: boolean
  /** 空状态图标 */
  icon?: LucideIcon
  /** 点击回调（传入则渲染为 button） */
  onClick?: () => void
  /** 按钮文案（配合 onClick） */
  actionLabel?: string
}

/**
 * 统一空状态 / 加载态 / 错误态展示。
 * 替代各页面重复的 EmptyState 组件（原 5 份重复）。
 */
export function EmptyState({
  title,
  hint,
  text,
  danger,
  icon: Icon,
  onClick,
  actionLabel,
}: EmptyStateProps): React.ReactNode {
  // 简化模式：仅文本
  if (text && !title) {
    return (
      <div
        className="glass-panel"
        style={{
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--spacing-8)',
          textAlign: 'center',
          color: danger ? 'var(--color-danger)' : 'var(--color-fg-2)',
        }}
      >
        {text}
      </div>
    )
  }

  // 完整模式：图标 + 标题 + 描述 + 可选操作
  const Tag = onClick ? 'button' : 'div'

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={onClick ? 'glass-panel' : 'glass-panel'}
      style={{
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--spacing-8)',
        textAlign: 'center',
        border: onClick ? 0 : undefined,
        cursor: onClick ? 'pointer' : 'default',
        color: 'var(--color-fg-2)',
        display: 'grid',
        gap: 'var(--spacing-2)',
        justifyItems: 'center',
        width: '100%',
      }}
    >
      {Icon ? (
        <Icon size={40} style={{ color: 'var(--color-brand-500)' }} />
      ) : null}
      {title ? <p className="section-title">{title}</p> : null}
      {hint ? <p className="section-subtitle">{hint}</p> : null}
      {actionLabel && onClick ? (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-brand-500)' }}>
          {actionLabel}
        </span>
      ) : null}
    </Tag>
  )
}
