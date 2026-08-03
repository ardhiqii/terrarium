/**
 * Minimal ambient types for `node:sqlite`, built into Node 22.14 but not yet
 * described by the `@types/node` version pinned in this project (20.x). Only
 * the surface `sqlite-store.ts` actually uses is declared; extend if a
 * future change needs more of the real API.
 *
 * See https://nodejs.org/api/sqlite.html for the full API this is a subset
 * of. No new dependency: this is a type-only declaration, not a shim.
 */
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }

  export class StatementSync {
    run(...params: unknown[]): StatementResultingChanges
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }

  export class DatabaseSync {
    constructor(location: string, options?: Record<string, unknown>)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
