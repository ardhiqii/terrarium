interface GardenMarkProps {
  size?: number
  className?: string
}

/**
 * Clean geometric garden mark — a centered plant with two
 * balanced leaves, a stem, bud at top, and a ground line.
 * Native viewBox: 40 × 48
 */
export default function GardenMark({ size = 40, className }: GardenMarkProps) {
  const h = Math.round((size * 48) / 40)

  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 40 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Ground line */}
      <path
        d="M10 43 Q20 41 30 43"
        stroke="#7c5233"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Stem */}
      <line
        x1="20" y1="43"
        x2="20" y2="9"
        stroke="#4a7c59"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Left leaf — emerges lower on stem, sweeps left */}
      <path
        d="M20 28 C20 28 4 26 4 16 C4 9 13 10 20 24"
        fill="#4a7c59"
      />

      {/* Right leaf — emerges higher on stem, sweeps right, lighter */}
      <path
        d="M20 22 C20 22 36 20 36 10 C36 3 27 4 20 18"
        fill="#7cbf8e"
      />

      {/* Bud at tip */}
      <circle cx="20" cy="8" r="3" fill="#4a7c59" />
    </svg>
  )
}
