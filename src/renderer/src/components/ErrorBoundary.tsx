import { Component, type ErrorInfo, type ReactNode } from 'react'
import i18n from '@renderer/i18n'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
}

// —— 渲染异常兜底（§11.5）：任何组件渲染错误 → 降级 UI + 重载入口，不白屏 ——
// class 组件内不能用 hook，直接取 i18n 实例（common 命名空间首屏已加载）。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[renderer:error-boundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--color-bg-0)',
          color: 'var(--color-fg-1)',
          padding: 24,
        }}
      >
        <section
          className="glass-panel"
          style={{ maxWidth: 420, padding: 32, borderRadius: 24, textAlign: 'center' }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            {i18n.t('common:errorBoundary.title')}
          </h2>
          <p style={{ fontSize: 13, color: 'var(--color-fg-3)', marginBottom: 16 }}>
            {i18n.t('common:errorBoundary.description')}
          </p>
          {this.state.message ? (
            <pre
              style={{
                fontSize: 11,
                color: 'var(--color-fg-3)',
                background: 'var(--color-bg-2)',
                borderRadius: 8,
                padding: 12,
                marginBottom: 16,
                maxHeight: 120,
                overflow: 'auto',
                textAlign: 'left',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {this.state.message}
            </pre>
          ) : null}
          <button type="button" onClick={() => window.location.reload()}>
            {i18n.t('common:errorBoundary.reload')}
          </button>
        </section>
      </div>
    )
  }
}
