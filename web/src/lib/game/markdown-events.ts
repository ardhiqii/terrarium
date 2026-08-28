/**
 * Turns two local Markdown scans into normalized, local-provenance events.
 * Contents are inspected in memory and never included in an event payload.
 */
import { asCompanionId, makeEventId, type CompanionId, type EventCap, type NormalizedEvent } from './events'

export interface MarkdownFileSnapshot {
  path: string
  content: string
  modifiedAt: string
}

export interface MarkdownEventInput {
  sourceId: string
  companionId: CompanionId | string
  previous: readonly MarkdownFileSnapshot[]
  current: readonly MarkdownFileSnapshot[]
}

function normalizePath(value: string): string {
  const path = value.trim().replaceAll('\\', '/')
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new TypeError(`Invalid Markdown path: ${value}`)
  }
  return path
}

function iso(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`Invalid Markdown timestamp: ${value}`)
  return parsed.toISOString()
}

function wordCount(content: string): number {
  return content
    .replace(/^---[\s\S]*?---\s*/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length
}

function links(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/gu)]
    .map((match) => match[1].trim().toLowerCase())
    .filter(Boolean)
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16)
}

function cap(sourceId: string, day: string, category: 'qualifying-active-day' | 'work-session'): EventCap {
  return {
    key: `mounted-markdown:${sourceId}:${day}:${category}`,
    limit: category === 'work-session' ? 2 : 1,
  }
}

function event(
  input: MarkdownEventInput,
  nativeId: string,
  category: NormalizedEvent['category'],
  occurredAt: string,
  metadata?: Readonly<Record<string, string | number | boolean>>,
  eventCap?: EventCap,
): NormalizedEvent {
  return {
    eventId: makeEventId('mounted-markdown', input.sourceId, nativeId),
    companionId: asCompanionId(input.companionId),
    source: 'mounted-markdown',
    sourceId: input.sourceId,
    provenance: 'local',
    category,
    occurredAt,
    ...(eventCap ? { cap: eventCap } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

/** Normalize a scan transition. The first scan should use an empty previous list only for a new folder. */
export function normalizeMarkdownEvents(input: MarkdownEventInput): readonly NormalizedEvent[] {
  const sourceId = input.sourceId.trim()
  if (!sourceId) throw new TypeError('sourceId must be a non-empty string')
  const normalizedInput = { ...input, sourceId, companionId: asCompanionId(input.companionId) }
  const before = new Map(input.previous.map((file) => [normalizePath(file.path), file]))
  const after = new Map(
    input.current.map((file) => [normalizePath(file.path), { ...file, modifiedAt: iso(file.modifiedAt) }]),
  )
  const events: NormalizedEvent[] = []
  const activity: Array<{ id: string; occurredAt: string }> = []

  for (const [path, file] of after) {
    const previous = before.get(path)
    const changed = !previous || previous.content !== file.content
    if (!changed) continue

    if (!previous) {
      events.push(event(normalizedInput, `new-note:${path}`, 'new-note', file.modifiedAt, { path }))
    }

    const oldWords = previous ? wordCount(previous.content) : 0
    const newWords = wordCount(file.content)
    const additionalBuckets = Math.max(0, Math.floor((newWords - oldWords) / 100))
    const revision = hash(file.content)
    for (let bucket = 1; bucket <= additionalBuckets; bucket += 1) {
      events.push(event(normalizedInput, `words:${path}:${revision}:${bucket}`, 'new-words', file.modifiedAt, { bucket }))
    }

    const oldLinks = new Set(previous ? links(previous.content) : [])
    const knownTitles = new Set([...after.keys()].map((item) => item.replace(/\.(?:md|mdx)$/iu, '').split('/').pop()!.toLowerCase()))
    for (const target of [...new Set(links(file.content))]) {
      if (!oldLinks.has(target) && knownTitles.has(target)) {
        events.push(event(normalizedInput, `wikilink:${path}:${target}`, 'resolved-wikilink', file.modifiedAt, { path }))
      }
    }

    activity.push({ id: `file:${path}:${revision}`, occurredAt: file.modifiedAt })
  }

  const activityByDay = new Map<string, Array<{ id: string; occurredAt: string }>>()
  for (const item of activity) {
    const day = item.occurredAt.slice(0, 10)
    const current = activityByDay.get(day) ?? []
    current.push(item)
    activityByDay.set(day, current)
  }
  for (const [day, items] of activityByDay) {
    const ordered = [...items].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
    events.push(event(normalizedInput, `active-day:${day}`, 'qualifying-active-day', ordered[0].occurredAt, { activityCount: items.length }, cap(sourceId, day, 'qualifying-active-day')))
    const sessions = new Map<number, typeof items>()
    for (const item of items) {
      const minutes = new Date(item.occurredAt).getUTCHours() * 60 + new Date(item.occurredAt).getUTCMinutes()
      const bucket = Math.floor(minutes / 120)
      const current = sessions.get(bucket) ?? []
      current.push(item)
      sessions.set(bucket, current)
    }
    for (const [bucket, session] of sessions) {
      const first = [...session].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))[0]
      events.push(event(normalizedInput, `work-session:${day}:${bucket}`, 'work-session', first.occurredAt, { activityCount: session.length }, cap(sourceId, day, 'work-session')))
    }
  }

  return events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId))
}
