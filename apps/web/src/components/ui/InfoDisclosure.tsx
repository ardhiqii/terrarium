import Link from 'next/link'
import type { ReactNode } from 'react'
import type { GuideAnchor } from '@/lib/copy'

/**
 * "How it works" text, one click away (`DESIGN.md` §7, tier T2).
 *
 * WHY <details>: no state, no JavaScript, keyboard-operable, and announced
 * correctly by assistive tech, the same choice as the home page's observation
 * log (`PRODUCT.md` §11.6). It also works unchanged inside both server and client
 * components, because it has no hooks.
 *
 * Not a hover tooltip: hover does not exist on touch, and a tooltip's text is
 * easy to miss with a screen reader.
 */
export function InfoDisclosure({
  label = 'How it works',
  guide,
  children,
  className = '',
}: {
  label?: string
  /** Optional `/guide` section for the full explanation. */
  guide?: GuideAnchor
  children: ReactNode
  className?: string
}) {
  return (
    <details className={`group ${className}`}>
      <summary
        className="font-data inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-xs uppercase tracking-widest hover:opacity-70 transition-opacity"
        style={{ color: 'var(--ink-muted)' }}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none"
          style={{ borderColor: 'var(--rule)' }}
        >
          ?
        </span>
        {label}
      </summary>
      <div
        className="font-prose mt-1 max-w-2xl border-l-2 pl-4 text-sm leading-relaxed"
        style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
      >
        {children}
        {guide && (
          <p className="mt-2">
            <Link
              href={`/guide#${guide}`}
              className="underline decoration-dotted underline-offset-2 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--accent)' }}
            >
              More in the guide
            </Link>
          </p>
        )}
      </div>
    </details>
  )
}
