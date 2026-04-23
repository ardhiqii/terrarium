import GardenMark from './GardenMark'

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
          className="text-sm font-semibold tracking-widest uppercase"
          style={{
            fontFamily: 'Inter, sans-serif',
            letterSpacing: '0.12em',
            color: 'var(--foreground)',
          }}
        >
          ardhiqi<span style={{ color: 'var(--note-color)' }}>·</span>garden
        </span>
      )}
    </div>
  )
}
