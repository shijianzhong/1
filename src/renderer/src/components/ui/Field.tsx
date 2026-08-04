import type { ReactNode, CSSProperties } from 'react'

interface FieldProps {
  label: string
  children: ReactNode
  /** 可选额外样式（SkillsPage 需要传 flex 撑满） */
  style?: CSSProperties
}

/**
 * 表单字段：label + 内容，统一间距。
 * 替代各页面重复的 Field 组件（原 3 份重复）。
 */
export function Field({ label, children, style }: FieldProps): React.ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', ...style }}>
      <label style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-2)', flexShrink: 0 }}>
        {label}
      </label>
      <div style={{ marginTop: 'var(--spacing-2)', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  )
}
