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
      <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--border)' }}>
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
          className="mt-2 text-sm text-center"
          style={{ color: 'var(--muted)' }}
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
        className="overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--border)', paddingBottom: '56.25%', position: 'relative', height: 0 }}
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

const CALLOUT_STYLES: Record<CalloutType, { bg: string; border: string; icon: string }> = {
  info: { bg: 'rgba(59,130,246,0.08)', border: '#3b82f6', icon: 'ℹ' },
  warning: { bg: 'rgba(234,179,8,0.08)', border: '#eab308', icon: '⚠' },
  tip: { bg: 'rgba(34,197,94,0.08)', border: '#22c55e', icon: '💡' },
  danger: { bg: 'rgba(239,68,68,0.08)', border: '#ef4444', icon: '🚫' },
}

export function Callout({ type = 'info', title, children }: CalloutProps) {
  const style = CALLOUT_STYLES[type]
  return (
    <div
      className="my-6 rounded-xl p-4 border-l-4"
      style={{ background: style.bg, borderLeftColor: style.border }}
    >
      <div className="flex items-start gap-3">
        <span className="text-base flex-shrink-0 mt-0.5">{style.icon}</span>
        <div>
          {title && (
            <p className="font-semibold text-sm mb-1" style={{ fontFamily: 'Inter, sans-serif' }}>
              {title}
            </p>
          )}
          <div className="text-sm [&>p]:mb-0 [&>p:last-child]:mb-0">{children}</div>
        </div>
      </div>
    </div>
  )
}
