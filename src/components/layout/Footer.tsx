import Link from 'next/link'

export default function Footer() {
  return (
    <footer
      className="border-t mt-20 py-10"
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm" style={{ color: 'var(--muted)' }}>
        <p>Aufa&apos;s garden — ideas in various states of growth.</p>
        <nav className="flex gap-4">
          <Link href="/graph" className="hover:opacity-70 transition-opacity">Graph</Link>
          <Link href="/tags" className="hover:opacity-70 transition-opacity">Tags</Link>
          <Link href="/search" className="hover:opacity-70 transition-opacity">Search</Link>
        </nav>
      </div>
    </footer>
  )
}
