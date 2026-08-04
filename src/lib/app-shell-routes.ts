/**
 * Routes that own the full viewport instead of sitting in a centered column.
 *
 * An app-shell route has its own internal scroll regions and fills the width
 * edge to edge, so the site chrome has to match it: a centered 1024px header
 * above a full-bleed editor aligns with nothing and reads as a mistake, and a
 * page footer underneath would give the document a second scroll axis.
 *
 * Shared rather than duplicated because both the Navbar and the Footer need
 * the same answer, and two copies would drift the moment a second shell route
 * lands. Plain module, no 'use client': it is just data plus a predicate, and
 * both callers are already client components.
 */
export const APP_SHELL_ROUTES = ['/write'] as const

export function isAppShellRoute(pathname: string): boolean {
  return APP_SHELL_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  )
}
