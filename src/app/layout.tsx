import type { Metadata } from 'next'
import { siteConfig } from '@/lib/site-config'
import { Geist, Geist_Mono, EB_Garamond } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
import './globals.css'

const geistSans = Geist({
  subsets: ['latin'],
  variable: '--font-sans',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

const ebGaramond = EB_Garamond({
  subsets: ['latin'],
  variable: '--font-serif',
})

export const metadata: Metadata = {
  title: {
    default: siteConfig.title,
    template: `%s · ${siteConfig.title}`,
  },
  description: siteConfig.description,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // THE SESSION IS DELIBERATELY NOT READ HERE. It used to be, and the Navbar
  // took a boolean prop. But reading a session means reading a cookie, and
  // per the Next 16 docs `cookies()` "will opt a route into dynamic
  // rendering" when used in a layout or page. In the root layout that
  // applies to the entire site, so every prerendered note, project, and tag
  // page would have become server-rendered just to decide whether one nav
  // link is visible. The Navbar now fetches `/api/auth/session` itself.
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${ebGaramond.variable}`}
    >
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <div className="min-h-[100dvh] flex flex-col">
            <Navbar />
            <main className="flex-1">
              {children}
            </main>
            <Footer />
          </div>
        </ThemeProvider>
      </body>
    </html>
  )
}
