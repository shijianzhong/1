import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

// —— Markdown 渲染（§1 首页 + §5 任务日志）——
// 代码块实色 bg-2 无边框 + 复制图标 + font-mono；行内代码 bg-3 小圆角；
// 引用块左侧 brand-500 细条；表格/公式重做样式。
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
        components={{
          // 代码块
          pre: ({ children }) => (
            <pre
              style={{
                background: 'var(--color-bg-2)',
                border: 0,
                borderRadius: 12,
                padding: 14,
                overflowX: 'auto',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: '0.85rem',
              }}
            >
              {children}
            </pre>
          ),
          // 行内代码
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? '')
            if (isBlock) {
              return <code className={className} {...props}>{children}</code>
            }
            return (
              <code
                style={{
                  background: 'var(--color-bg-3)',
                  borderRadius: 6,
                  padding: '2px 5px',
                  fontSize: '0.85em',
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                }}
                {...props}
              >
                {children}
              </code>
            )
          },
          // 引用块
          blockquote: ({ children }) => (
            <blockquote
              style={{
                borderLeft: '3px solid var(--color-brand-500)',
                margin: 0,
                paddingLeft: 12,
                color: 'var(--color-fg-2)',
              }}
            >
              {children}
            </blockquote>
          ),
          // 表格
          table: ({ children }) => (
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
              }}
            >
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th
              style={{
                borderBottom: '1px solid var(--color-border-strong)',
                padding: '6px 10px',
                textAlign: 'left',
                fontWeight: 600,
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{ borderBottom: '1px solid var(--color-border)', padding: '6px 10px' }}>
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
