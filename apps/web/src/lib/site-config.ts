/**
 * Every piece of site branding lives here.
 *
 * The point is that someone can clone this repo, change this one file, and
 * have their own Terrarium. Nothing else should hardcode a name, a wordmark,
 * or an owner-specific pronoun. If you find branding anywhere else, it belongs here.
 */

export const siteConfig = {
  /**
   * The wordmark. `separator` renders in the accent colour between the two
   * halves, and is empty here on purpose.
   *
   * Terrarium is intentionally set as one plain word. The name already
   * carries the naturalist meaning, so the accent lives on the sprout's bud
   * where it actually signifies something.
   */
  wordmark: {
    lead: 'terrarium',
    separator: '',
    trail: '',
  },

  /** Used in `<title>`. Sub-pages render as `Page name · <title>`. */
  title: 'Terrarium',

  description:
    'A terrarium where writing notes and shipping code grow pixel creatures.',

  /**
   * Hero copy. Written in the second person so it reads correctly no matter
   * whose garden this is. Replace with your own voice if you prefer.
   */
  tagline:
    'Notes, projects, and half-formed ideas in various states of growth. Everything here is linked, and everything here grows something.',

  /**
   * GitHub handle whose public commit activity feeds the creature.
   * Set `GITHUB_LOGIN` in `.env.local`.
   */
  handle: process.env.GITHUB_LOGIN ?? '',

  /**
   * Optional. Shown in the footer when set, omitted when null, so a fork does
   * not accidentally ship someone else's name.
   */
  ownerName: null as string | null,
} as const

/** The wordmark as a plain string, for alt text and metadata. */
export function wordmarkText(): string {
  const { lead, separator, trail } = siteConfig.wordmark
  return `${lead}${separator}${trail}`
}
