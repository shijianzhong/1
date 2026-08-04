import type { ReactNode } from 'react'

interface PageToolbarProps {
  title: string
  subtitle?: string
  /** 右侧操作区（新建按钮等） */
  actions?: ReactNode
}

/**
 * 页面顶部工具条：标题 + 描述 + 操作区。
 * 替代 6 个页面重复的内联工具条模式。
 */
export function PageToolbar({ title, subtitle, actions }: PageToolbarProps): React.ReactNode {
  return (
    <section
      className="glass-panel"
      style={{
        padding: 'var(--spacing-4)',
        borderRadius: 'var(--radius-lg)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <div>
        <h2 className="section-title" style={{ fontSize: '1rem' }}>
          {title}
        </h2>
        {subtitle ? <p className="section-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>{actions}</div> : null}
    </section>
  )
}
