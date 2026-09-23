'use client'

/**
 * Progress for a running GitHub sync.
 *
 * A sync reads up to 25 repositories back to back, which can take long enough
 * that a bare "Syncing…" label is indistinguishable from a frozen page. This
 * reports the two things that are actually known while the read is in flight:
 * which repository is being read out of how many, and how many HTTP requests
 * have completed.
 *
 * Deliberately presentational: no fetching, no state, no Node built-ins, so it
 * stays safe inside a `'use client'` tree and cheap to re-render. All the
 * arithmetic lives in `@/lib/sync/sync-progress`, which is unit tested.
 */

import { syncProgressView } from '@/lib/sync/sync-progress'

export interface SyncProgressProps {
  /** 1-based index of the repository being read; 0 before the first one starts. */
  repositoryIndex: number
  /** Total repositories this sync will read. 0 means "not known yet". */
  repositoryCount: number
  /** `owner/name` of the repository currently being read. */
  repository: string
  /** Completed HTTP requests so far. */
  requestsDone: number
}

export function SyncProgress(props: SyncProgressProps) {
  const view = syncProgressView(props)

  return (
    <div className="mt-4" data-testid="sync-progress">
      <div
        role="progressbar"
        aria-label="GitHub sync progress"
        aria-valuemin={0}
        aria-valuemax={view.determinate ? props.repositoryCount : undefined}
        aria-valuenow={view.determinate ? view.index : undefined}
        aria-valuetext={view.ariaText}
        className="relative h-[3px] w-full overflow-hidden"
        style={{ background: 'var(--rule)' }}
      >
        <span
          aria-hidden="true"
          data-testid="sync-progress-fill"
          data-determinate={view.determinate ? 'true' : 'false'}
          // Only transform and opacity animate, so the bar never triggers layout.
          className={
            view.determinate
              ? 'absolute inset-y-0 left-0 block w-full origin-left transition-transform duration-500 ease-out motion-reduce:transition-none'
              : 'absolute inset-y-0 left-0 block w-full origin-left opacity-40 motion-safe:animate-pulse'
          }
          style={{
            background: 'var(--accent)',
            transform: view.determinate ? `scaleX(${view.fraction})` : undefined,
          }}
        />
      </div>

      <p
        role="status"
        aria-live="polite"
        className="font-data mt-2 text-xs leading-relaxed"
        style={{ color: 'var(--ink-muted)' }}
      >
        <span className="break-all" style={{ color: 'var(--ink)' }}>
          {view.label}
        </span>
        {view.determinate && (
          <>
            {' · '}
            <span>
              {view.index}/{props.repositoryCount}
            </span>
            {' repositories · '}
            <span>{view.percent}%</span>
          </>
        )}
        {!view.determinate && ' · reading…'}
        {' · '}
        <span>{view.requests}</span>
        {' requests'}
      </p>
    </div>
  )
}
