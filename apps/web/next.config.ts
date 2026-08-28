import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets someone open the dev server from their phone or another machine.
  //
  // Next blocks cross-origin requests to `/_next/*` dev assets by default,
  // allowing only the hostname the server booted with (localhost). Hitting
  // the dev server by LAN or tailnet IP therefore returns 403 for every JS
  // chunk while the server-rendered HTML still arrives with a 200. The page
  // looks like it loaded and is simply dead: nothing hydrates, so no effect
  // ever runs. `/graph` shows this most clearly because it gates on a
  // mounted flag and sits at "Loading graph." forever, but every client
  // component is affected the same way — nav menu, theme toggle, search,
  // the `/write` editor.
  //
  // Matching is per dot-separated segment (see `isCsrfOriginAllowed` in
  // Next), so `*` works on an IP octet. Ranges rather than fixed addresses
  // because DHCP and tailnet addresses differ per device, and a teammate
  // should not have to edit tracked config to load the page.
  //
  // Dev-only: `next build`/`next start` ignore this, so it widens nothing in
  // production. It is deliberately limited to private ranges — a public
  // wildcard here would let any page you happened to visit read your dev
  // server's source while it is running.
  allowedDevOrigins: [
    '192.168.*.*', // home/office LAN
    '10.*.*.*', // private range, some routers and VPNs
    '172.16.*.*', // Docker default bridge and similar
    '100.*.*.*', // Tailscale (CGNAT 100.64.0.0/10)
  ],
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
