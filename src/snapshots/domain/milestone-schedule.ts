const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** A token with no trades for this long is dead: its schedule stops. */
export const DEAD_AFTER_MS = DAY_MS;

/**
 * Logarithmic schedule: dense while most tokens live or die, sparse for survivors. After `d7`
 * it continues weekly (`w2`, `w3`, ...) while the token is active.
 */
const FIXED_MILESTONES: readonly (readonly [string, number])[] = [
  ["0m", 0],
  ["1m", MINUTE_MS],
  ["5m", 5 * MINUTE_MS],
  ["10m", 10 * MINUTE_MS],
  ["15m", 15 * MINUTE_MS],
  ["30m", 30 * MINUTE_MS],
  ["1h", HOUR_MS],
  ["2h", 2 * HOUR_MS],
  ["4h", 4 * HOUR_MS],
  ["6h", 6 * HOUR_MS],
  ["12h", 12 * HOUR_MS],
  ["24h", DAY_MS],
  ["d2", 2 * DAY_MS],
  ["d3", 3 * DAY_MS],
  ["d4", 4 * DAY_MS],
  ["d5", 5 * DAY_MS],
  ["d6", 6 * DAY_MS],
  ["d7", 7 * DAY_MS],
];

export const FIRST_MILESTONE = "0m";
const FIRST_WEEK = 2;
const WEEKLY = /^w(\d+)$/;

const weekNumber = (name: string): number | null => {
  const match = WEEKLY.exec(name);
  const week = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isInteger(week) && week >= FIRST_WEEK ? week : null;
};

/** Time after creation at which a scheduled milestone is due, or null for event and unknown names. */
export const milestoneOffsetMs = (name: string): number | null => {
  const fixed = FIXED_MILESTONES.find(([milestone]) => milestone === name);
  if (fixed !== undefined) return fixed[1];
  const week = weekNumber(name);
  return week === null ? null : week * WEEK_MS;
};

/** The scheduled milestone after `name`. */
export const followingMilestone = (name: string): string => {
  const index = FIXED_MILESTONES.findIndex(([milestone]) => milestone === name);
  if (index >= 0) return FIXED_MILESTONES[index + 1]?.[0] ?? `w${FIRST_WEEK}`;
  const week = weekNumber(name);
  if (week === null) throw new Error(`Unknown milestone ${name}`);
  return `w${week + 1}`;
};

export interface DueMilestone {
  /** Milestone to take now. */
  readonly milestone: string;
  readonly following: string;
  readonly followingAt: Date;
}

/**
 * The milestone to take at `now` when `next` is the first one not taken yet, or null if it is
 * not due. Milestones missed while the process was stopped are collapsed: only the latest one
 * that already passed is taken (late, at `now`), so no past state is ever made up.
 */
export const resolveDueMilestone = (detectedAt: Date, next: string, now: Date): DueMilestone | null => {
  const ageMs = now.getTime() - detectedAt.getTime();
  const nextOffset = milestoneOffsetMs(next);
  if (nextOffset === null || ageMs < nextOffset) return null;

  let milestone = next;
  let following = followingMilestone(milestone);
  let followingOffset = milestoneOffsetMs(following) as number;
  while (followingOffset <= ageMs) {
    milestone = following;
    following = followingMilestone(milestone);
    followingOffset = milestoneOffsetMs(following) as number;
  }
  return { milestone, following, followingAt: new Date(detectedAt.getTime() + followingOffset) };
};

/** No trades for 24 hours (counting from creation if none was ever seen). */
export const isDead = (lastActivityAt: Date | null, detectedAt: Date, now: Date): boolean =>
  now.getTime() - (lastActivityAt ?? detectedAt).getTime() >= DEAD_AFTER_MS;
