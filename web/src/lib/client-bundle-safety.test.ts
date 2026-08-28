import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Guards against a Node built-in reaching a `'use client'` bundle.
 *
 * Four times now, a client component imported something clean, which
 * imported something clean, which imported `fs` (or similar) three or four
 * hops down -- and Turbopack failed the *entire* build, not just the
 * offending route, because it fails the whole compilation on one bad
 * module. `tsc --noEmit` and the rest of the unit suite are blind to this:
 * neither ever loads the browser bundle, so both stay green while the site
 * is completely down.
 *
 * A lint rule that flags a direct `node:fs` import inside a `'use client'`
 * file would have caught ZERO of the four real leaks (see the table in
 * tasks/T27.md) -- every one was transitive. So this test does not inspect
 * files in isolation; it walks the import graph outward from every client
 * entry point and fails the moment it finds a Node built-in anywhere in that
 * reachable set, printing the full chain that got there.
 *
 * TRADEOFF: imports are found with a regex over the source text, not a real
 * TypeScript-compiler-API parse. That is honest, not a shortcut taken
 * quietly: a regex can in principle be fooled by unusual syntax (imports
 * built from string concatenation, re-exports through barrel files with
 * exotic re-export forms, etc.), where a full `ts.createProgram` walk would
 * not be. In this codebase, imports are all plain static
 * `import ... from '...'` / `export ... from '...'` / dynamic
 * `import('...')` / `require('...')` forms, so the regex sees everything
 * that matters, and it costs nothing beyond `node:fs` + `node:path`, both
 * already dev dependencies of the toolchain (no new package, per T27).
 */

const SRC_ROOT = path.resolve(__dirname, '..')

// Only `node:crypto` counts as a violation. Bare `crypto` is ambiguous --
// browsers (and this project's client bundles) have a real Web Crypto
// global (`globalThis.crypto`), so a bare `import ... from 'crypto'` is not
// automatically a Node-only leak the way `node:fs` unambiguously is.
const FORBIDDEN_BUILTINS = new Set([
  'fs',
  'node:fs',
  'path',
  'node:path',
  'os',
  'node:os',
  'child_process',
  'node:child_process',
  'node:crypto',
])

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, '.json']

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full))
    } else if (
      CODE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full)
    }
  }
  return out
}

/** Strips block and line comments so a specifier mentioned in prose (in
 *  backticks or otherwise) can't be mistaken for a real import. Regex-based,
 *  same tradeoff as the extractor below: good enough for this codebase's
 *  plain comment style, not a full lexer. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** First non-blank, non-comment line of the file is exactly `'use client'`
 *  (or double-quoted). Matches the four historical entry points plus any
 *  future one, without hardcoding a file list. */
function isClientEntry(source: string): boolean {
  const stripped = stripComments(source)
  const firstLine = stripped
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return firstLine === "'use client'" || firstLine === '"use client"'
}

/** Pulls every module specifier out of static imports/exports, dynamic
 *  `import(...)`, and `require(...)`. Does not resolve into node_modules; a
 *  bare specifier (no `.` or `@/` prefix) is either a forbidden builtin name
 *  (checked directly) or an external package, and external packages are out
 *  of scope for this walk -- the four real leaks were all internal modules. */
function extractSpecifiers(source: string): string[] {
  const clean = stripComments(source)
  const specifiers: string[] = []
  const patterns = [
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(clean))) {
      specifiers.push(m[1])
    }
  }
  return specifiers
}

function resolveToFile(candidateBase: string): string | null {
  if (fs.existsSync(candidateBase) && fs.statSync(candidateBase).isFile()) {
    return candidateBase
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidateBase + ext
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const asIndex = path.join(candidateBase, 'index' + ext)
    if (fs.existsSync(asIndex) && fs.statSync(asIndex).isFile()) return asIndex
  }
  return null
}

/** Resolves a specifier relative to the importing file. Returns `null` for
 *  bare (external / node_modules) specifiers that are not forbidden
 *  builtins -- those are not walked further. */
function resolveSpecifier(specifier: string, importerFile: string): string | null {
  if (specifier.startsWith('.')) {
    return resolveToFile(path.resolve(path.dirname(importerFile), specifier))
  }
  if (specifier.startsWith('@/')) {
    return resolveToFile(path.resolve(SRC_ROOT, specifier.slice(2)))
  }
  return null
}

function toDisplayPath(absPath: string): string {
  return path.relative(SRC_ROOT, absPath).split(path.sep).join('/')
}

/**
 * DFS from `file` looking for a reachable Node built-in. Returns the full
 * chain of display paths ending in the forbidden specifier name (e.g.
 * `node:fs`), or `null` if nothing forbidden is reachable.
 *
 * `pathStack` guards against cycles (the graph has them): a file already on
 * the current path is not re-entered. `safeCache` remembers files proven
 * clean so shared subtrees are not re-walked from every client entry point.
 */
function findForbiddenChain(
  file: string,
  chainSoFar: string[],
  pathStack: Set<string>,
  safeCache: Set<string>
): string[] | null {
  if (pathStack.has(file) || safeCache.has(file)) return null

  pathStack.add(file)
  const chain = [...chainSoFar, toDisplayPath(file)]
  const source = fs.readFileSync(file, 'utf8')

  for (const specifier of extractSpecifiers(source)) {
    if (FORBIDDEN_BUILTINS.has(specifier)) {
      pathStack.delete(file)
      return [...chain, specifier]
    }

    const resolved = resolveSpecifier(specifier, file)
    if (resolved) {
      const result = findForbiddenChain(resolved, chain, pathStack, safeCache)
      if (result) {
        pathStack.delete(file)
        return result
      }
    }
  }

  pathStack.delete(file)
  safeCache.add(file)
  return null
}

describe('client bundle safety', () => {
  const allFiles = listSourceFiles(SRC_ROOT)
  const clientEntries = allFiles.filter((f) => isClientEntry(fs.readFileSync(f, 'utf8')))

  it('finds at least one \'use client\' entry point (sanity check on the detector itself)', () => {
    // If this ever fails, the entry-point scan is broken and every other
    // assertion in this file is vacuously true -- catch that here first.
    expect(clientEntries.length).toBeGreaterThan(0)
  })

  it('no \'use client\' component transitively imports a Node built-in', () => {
    const safeCache = new Set<string>()
    const violations: string[] = []

    for (const entry of clientEntries) {
      const chain = findForbiddenChain(entry, [], new Set(), safeCache)
      if (chain) {
        violations.push(chain.join(' -> '))
      }
    }

    if (violations.length > 0) {
      const message =
        `${violations.length} client bundle(s) transitively import a Node built-in ` +
        `(fs/path/os/child_process/node:crypto). Turbopack fails the WHOLE build on ` +
        `one bad module, so this takes down every route, not just the offending page.\n\n` +
        `Fix: extract a pure module for the client-safe subset of logic (see ` +
        `stats-from-items.ts, clusters-from-items.ts, streak.ts, pokeapi-pure.ts for ` +
        `the shape) and import that instead of the module that pulls in the builtin.\n\n` +
        violations.map((v) => `  ${v}`).join('\n')
      throw new Error(message)
    }

    expect(violations).toEqual([])
  })
})
