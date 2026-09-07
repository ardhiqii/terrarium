/**
 * The species pool: multiple evolution LINES, not one. Each line maps every
 * `StageId` to a PokeAPI id, so a collection of repo creatures is not a pile
 * of identical creatures wearing different name tags.
 *
 * Every line is now ONE REAL Pokemon evolution family: stages 1-3 are the
 * genuine animated evolutions (sporeling -> mossling -> bracken -> the family's
 * final form), and stage 4 (`heartwood`) is that same family's Mega Evolution.
 * This fixes the old data, which stitched together four UNRELATED species that
 * merely increased in visual mass (e.g. Sunkern -> Oddish -> Ivysaur ->
 * Torterra) and read as a different Pokémon at every stage.
 *
 * Ids 1-649 use the animated generation-v black-white set (the only set with
 * animated sprites). Stage 4 (Mega) ids are all > 649 and are STATIC by
 * necessity: PokeAPI has no animated sprite for any Mega form (verified live),
 * so the resolver returns the static PNG. See `pokeapi.ts` / `source.ts` for
 * how that fallback is handled. The `languages` for each line are unchanged.
 */
import type { StageId } from '../types'

export interface SpeciesLine {
  id: string
  /** Display name for the line, e.g. shown in the companions collection. */
  name: string
  /** One sentence on the theme, for the collection view. */
  theme: string
  /**
   * Lowercase GitHub `language` values that map to this line. Matched
   * case-insensitively by `species-assign.ts`. A language listed on more
   * than one line is a data bug; `species.test.ts` guards against it.
   */
  languages: string[]
  stageToPokemonId: Record<StageId, number>
}

export const SPECIES_LINES: readonly SpeciesLine[] = [
  {
    id: 'grass',
    name: 'Grass line',
    theme: 'The original garden line. Default for unmatched languages.',
    languages: [],
    stageToPokemonId: {
      sporeling: 1, // Bulbasaur
      mossling: 2, // Ivysaur
      bracken: 3, // Venusaur
      heartwood: 10033, // Mega Venusaur
    },
  },
  {
    id: 'ember',
    name: 'Ember line',
    theme: 'Systems and compiled languages. Runs close to the metal, runs hot.',
    languages: ['c', 'c++', 'cpp', 'rust', 'zig', 'assembly', 'objective-c'],
    stageToPokemonId: {
      sporeling: 4, // Charmander
      mossling: 5, // Charmeleon
      bracken: 6, // Charizard
      heartwood: 10034, // Mega Charizard X
    },
  },
  {
    id: 'current',
    name: 'Current line',
    theme: 'The web. Event loops and sparks.',
    languages: ['javascript', 'typescript'],
    stageToPokemonId: {
      sporeling: 179, // Mareep
      mossling: 180, // Flaaffy
      bracken: 181, // Ampharos
      heartwood: 10045, // Mega Ampharos
    },
  },
  {
    id: 'tide',
    name: 'Tide line',
    theme: 'Managed runtimes. Java, C#, and friends flow through a virtual machine.',
    languages: ['java', 'kotlin', 'scala', 'c#', 'csharp', 'groovy', 'clojure'],
    stageToPokemonId: {
      sporeling: 258, // Mudkip
      mossling: 259, // Marshtomp
      bracken: 260, // Swampert
      heartwood: 10064, // Mega Swampert
    },
  },
  {
    id: 'bedrock',
    name: 'Bedrock line',
    theme: 'Data and scripting foundations. Slow, heavy, load-bearing.',
    languages: ['python', 'r', 'matlab', 'julia'],
    stageToPokemonId: {
      sporeling: 246, // Larvitar
      mossling: 247, // Pupitar
      bracken: 248, // Tyranitar
      heartwood: 10049, // Mega Tyranitar
    },
  },
  {
    id: 'venom',
    name: 'Venom line',
    theme: 'Dynamic scripting with bite.',
    languages: ['ruby', 'php', 'perl', 'lua'],
    stageToPokemonId: {
      sporeling: 92, // Gastly
      mossling: 93, // Haunter
      bracken: 94, // Gengar
      heartwood: 10038, // Mega Gengar
    },
  },
  {
    id: 'psychic',
    name: 'Psychic line',
    theme: 'Functional and academic languages. Abstract, precise, a little uncanny.',
    languages: ['haskell', 'ocaml', 'elixir', 'erlang', 'f#', 'fsharp', 'elm', 'lisp', 'scheme'],
    stageToPokemonId: {
      sporeling: 63, // Abra
      mossling: 64, // Kadabra
      bracken: 65, // Alakazam
      heartwood: 10037, // Mega Alakazam
    },
  },
  {
    id: 'steel',
    name: 'Steel line',
    theme: 'Infrastructure and config. Machinery, not prose.',
    languages: ['shell', 'dockerfile', 'yaml', 'hcl', 'makefile', 'powershell', 'nix'],
    stageToPokemonId: {
      sporeling: 374, // Beldum
      mossling: 375, // Metang
      bracken: 376, // Metagross
      heartwood: 10076, // Mega Metagross
    },
  },
  {
    id: 'bloom',
    name: 'Bloom line',
    theme: 'Markup and front-end frameworks. Light, colourful, decorative.',
    languages: ['css', 'html', 'dart', 'vue', 'svelte', 'scss', 'less'],
    stageToPokemonId: {
      sporeling: 280, // Ralts
      mossling: 281, // Kirlia
      bracken: 282, // Gardevoir
      heartwood: 10051, // Mega Gardevoir
    },
  },
] as const

export const DEFAULT_SPECIES_LINE_ID = 'grass'

const LINES_BY_ID = new Map(SPECIES_LINES.map((line) => [line.id, line]))

export function getSpeciesLine(id: string): SpeciesLine {
  return LINES_BY_ID.get(id) ?? LINES_BY_ID.get(DEFAULT_SPECIES_LINE_ID)!
}

export function getDefaultSpeciesLine(): SpeciesLine {
  return getSpeciesLine(DEFAULT_SPECIES_LINE_ID)
}

/**
 * Maximum id any line's ANIMATED stages (1-3) may reference. Animated sprites
 * stop existing above this. Stage 4 (heartwood, the Mega form) is exempt: it
 * is deliberately static (PokeAPI has no animated Mega sprite).
 */
export const MAX_ANIMATED_POKEMON_ID = 649

/**
 * The stage that renders the Mega form. Only this stage may exceed
 * `MAX_ANIMATED_POKEMON_ID` and appear as a static sprite; the three
 * evolution stages before it must stay animated (<= 649).
 */
export const MEGA_STAGE: StageId = 'heartwood'
