import Image from 'next/image'

interface FigureProps {
  src: string
  alt: string
  caption?: string
  width?: number
  height?: number
}

export function Figure({ src, alt, caption, width = 1200, height = 630 }: FigureProps) {
  return (
    <figure className="my-8">
      <div className="overflow-hidden border" style={{ borderColor: 'var(--rule)' }}>
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="w-full h-auto"
          style={{ display: 'block' }}
        />
      </div>
      {caption && (
        <figcaption
          className="font-ui mt-2 text-sm text-center"
          style={{ color: 'var(--ink-muted)' }}
        >
          {caption}
        </figcaption>
      )}
    </figure>
  )
}

interface YoutubeProps {
  id: string
  title?: string
}

export function Youtube({ id, title = 'YouTube video' }: YoutubeProps) {
  return (
    <div className="my-8">
      <div
        className="overflow-hidden border"
        style={{ borderColor: 'var(--rule)', paddingBottom: '56.25%', position: 'relative', height: 0 }}
      >
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 0 }}
        />
      </div>
    </div>
  )
}

type CalloutType = 'info' | 'warning' | 'tip' | 'danger'

interface CalloutProps {
  type?: CalloutType
  title?: string
  children: React.ReactNode
}

// Neutral archive treatment: type differentiates by a mono label, not a hue.
// The single accent stays reserved for links and the project marker.
const CALLOUT_LABELS: Record<CalloutType, string> = {
  info: 'Note',
  warning: 'Caution',
  tip: 'Tip',
  danger: 'Warning',
}

export function Callout({ type = 'info', title, children }: CalloutProps) {
  const label = title ?? CALLOUT_LABELS[type]
  return (
    <div
      className="my-6 p-4 border-l-2"
      style={{ background: 'var(--paper-raised)', borderLeftColor: 'var(--ink-muted)' }}
    >
      <p className="font-data text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </p>
      <div className="font-ui text-sm [&>p]:mb-0 [&>p:last-child]:mb-0">{children}</div>
    </div>
  )
}
