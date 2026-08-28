import type { SyncedUser } from '@/lib/sync/types'
import { resolveStage } from '@/lib/game/stages'
import { isBroadRatio } from '@/lib/game/variants'
import { CreatureSprite } from '@/components/game/CreatureSprite'
import { XpBar } from '@/components/game/XpBar'
import Avatar from './Avatar'
import UnverifiedXpNote from './UnverifiedXpNote'

export interface ProfileSpecimenProps {
  user: SyncedUser
}

/**
 * A synced profile. Deliberately not a repeat of `/companions` (a
 * bordered grid of stat cells) or `/guide` (a long-form article with a
 * sticky table of contents): this reads as one mounted specimen, a single
 * raised plate holding the creature and its vitals, with the extra counts
 * folded into one quiet mono data line underneath rather than their own
 * grid of boxes.
 */
export async function ProfileSpecimen({ user }: ProfileSpecimenProps) {
  const { snapshot } = user
  const resolved = resolveStage(snapshot.totalXp)
  const companionCount = snapshot.companions.length
  const lastSynced = new Date(user.updatedAt)

  // `SyncedSnapshot` (src/lib/sync/types.ts) is frozen and carries only
  // noteCount/projectCount/totalWords/tagCount, never resolvedWikilinks,
  // maturityCounts, or a commit streak. That is enough to check `broad`
  // (tags per entry) honestly, but not `woven`, `deep`, or `steady`, which
  // this synced shape has no data for at all. Rather than guess, this
  // profile only ever shows `broad` and shows nothing for the other three.
  // Syncing the other three needs a schema-version bump; see the T30 report.
  const entryCount = snapshot.noteCount + snapshot.projectCount
  const variant = isBroadRatio(entryCount, snapshot.tagCount) ? 'broad' : null

  return (
    <div>
      <div
        className="p-6 sm:p-8"
        style={{
          background: 'var(--paper-raised)',
          border: '1px solid var(--rule)',
          boxShadow: '0 2px 12px -4px rgba(20, 20, 22, 0.12)',
        }}
      >
        <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 items-center sm:items-start">
          <div className="shrink-0 flex items-center justify-center">
            <CreatureSprite stage={snapshot.stage} scale={3} alt={resolved.stage.name} />
          </div>

          <div className="flex-1 w-full min-w-0">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <Avatar src={user.avatarUrl} handle={user.handle} size={28} />
              <a
                href={`https://github.com/${user.handle}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-ui text-lg font-semibold tracking-tight hover:opacity-70 transition-opacity"
              >
                @{user.handle}
              </a>
            </div>

            <p
              className="font-data text-xs uppercase tracking-widest mb-4"
              style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
            >
              Specimen {resolved.stage.index} of 4 . {resolved.stage.name}
              {variant && (
                <>
                  {' . '}
                  <span style={{ color: 'var(--accent)' }}>var. {variant}</span>
                </>
              )}
            </p>

            <XpBar
              xpIntoStage={resolved.xpIntoStage}
              xpForNextStage={resolved.xpForNextStage}
              progress={resolved.progress}
            />

            <div className="font-data flex items-baseline justify-between mt-4 text-xs flex-wrap gap-2">
              <span style={{ color: 'var(--ink-muted)' }}>
                {snapshot.totalXp.toLocaleString()} total xp . {companionCount.toLocaleString()}{' '}
                {companionCount === 1 ? 'companion' : 'companions'}
              </span>
              <span style={{ color: 'var(--ink-muted)' }}>
                synced{' '}
                <time dateTime={user.updatedAt}>
                  {lastSynced.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </span>
            </div>

            <p className="font-data text-xs mt-3" style={{ color: 'var(--ink-muted)' }}>
              {snapshot.noteCount.toLocaleString()} notes . {snapshot.projectCount.toLocaleString()}{' '}
              projects . {snapshot.tagCount.toLocaleString()} tags .{' '}
              {snapshot.totalWords.toLocaleString()} words
            </p>
          </div>
        </div>
      </div>

      <UnverifiedXpNote className="mt-4" />
    </div>
  )
}
