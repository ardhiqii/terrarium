/**
 * The honesty requirement, in one reusable line. Commit XP can be checked
 * server-side against public GitHub activity; garden XP can't, because
 * notes stay on the writer's own device and never upload. Every surface
 * that shows another person's total must carry this, and none of them may
 * dress a self-reported number up as a verified one.
 */
import Link from 'next/link'

export default function UnverifiedXpNote({ className = '' }: { className?: string }) {
  return (
    <p
      className={`font-prose text-xs leading-relaxed ${className}`}
      style={{ color: 'var(--ink-muted)' }}
    >
      Self-reported totals. Note XP can&apos;t be verified.{' '}
      <Link href="/guide#privacy" className="underline decoration-dotted underline-offset-2" style={{ color: 'var(--accent)' }}>
        Why
      </Link>
    </p>
  )
}
