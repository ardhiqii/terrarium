/**
 * The honesty requirement, in one reusable line. Commit XP can be checked
 * server-side against public GitHub activity; garden XP can't, because
 * notes stay on the writer's own device and never upload. Every surface
 * that shows another person's total must carry this, and none of them may
 * dress a self-reported number up as a verified one.
 */
export default function UnverifiedXpNote({ className = '' }: { className?: string }) {
  return (
    <p
      className={`font-prose text-xs leading-relaxed ${className}`}
      style={{ color: 'var(--ink-muted)' }}
    >
      Totals are as reported by each garden. Commit activity can be checked
      against public GitHub data, but note activity can&apos;t, since notes
      never leave the writer&apos;s own device.
    </p>
  )
}
