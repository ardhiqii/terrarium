/**
 * In-process support for `/api/creature`: a stale-aware TTL cache for
 * computed responses, and a simple per-IP request counter.
 *
 * Both are plain module-scope `Map`s. That means both live for as long as
 * one server instance stays warm and are wiped on cold start or restart.
 * On a multi-instance deployment (Vercel scales to N lambdas), each
 * instance has its own copy, so this is not a distributed cache or a real
 * distributed rate limiter, just a first line of defense against a single
 * instance being hammered. Documented here rather than assumed.
 */

export interface CacheEntry<T> {
  value: T
  /** Timestamp after which the entry is stale and should be revalidated. */
  freshUntil: number
}

const cacheStore = new Map<string, CacheEntry<unknown>>()

/**
 * Returns the entry only while still fresh. A cache hit here must be the
 * ONLY thing standing between a request and a GitHub call, so this is the
 * function whose call site decides "may we skip the network entirely."
 */
export function cacheGetFresh<T>(key: string): T | undefined {
  const entry = cacheStore.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.freshUntil) return undefined
  return entry.value as T
}

/**
 * Returns the entry regardless of freshness, for the "GitHub is down, serve
 * something rather than nothing" path. Never triggers a network call itself.
 */
export function cacheGetStale<T>(key: string): T | undefined {
  const entry = cacheStore.get(key)
  return entry ? (entry.value as T) : undefined
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  cacheStore.set(key, { value, freshUntil: Date.now() + ttlMs })
}

/** Test-only: reset all in-process state between test cases. */
export function cacheClearAll(): void {
  cacheStore.clear()
  rateLimitStore.clear()
}

// ---------------------------------------------------------------------------
// Per-IP rate limiting
// ---------------------------------------------------------------------------

interface RateWindow {
  count: number
  windowStart: number
}

const rateLimitStore = new Map<string, RateWindow>()

export interface RateLimitResult {
  allowed: boolean
  remaining: number
}

/**
 * Fixed-window per-key counter (key is typically `ip:<address>`). Resets
 * whenever this server instance restarts and is scoped to this instance
 * only. A real deployment wanting an actual guarantee needs a shared store
 * (Redis, Vercel KV, etc.); this is a cheap first line of defense, not a
 * promise.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now()
  const existing = rateLimitStore.get(key)

  if (!existing || now - existing.windowStart >= windowMs) {
    rateLimitStore.set(key, { count: 1, windowStart: now })
    return { allowed: true, remaining: Math.max(0, limit - 1) }
  }

  existing.count += 1
  if (existing.count > limit) {
    return { allowed: false, remaining: 0 }
  }
  return { allowed: true, remaining: Math.max(0, limit - existing.count) }
}
