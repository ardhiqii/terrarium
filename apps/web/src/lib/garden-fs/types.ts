/**
 * Contract for reading and writing a user's garden folder from the browser.
 *
 * THIS FILE IS THE INTERFACE BOUNDARY between the folder-access layer (T23)
 * and the editor (T24). Both build against it. Do not change a shape here
 * without updating every consumer, and do not create module-local duplicates.
 *
 * The whole point of this layer: the user's markdown files stay on their own
 * disk. Nothing uploads. The browser is the interface, the disk is the
 * storage. See docs/archive/tasks/PHASE3.md for the decisions behind that.
 */

/** A single markdown file in the connected folder. */
export interface GardenFile {
  /** Filename including extension, e.g. `my-note.md`. Unique within a folder. */
  name: string
  /** Raw file text, frontmatter included. */
  content: string
  /** Last modified time in ms, when the platform reports it. */
  lastModified?: number
}

/**
 * Read and write access to one folder of markdown.
 *
 * Implementations must treat `.md` and `.mdx` as equivalent, since an
 * Obsidian vault uses `.md` and this project's own content uses `.mdx`.
 *
 * Every method rejects rather than throwing synchronously, and callers are
 * expected to handle a revoked permission at any time: the user can withdraw
 * folder access from browser settings between two calls.
 */
export interface GardenSource {
  /** Human-readable folder name, for display. */
  readonly name: string

  /** Every markdown file in the folder. Non-markdown files are ignored. */
  list(): Promise<GardenFile[]>

  /** Raw contents, or null when the file does not exist. */
  read(name: string): Promise<string | null>

  /** Creates or overwrites. Callers pass the full file text with frontmatter. */
  write(name: string, content: string): Promise<void>

  /** No-op when the file is already absent. */
  remove(name: string): Promise<void>

  /**
   * Renames a file. This moves bytes only.
   *
   * It does NOT rewrite `[[wikilinks]]` pointing at the old title, and it must
   * not try to: link rewriting is the editor's job because it needs to parse
   * titles, and doing it here would split that logic across two layers. See
   * `rewriteWikilinks` in the editor task.
   */
  rename(from: string, to: string): Promise<void>
}

/**
 * Connection lifecycle for the File System Access API.
 *
 * The directory handle is persisted (IndexedDB) so a returning user is not
 * re-prompted, but the browser can still revoke permission, so `restore` may
 * legitimately return null even after a successful earlier `connect`.
 */
export interface GardenConnection {
  /**
   * False on browsers without the File System Access API, which today means
   * everything outside Chromium. Callers MUST degrade rather than break:
   * a Firefox or Safari user still gets the commits-only creature.
   */
  isSupported(): boolean

  /** Prompts the folder picker. Null when the user cancels. */
  connect(): Promise<GardenSource | null>

  /** Reconnects a previously granted folder. Null when unavailable or revoked. */
  restore(): Promise<GardenSource | null>

  /** Forgets the stored handle. Does not touch any file. */
  disconnect(): Promise<void>
}

/** Why a garden is not currently readable. Drives the empty-state copy. */
export type GardenStatus =
  | { kind: 'unsupported' }
  | { kind: 'disconnected' }
  | { kind: 'permission-denied' }
  | { kind: 'connected'; source: GardenSource }

/** Extensions treated as markdown. `.mdx` is a superset of `.md` for our purposes. */
export const MARKDOWN_EXTENSIONS = ['.md', '.mdx'] as const

export function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
