/**
 * Routes that manage their own scrolling and own the full viewport height.
 *
 * This used to also drive the header's width, making the chrome go full bleed
 * on /write and stay centered everywhere else. That was reverted: a layout
 * that changes shape as you move between pages is worse than one that is
 * merely wider than its content, so the whole site now sits in one column.
 *
 * What remains is unrelated to width. The /write shell has a definite height
 * and `overflow-hidden`, so a page footer rendered beneath it would give the
 * document a second scroll axis and you could scroll the editor away
 * mid-sentence. The Footer checks this to render nothing there.
 */
export const FULL_HEIGHT_ROUTES = ['/write'] as const

export function ownsViewportHeight(pathname: string): boolean {
  return FULL_HEIGHT_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  )
}
