import { useTranslation } from 'react-i18next'
import { useTasks } from '@renderer/api/hooks'
import type { TaskRecord } from '@shared/types'

// —— 任务历史页（§5.2.3）——
// 接真实 tasks SQLite 表，按创建时间倒序，展示状态/能力/时间。
export function TasksPage() {
  const { t } = useTranslation(['common'])
  const { data, isLoading, isError } = useTasks()

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section
        className="glass-panel"
        style={{ padding: 16, borderRadius: 24, display: 'flex', justifyContent: 'space-between' }}
      >
        <div>
          <h2 className="section-title" style={{ fontSize: '1rem' }}>
            {t('common:list.tasks.title')}
          </h2>
          <p className="section-subtitle">{t('common:list.tasks.description')}</p>
        </div>
      </section>

      {isLoading ? (
        <div className="glass-panel" style={{ borderRadius: 20, padding: 40, textAlign: 'center', color: 'var(--color-fg-2)' }}>
          {t('common:state.loading')}
        </div>
      ) : isError ? (
        <div className="glass-panel" style={{ borderRadius: 20, padding: 40, textAlign: 'center', color: 'var(--color-danger)' }}>
          {t('common:state.error')}
        </div>
      ) : (data?.length ?? 0) === 0 ? (
        <div className="glass-panel" style={{ borderRadius: 20, padding: 40, textAlign: 'center', color: 'var(--color-fg-2)' }}>
          {t('common:empty.noItems')}
        </div>
      ) : (
        <section className="placeholder-grid">
          {(data ?? []).map((task: TaskRecord) => (
            <article
              key={task.id}
              className="surface-panel placeholder-card"
              style={{ borderRadius: 20 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="section-title">
                    {task.capabilityId ?? t('common:list.tasks.title')} #{task.id.slice(-6)}
                  </h3>
                  <p className="section-subtitle">
                    {new Intl.DateTimeFormat('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(task.createdAt)}
                  </p>
                </div>
                <span
                  style={{
                    whiteSpace: 'nowrap',
                    fontSize: '0.75rem',
                    color:
                      task.status === 'done'
                        ? 'var(--color-success)'
                        : task.status === 'failed'
                          ? 'var(--color-danger)'
                          : task.status === 'running'
                            ? 'var(--color-info)'
                            : 'var(--color-fg-2)',
                  }}
                >
                  {task.status}
                </span>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  )
}
