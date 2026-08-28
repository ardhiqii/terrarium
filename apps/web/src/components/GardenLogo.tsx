import GardenMark from './GardenMark'
import { siteConfig } from '@/lib/site-config'

interface GardenLogoProps {
  /** Size of the mark in px */
  markSize?: number
  /** Optional extra classes on the wrapper */
  className?: string
  /** Show the text name below the mark */
  showName?: boolean
}

export default function GardenLogo({
  markSize = 48,
  className = '',
  showName = true,
}: GardenLogoProps) {
  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <GardenMark size={markSize} />
      {showName && (
        <span
          className="font-ui text-sm font-semibold tracking-widest uppercase"
          style={{
            letterSpacing: '0.12em',
            color: 'var(--ink)',
          }}
        >
          {siteConfig.wordmark.lead}
          <span style={{ color: 'var(--accent)' }}>
            {siteConfig.wordmark.separator}
          </span>
          {siteConfig.wordmark.trail}
        </span>
      )}
    </div>
  )
}
