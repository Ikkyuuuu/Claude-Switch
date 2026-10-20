import { ClaudePaths, readTextIfExists, SavedLogin } from './claudeFiles';

/**
 * Plan, usage and renewal details shown next to each account. Everything here
 * comes from files Claude Code already keeps; nothing is fetched. All readers
 * are lenient: an unexpected shape means "no details", never an error.
 */

export interface UsageWindow {
  /** 0 to 100. */
  percent: number;
  /** ISO time the window resets. */
  resetsAt?: string;
}

export interface UsageInfo {
  /** When Claude Code fetched these numbers, epoch ms. */
  fetchedAt: number;
  /** The rolling 5-hour session limit. */
  session?: UsageWindow;
  /** The weekly limit across all models. */
  weekly?: UsageWindow;
  weeklyOpus?: UsageWindow;
  weeklySonnet?: UsageWindow;
}

export interface PlanInfo {
  /** For example "Pro", "Max 20x" or "Team". */
  label: string;
  /** Paid by this person (Pro, Max) rather than by an organization (Team, Enterprise). */
  personal: boolean;
  /** When the subscription started, ISO. */
  subscribedAt?: string;
}

export interface RenewalSetting {
  /** The next renewal the user entered, YYYY-MM-DD. */
  date: string;
  cycle: 'monthly' | 'yearly';
}

/** Claude Code's cached /usage numbers for the signed-in account, as stored in .claude.json. */
export async function readUsageCache(paths: ClaudePaths): Promise<(UsageInfo & { accountUuid: string }) | undefined> {
  try {
    const raw = await readTextIfExists(paths.globalConfigFile);
    return raw === undefined ? undefined : parseUsageCache(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function parseUsageCache(config: unknown): (UsageInfo & { accountUuid: string }) | undefined {
  const cache = field(config, 'cachedUsageUtilization');
  const utilization = field(cache, 'utilization');
  const fetchedAt = field(cache, 'fetchedAtMs');
  const accountUuid = field(cache, 'accountUuid');
  if (typeof fetchedAt !== 'number' || typeof accountUuid !== 'string' || !utilization) {
    return undefined;
  }
  const info = {
    accountUuid,
    fetchedAt,
    session: usageWindow(field(utilization, 'five_hour')),
    weekly: usageWindow(field(utilization, 'seven_day')),
    weeklyOpus: usageWindow(field(utilization, 'seven_day_opus')),
    weeklySonnet: usageWindow(field(utilization, 'seven_day_sonnet')),
  };
  return info.session || info.weekly ? info : undefined;
}

/** The plan, from the token file's subscription type and the account's organization type. */
export function planOf(login: SavedLogin): PlanInfo | undefined {
  let oauth: unknown;
  try {
    oauth = field(JSON.parse(login.credentialsRaw), 'claudeAiOauth');
  } catch {
    return undefined;
  }
  const subscription = stringField(oauth, 'subscriptionType')?.toLowerCase();
  const tier = stringField(oauth, 'rateLimitTier')?.toLowerCase() ?? '';
  const orgType = stringField(login.account, 'organizationType')?.toLowerCase() ?? '';
  const kind = subscription || orgType.replace(/^claude_/, '');
  if (!kind) {
    return undefined;
  }

  let label: string;
  let personal = false;
  if (kind.includes('max')) {
    const multiplier = /max_(\d+)x/.exec(tier)?.[1];
    label = multiplier ? `Max ${multiplier}x` : 'Max';
    personal = true;
  } else if (kind.includes('pro')) {
    label = 'Pro';
    personal = true;
  } else if (kind.includes('team')) {
    label = 'Team';
  } else if (kind.includes('enterprise')) {
    label = 'Enterprise';
  } else if (kind.includes('free')) {
    label = 'Free';
  } else {
    label = kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  const subscribedAt = stringField(login.account, 'subscriptionCreatedAt');
  return { label, personal, subscribedAt: subscribedAt && !Number.isNaN(Date.parse(subscribedAt)) ? subscribedAt : undefined };
}

/**
 * The next renewal on or after today, as YYYY-MM-DD in local time.
 * A user-set date wins; otherwise personal plans are estimated as monthly from
 * the start date. Returns undefined when there is nothing to go on.
 */
export function nextRenewal(
  plan: PlanInfo | undefined,
  setting: RenewalSetting | undefined,
  now: number,
): { date: string; estimated: boolean } | undefined {
  if (setting && isDateString(setting.date)) {
    return { date: rollForward(setting.date, setting.cycle === 'yearly' ? 12 : 1, now, 0), estimated: false };
  }
  if (plan?.personal && plan.subscribedAt) {
    const start = new Date(plan.subscribedAt);
    // The start date is not itself a renewal, so begin one cycle later.
    return { date: rollForward(toDateString(start), 1, now, 1), estimated: true };
  }
  return undefined;
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month - 1);
}

function rollForward(anchor: string, months: number, now: number, firstStep: number): string {
  const [year, month, day] = anchor.split('-').map(Number);
  const today = toDateString(new Date(now));
  for (let step = firstStep; step < 2400; step++) {
    const total = month - 1 + step * months;
    const y = year + Math.floor(total / 12);
    const m = total % 12;
    // A plan started on the 31st renews on the last day of shorter months.
    const candidate = toDateString(new Date(y, m, Math.min(day, daysIn(y, m))));
    if (candidate >= today) {
      return candidate;
    }
  }
  return today;
}

function toDateString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysIn(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function usageWindow(value: unknown): UsageWindow | undefined {
  const percent = field(value, 'utilization');
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    return undefined;
  }
  const resetsAt = field(value, 'resets_at');
  return {
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt: typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt)) ? resetsAt : undefined,
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const result = field(value, key);
  return typeof result === 'string' && result ? result : undefined;
}
