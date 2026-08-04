import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        // The local editor moved from /garden to /write when the nav label
        // changed. Permanent, so any bookmark or existing link survives.
        source: '/garden',
        destination: '/write',
        permanent: true,
      },
    ]
  },
  images: {
    // CreatureSprite renders PokeAPI's animated Generation-V sprites via a
    // plain <img>, not next/image, specifically because next/image would
    // need `unoptimized: true` on this pattern anyway (its optimizer strips
    // GIF animation), and a plain <img> with explicit width/height is
    // simpler while giving the same layout-shift protection. This
    // remotePattern is declared for any future consumer that does route
    // this host through next/image.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "raw.githubusercontent.com",
        pathname: "/PokeAPI/sprites/**",
      },
    ],
  },
};

export default nextConfig;
