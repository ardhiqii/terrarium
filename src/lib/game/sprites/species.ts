/**
 * The species pool: multiple evolution LINES, not one. Each line maps every
 * `StageId` to a PokeAPI id, exactly like the original single-line
 * `STAGE_TO_POKEMON_ID` in `pokeapi.ts` did, but there are now several of
 * them so a collection of repo creatures is not a pile of identical
 * creatures wearing different name tags.
 *
 * Every id in this file MUST stay at or below 649: animated sprites only
 * exist for the generation-v black-white set, which covers National Dex
 * ids 1 through 649 (see `pokeapi.ts`). Every id below was checked live
 * against the documented URL pattern
 * (`.../generation-v/black-white/animated/<id>.gif`) before being added
 * here; see the T19 report for the verification transcript.
 *
 * Lines deliberately reuse the original project's approach of stitching
 * together species that are NOT one real Pokemon evolution family (the
 * original sporeling/mossling/bracken/heartwood line was Sunkern -> Oddish
 * -> Ivysaur -> Torterra, four unrelated species chosen for a clean mass
 * ramp). Every line here follows the same rule: four ids, increasing in
 * visual mass/complexity, that read as a single growing creature across the
 * four stages, whether or not they are a real family in the source games.
 *
 * `species-assign.ts` maps a repo's characteristics onto one of these lines
 * by id. `grass` is both the pool's default entry and the exact line the
 * original single-species system used, so the owner's own GARDEN creature
 * (which never goes through species assignment, see repo-creature.ts and
 * state.ts) renders identically to before this task.
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
      sporeling: 191, // Sunkern: a tiny seed, the smallest possible read.
      mossling: 43, // Oddish: small leafy bulb, a clear step up.
      bracken: 2, // Ivysaur: fuller plant, mid mass.
      heartwood: 389, // Torterra: a tree growing on its back.
    },
  },
  {
    id: 'ember',
    name: 'Ember line',
    theme: 'Systems and compiled languages. Runs close to the metal, runs hot.',
    languages: ['c', 'c++', 'cpp', 'rust', 'zig', 'assembly', 'objective-c'],
    stageToPokemonId: {
      sporeling: 255, // Torchic
      mossling: 4, // Charmander
      bracken: 5, // Charmeleon
      heartwood: 6, // Charizard
    },
  },
  {
    id: 'current',
    name: 'Current line',
    theme: 'The web. Event loops and sparks.',
    languages: ['javascript', 'typescript'],
    stageToPokemonId: {
      sporeling: 172, // Pichu
      mossling: 25, // Pikachu
      bracken: 125, // Electabuzz
      heartwood: 466, // Electivire
    },
  },
  {
    id: 'tide',
    name: 'Tide line',
    theme: 'Managed runtimes. Java, C#, and friends flow through a virtual machine.',
    languages: ['java', 'kotlin', 'scala', 'c#', 'csharp', 'groovy', 'clojure'],
    stageToPokemonId: {
      sporeling: 258, // Mudkip
      mossling: 7, // Squirtle
      bracken: 8, // Wartortle
      heartwood: 9, // Blastoise
    },
  },
  {
    id: 'bedrock',
    name: 'Bedrock line',
    theme: 'Data and scripting foundations. Slow, heavy, load-bearing.',
    languages: ['python', 'r', 'matlab', 'julia'],
    stageToPokemonId: {
      sporeling: 74, // Geodude
      mossling: 75, // Graveler
      bracken: 76, // Golem
      heartwood: 208, // Steelix
    },
  },
  {
    id: 'venom',
    name: 'Venom line',
    theme: 'Dynamic scripting with bite.',
    languages: ['ruby', 'php', 'perl', 'lua'],
    stageToPokemonId: {
      sporeling: 23, // Ekans
      mossling: 24, // Arbok
      bracken: 336, // Seviper
      heartwood: 130, // Gyarados
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
      heartwood: 150, // Mewtwo
    },
  },
  {
    id: 'steel',
    name: 'Steel line',
    theme: 'Infrastructure and config. Machinery, not prose.',
    languages: ['shell', 'dockerfile', 'yaml', 'hcl', 'makefile', 'powershell', 'nix'],
    stageToPokemonId: {
      sporeling: 81, // Magnemite
      mossling: 82, // Magneton
      bracken: 375, // Metang
      heartwood: 376, // Metagross
    },
  },
  {
    id: 'bloom',
    name: 'Bloom line',
    theme: 'Markup and front-end frameworks. Light, colourful, decorative.',
    languages: ['css', 'html', 'dart', 'vue', 'svelte', 'scss', 'less'],
    stageToPokemonId: {
      sporeling: 187, // Hoppip
      mossling: 188, // Skiploom
      bracken: 189, // Jumpluff
      heartwood: 407, // Roserade
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

/** Maximum id any line may reference. Animated sprites stop existing above this. */
export const MAX_ANIMATED_POKEMON_ID = 649
