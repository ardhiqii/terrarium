import {
  XP_BY_EVENT_CATEGORY,
  xpAwardedForEvent,
  type EventCategory,
} from '@/lib/game/events'
import type { ProductState } from '@/lib/game/product-state'

const REWARD_RULES: readonly { category: EventCategory; label: string; note: string }[] = [
  { category: 'qualifying-active-day', label: 'Active workday', note: 'once per GitHub activity day' },
  { category: 'work-session', label: 'Work session', note: 'up to two capped sessions per day' },
  { category: 'merged-pull-request', label: 'Merged pull request', note: 'when you are the actor' },
  { category: 'published-release', label: 'Published release', note: 'drafts do not count' },
  { category: 'successful-ci', label: 'Successful CI', note: 'linked to your eligible pull request' },
]

const CATEGORY_LABELS: Readonly<Record<EventCategory, string>> = {
  'qualifying-active-day': 'active workday',
  'work-session': 'work session',
  'new-note': 'new note',
  'new-words': 'new words',
  'resolved-wikilink': 'resolved link',
  'merged-pull-request': 'merged pull request',
  'published-release': 'published release',
  'closed-linked-issue': 'closed linked issue',
  'successful-ci': 'successful CI',
}

function recentVerifiedEvents(state: ProductState) {
  return [...state.ledger.events]
    .filter((event) => event.source === 'github' && event.provenance === 'verified')
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, 5)
}

export function GitHubRewardGuide({ state }: { state: ProductState }) {
  const receipts = recentVerifiedEvents(state)

  return (
    <section
      className="mt-6 border p-5 sm:p-6"
      style={{ borderColor: 'var(--rule)', background: 'var(--paper-raised)' }}
      aria-labelledby="github-reward-guide-title"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
        <div>
          <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--accent)' }}>
            Reward map
          </p>
          <h2 id="github-reward-guide-title" className="font-ui mt-2 text-2xl font-semibold tracking-tight">
            Make progress you can explain.
          </h2>
          <p className="font-prose mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            A meaningful commit wakes an active workday and a session; the commit count itself is not an unlimited XP faucet. Every signal goes to your active companion and is capped by its activity window.
          </p>
        </div>
        <p className="font-data shrink-0 text-xs sm:text-right" style={{ color: 'var(--ink-muted)' }}>
          {receipts.length ? `${receipts.length} recent receipts` : 'No receipts yet'}
        </p>
      </div>

      <div className="mt-6 grid gap-3 border-t pt-5 sm:grid-cols-2 lg:grid-cols-3" style={{ borderColor: 'var(--rule)' }}>
        {REWARD_RULES.map((rule) => (
          <div key={rule.category} className="border-l-2 pl-3" style={{ borderColor: 'var(--accent)' }}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-ui text-sm font-medium">{rule.label}</p>
              <p className="font-data text-xs" style={{ color: 'var(--accent)' }}>+{XP_BY_EVENT_CATEGORY[rule.category]} xp</p>
            </div>
            <p className="font-prose mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>{rule.note}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--rule)' }}>
        <p className="font-data text-xs uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
          Verified receipts
        </p>
        {receipts.length ? (
          <ul className="mt-3 divide-y" style={{ borderColor: 'var(--rule)' }}>
            {receipts.map((event) => {
              const awardedXp = xpAwardedForEvent(state.ledger, event.eventId)
              return (
                <li key={event.eventId} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span className="font-ui">{CATEGORY_LABELS[event.category]}</span>
                  <span className="font-data shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {awardedXp > 0 ? `+${awardedXp} xp` : '0 xp · capped'}
                    {` · ${new Date(event.occurredAt).toLocaleDateString()}`}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="font-prose mt-3 text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            Your first sync establishes a clean baseline. The next qualifying GitHub activity will appear here with its source and XP value.
          </p>
        )}
      </div>
    </section>
  )
}
