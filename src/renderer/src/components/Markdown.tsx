import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import { Copy, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import 'katex/dist/katex.min.css'

// —— 代码块组件：语言标签 + 复制按钮 ——
function CodeBlock({ children }: { children: ReactNode }) {
  const { t } = useTranslation(['common'])
  const [copied, setCopied] = useState(false)

  // 从 code 子元素提取语言和原始文本
  const childArray = Array.isArray(children) ? children : [children]
  const codeEl = childArray[0] as React.ReactElement<{ className?: string; children?: ReactNode }>
  const className = codeEl?.props?.className ?? ''
  const lang = /language-(\w+)/.exec(className)?.[1] ?? ''
  const rawText = extractText(codeEl?.props?.children)

  const handleCopy = () => {
    navigator.clipboard.writeText(rawText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="code-block">
      <div className="code-block__toolbar">
        <span className="code-block__lang">{lang || 'text'}</span>
        <button type="button" className="code-block__copy" onClick={handleCopy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t('common:code.copied') : t('common:code.copy')}</span>
        </button>
      </div>
      <pre className="code-block__pre">
        <code className={className}>{codeEl?.props?.children}</code>
      </pre>
    </div>
  )
}

// 递归提取 ReactNode 中的纯文本
function extractText(node: ReactNode): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return extractText(props?.children)
  }
  return ''
}

// —— Markdown 渲染（§1 首页 + §5 任务日志）——
// 代码块：工具栏(语言标签+复制按钮) + 实色 bg-2 + font-mono；
// 行内代码 bg-3 小圆角；引用块左侧 brand-500 细条；表格/公式重做样式。
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
        components={{
          // 代码块：包裹在 CodeBlock 组件中（工具栏 + 复制按钮）
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // 行内代码
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? '')
            if (isBlock) {
              return <code className={className} {...props}>{children}</code>
            }
            return (
              <code className="markdown-inline-code" {...props}>
                {children}
              </code>
            )
          },
          // 引用块
          blockquote: ({ children }) => (
            <blockquote className="markdown-blockquote">
              {children}
            </blockquote>
          ),
          // 表格：必须外包滚动层
          table: ({ children }) => (
            <div className="markdown-table-wrap">
              <table>{children}</table>
            </div>
          ),
          th: ({ children }) => <th>{children}</th>,
          td: ({ children }) => <td>{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
