import { useTranslation } from 'react-i18next'
import { useTasks } from '@renderer/api/hooks'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageToolbar } from '@renderer/components/ui/PageToolbar'
import type { TaskRecord } from '@shared/types'

// —— 任务历史页（§5.2.3）——
// 接真实 tasks SQLite 表，按创建时间倒序，展示状态/能力/时间。
export function TasksPage() {
  const { t, i18n } = useTranslation(['common'])
  const { data, isLoading, isError } = useTasks()

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <PageToolbar
        title={t('common:list.tasks.title')}
        subtitle={t('common:list.tasks.description')}
      />

      {isLoading ? (
        <EmptyState text={t('common:state.loading')} />
      ) : isError ? (
        <EmptyState text={t('common:state.error')} danger />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState text={t('common:empty.noItems')} />
      ) : (
        <section className="placeholder-grid">
          {(data ?? []).map((task: TaskRecord) => (
            <article
              key={task.id}
              className="surface-panel placeholder-card asset-card"
              style={{ borderRadius: 20 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <h3 className="section-title">
                    {task.capabilityId ?? t('common:list.tasks.title')} #{task.id.slice(-6)}
                  </h3>
                  <p className="section-subtitle">
                    {new Intl.DateTimeFormat(i18n.language, {
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
