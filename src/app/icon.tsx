import { ImageResponse } from 'next/og'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
        }}
      >
        <svg
          width="28"
          height="34"
          viewBox="0 0 40 48"
          fill="none"
        >
          {/* Ground */}
          <path d="M10 43 Q20 41 30 43" stroke="#7c5233" strokeWidth="2" strokeLinecap="round" />
          {/* Stem */}
          <line x1="20" y1="43" x2="20" y2="9" stroke="#4a7c59" strokeWidth="2" strokeLinecap="round" />
          {/* Left leaf */}
          <path d="M20 28 C20 28 4 26 4 16 C4 9 13 10 20 24" fill="#4a7c59" />
          {/* Right leaf */}
          <path d="M20 22 C20 22 36 20 36 10 C36 3 27 4 20 18" fill="#7cbf8e" />
          {/* Bud */}
          <circle cx="20" cy="8" r="3" fill="#4a7c59" />
        </svg>
      </div>
    ),
    { ...size }
  )
}
