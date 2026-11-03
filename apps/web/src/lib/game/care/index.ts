/**
 * The care layer's public surface.
 *
 * WHY A BARREL HERE AND NOWHERE ELSE UNDER `care/`: the point of the split in
 * `PLAN-living-companion.md` §4.4 is that renderers depend on ONE module, so a
 * future desktop app or hardware device cannot accidentally import
 * `state.ts`'s merge rules or `needs.ts`'s tuning constants and start making
 * care decisions of its own. Everything a renderer needs is re-exported here;
 * everything that is an implementation detail stays reachable only by path.
 *
 * Client-safe: no Node built-ins anywhere in this subtree (see
 * `client-bundle-safety.test.ts`).
 */

export {
  CARE_NEED_KEYS,
  CARE_ACTION_KINDS,
  CARE_ITEM_KINDS,
  buildCareScene,
  dayPartFor,
  localHour,
  poseForMood,
  type CareActionKind,
  type CareDialogueKey,
  type CareItemKind,
  type CareMood,
  type CareNeedKey,
  type CareNeeds,
  type CarePose,
  type CareRefusal,
  type CareScene,
  type DayPart,
} from './scene'

export {
  FUTURE_TOLERANCE_MS,
  SIGNAL_FRESHNESS_DAYS,
  SIGNAL_WINDOW_DAYS,
  cleanlinessFrom,
  daysSince,
  deriveCareSignals,
  deriveNeeds,
  dietFrom,
  energyFrom,
  healthFrom,
  hungerFrom,
  isDormant,
  localDay,
  needForAction,
  parseTimestamp,
  streakLength,
  usableTimestamp,
  type CareAnchors,
  type CareSignals,
  type DeriveCareSignalsOptions,
} from './needs'

export {
  CURIOUS_MOOD_MS,
  FOCUSED_MOOD_MS,
  RESTING_MOOD_MS,
  REWARD_MOOD_MS,
  deriveMood,
  type MoodInput,
} from './mood'

export {
  ITEM_DAILY_CAP,
  ITEM_INVENTORY_MAX,
  ITEM_SOURCE_COPY,
  MAX_MINT_RECORDS,
  MAX_TOY_DAYS,
  itemForCategory,
  planItemGrants,
  toyGrantFor,
  type ItemGrant,
} from './items'

export {
  careAnchors,
  createCareState,
  earliestStart,
  emptySpent,
  inventoryOf,
  mergeCareState,
  mintCareItems,
  spendItem,
  validateCareState,
  type CareMint,
  type CareState,
} from './state'

export {
  actionAvailability,
  applyCareAction,
  buildCareReadout,
  itemForAction,
  type ActionAvailability,
  type CareActionOutcome,
  type CareContext,
} from './actions'
