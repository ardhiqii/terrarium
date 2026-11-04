import Link from 'next/link'

/**
 * Related pages as a row of links (`DESIGN.md` §7, rule R5): a user should be
 * able to navigate without reading a sentence to find the link inside it.
 */
export function RelatedLinks({
  links,
  label = 'Related pages',
  className = '',
}: {
  links: readonly { href: string; label: string }[]
  label?: string
  className?: string
}) {
  return (
    <nav
      aria-label={label}
      className={`font-data flex flex-wrap gap-x-5 text-xs uppercase tracking-widest ${className}`}
    >
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="inline-flex min-h-11 items-center underline decoration-dotted underline-offset-4 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--accent)' }}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  )
}
