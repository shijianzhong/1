import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Brain, Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * 思考过程 trace 容器：展示 agent 的推理过程文本。
 *
 * 设计原则（Beautiful UI 接入评估 §六 步骤 3）：
 * - 不改事件协议，先做单一 trace，不强行伪造 Steps/Reasoning 分类
 * - 紧凑可折叠，突出内容量和流式状态
 * - 与 ThinkingOrb 联动：流式期间默认展开，完成后自动折叠
 * - 回复完成后用户可手动展开查看
 */
export function ThinkingBlock({ text, collapsed }: { text: string; collapsed?: boolean }) {
  const { t } = useTranslation(['common'])
  const [open, setOpen] = useState(!collapsed)

  // 外部 collapsed 变化时同步（回复完成 → 折叠；重试 → 展开）
  useEffect(() => {
    setOpen(!collapsed)
  }, [collapsed])

  // 内容摘要：行数 + 字符数
  const summary = useMemo(() => {
    const lines = text.split('\n').filter(Boolean).length
    const chars = text.length
    if (chars < 1000) return `${lines} ${t('common:thinking.lines')}`
    return `${lines} ${t('common:thinking.lines')} · ${Math.round(chars / 1000)}k`
  }, [text, t])

  // 流式态：collapsed 为 false 且有文本 → 正在思考
  const isStreaming = !collapsed && !!text

  return (
    <div className={`thinking-block ${isStreaming ? 'thinking-block--streaming' : ''}`}>
      <button
        type="button"
        className="thinking-block__toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight
          size={12}
          className={`thinking-block__chevron ${open ? 'thinking-block__chevron--open' : ''}`}
        />
        <Brain size={12} className="thinking-block__icon" />
        <span className="thinking-block__label">{t('common:thinking.label')}</span>
        {isStreaming ? (
          <span className="thinking-block__pulse" />
        ) : (
          <span className="thinking-block__summary">
            <Clock size={10} />
            {summary}
          </span>
        )}
      </button>
      {open ? (
        <div className="thinking-block__content">
          <div className="thinking-block__text">{text}</div>
        </div>
      ) : null}
    </div>
  )
}
