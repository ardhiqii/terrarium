/**
 * Every piece of site branding lives here.
 *
 * The point is that someone can clone this repo, change this one file, and
 * have their own garden. Nothing else should hardcode a name, a wordmark, or
 * a personal pronoun. If you find branding anywhere else, it belongs here.
 */

export const siteConfig = {
  /**
   * The wordmark. `separator` renders in the accent colour between the two
   * halves, and is empty here on purpose.
   *
   * The dot device came from `ardhiqi.garden`, where it read as domain-like:
   * owner dot thing. Applying it to a single word gives `terra.rium`, which
   * splits at a point that means nothing. "terra" is Latin for earth, "rium"
   * is a suffix fragment with no meaning on its own. It looks clever and is
   * not, so the wordmark is plain and the accent lives on the sprout's bud
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
    'A digital garden where writing notes and shipping code grow pixel creatures.',

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
