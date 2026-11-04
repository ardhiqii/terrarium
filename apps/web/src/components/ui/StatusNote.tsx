import type { ReactNode } from 'react'

/**
 * A short status headline with optional detail behind a disclosure
 * (`DESIGN.md` §7, rule R4).
 *
 * The title is what a user must know right now, in about eight words. Anything
 * that explains the title (counts, limits, what happened behind the scenes) goes
 * in `details`, closed by default. `action` is the one thing the user can do
 * about it.
 *
 * `role="status"` only for `ok`/`warn`: an `error` is announced as an alert so a
 * screen-reader user hears it even when focus is elsewhere.
 */
export function StatusNote({
  tone = 'ok',
  title,
  details,
  action,
  className = '',
}: {
  tone?: 'ok' | 'warn' | 'error'
  title: ReactNode
  details?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`border-l-2 px-4 py-3 ${className}`}
      style={{
        borderColor: tone === 'ok' ? 'var(--rule)' : 'var(--accent)',
        background: tone === 'ok' ? 'transparent' : 'var(--paper-raised)',
      }}
    >
      <p className="font-ui text-sm font-medium">{title}</p>
      {details && (
        <details className="mt-1">
          <summary
            className="font-data inline-flex min-h-11 cursor-pointer items-center text-xs uppercase tracking-widest"
            style={{ color: 'var(--ink-muted)' }}
          >
            Details
          </summary>
          <div className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {details}
          </div>
        </details>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
