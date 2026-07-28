import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { unwrap } from '@renderer/api/client'
import { IpcError } from '@renderer/api/client'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
}

export function HomePage() {
  const { t } = useTranslation(['common', 'home'])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<(() => void) | null>(null)

  // 订阅流式
  useEffect(() => {
    streamRef.current = window.one.home.onStream((delta) => {
      if (delta.type === 'text') {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, text: last.text + delta.text }]
          }
          return [...prev, { id: crypto.randomUUID(), role: 'assistant' as const, text: delta.text, streaming: true }]
        })
      } else if (delta.type === 'message_stop') {
        setMessages((prev) =>
          prev.map((m, i) => i === prev.length - 1 ? { ...m, streaming: false } : m),
        )
      }
    })
    return () => streamRef.current?.()
  }, [])

  const onSend = async (): Promise<void> => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setError(null)
    setSending(true)
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user' as const, text }])

    try {
      await window.one.home.chat({ message: text }).then(unwrap)
    } catch (e) {
      const msg = e instanceof IpcError ? e.message : String(e)
      setError(msg)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat-shell">
      <section className="glass-panel placeholder-card" style={{ borderRadius: 28, padding: 24 }}>
        <p className="section-title">{t('home:welcome')}</p>
        <p className="section-subtitle">{t('home:description')}</p>
      </section>

      {error ? (
        <div className="message__bubble message__bubble--assistant" style={{ color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : null}

      {messages.map((m) => (
        <div key={m.id} className={`message ${m.role === 'user' ? 'message--user' : ''}`}>
          {m.role === 'assistant' ? (
            <div className="message__avatar">
              <Sparkles size={16} />
            </div>
          ) : null}
          <div className={`message__bubble message__bubble--${m.role}`}>
            {m.text}
            {m.streaming ? <span className="stream-cursor">▋</span> : null}
          </div>
        </div>
      ))}

      <div className="glass-panel composer">
        <input
          placeholder={t('home:composerPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void onSend()
            }
          }}
          disabled={sending}
        />
        <button type="button" onClick={() => void onSend()} disabled={sending}>
          {t('common:actions.send')}
        </button>
      </div>
    </div>
  )
}
