import { nextRenewal, UsageInfo } from './accountDetails';
import type { ProfileMeta } from './profileStore';
import type { LiveState } from './switchEngine';
import type { AccountCard, RenewalView, RosterViewState, UsageMeter, WebviewMessage } from './webview/protocol';

/** Matches the .avatar-N classes in media/roster.css. */
export const AVATAR_COLOURS = 8;

/** An Add Account sign-in in progress. */
export interface SignInState {
  email?: string;
  /** The sign-in link Claude printed, once known. */
  url?: string;
}

export interface ViewInput {
  profiles: ProfileMeta[];
  live: LiveState;
  reloadPending?: { alias?: string };
  signIn?: SignInState;
  hasBackup: boolean;
  /** For renewal dates; defaults to the current time. */
  now?: number;
}

/** Everything the Accounts webview shows. The sign-in link itself stays in the extension. */
export function buildViewState(input: ViewInput): RosterViewState {
  const { live } = input;
  const activeId = live.kind === 'known' ? live.profile.id : undefined;
  const now = input.now ?? Date.now();
  const toCard = (profile: ProfileMeta) => accountCard(profile, now);

  let current: RosterViewState['current'];
  switch (live.kind) {
    case 'known':
      current = { kind: 'account', account: toCard(input.profiles.find((p) => p.id === activeId) ?? live.profile) };
      break;
    case 'unknown':
      current = { kind: 'unsaved', email: live.login.account.emailAddress };
      break;
    case 'signed-out':
      current = { kind: 'signed-out' };
      break;
    case 'error':
      current = { kind: 'error', message: live.message };
      break;
  }

  return {
    current,
    others: input.profiles.filter((p) => p.id !== activeId).map(toCard),
    reloadPending: input.reloadPending,
    signIn: input.signIn && { email: input.signIn.email, hasLink: !!input.signIn.url },
    hasBackup: input.hasBackup,
  };
}

export function unsupportedState(): RosterViewState {
  return { unsupported: true, current: { kind: 'signed-out' }, others: [], hasBackup: false };
}

function accountCard(profile: ProfileMeta, now: number): AccountCard {
  return {
    id: profile.id,
    alias: profile.alias,
    email: profile.email,
    initials: initialsOf(profile.alias),
    avatar: avatarOf(profile.id),
    expired: profile.status === 'needs-relogin',
    lastUsedAt: profile.lastUsedAt,
    plan: profile.plan?.label,
    usage: profile.usage && { updatedAt: profile.usage.fetchedAt, meters: usageMeters(profile.usage) },
    renewal: renewalOf(profile, now),
  };
}

const METERS: { key: UsageMeter['key']; label: string }[] = [
  { key: 'session', label: 'Session (5 hours)' },
  { key: 'weekly', label: 'This week' },
  { key: 'weeklyOpus', label: 'Opus this week' },
  { key: 'weeklySonnet', label: 'Sonnet this week' },
];

function usageMeters(usage: UsageInfo): UsageMeter[] {
  return METERS.flatMap(({ key, label }) => {
    const window = usage[key];
    return window ? [{ key, label, percent: Math.round(window.percent), resetsAt: window.resetsAt }] : [];
  });
}

function renewalOf(profile: ProfileMeta, now: number): RenewalView | undefined {
  const next = nextRenewal(profile.plan, profile.renewal, now);
  if (next) {
    return { kind: 'date', ...next };
  }
  return profile.plan && !profile.plan.personal ? { kind: 'organization' } : undefined;
}

/** "Work" gives "W"; "Acme Team" gives "AT". Works for any script. */
export function initialsOf(alias: string): string {
  const words = alias.trim().split(/\s+/).filter(Boolean);
  const first = (word: string) => Array.from(word)[0] ?? '';
  const letters = words.length > 1 ? first(words[0]) + first(words[1]) : first(words[0] ?? '');
  return letters.toLocaleUpperCase() || '?';
}

/** A stable colour per account, so an avatar keeps its colour across renames. */
export function avatarOf(id: string): number {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % AVATAR_COLOURS;
}

const SIMPLE_MESSAGES = new Set([
  'ready',
  'add',
  'saveCurrent',
  'reload',
  'restore',
  'copyLog',
  'clearLog',
  'openOutput',
  'signInOpen',
  'signInCopy',
  'signInCancel',
  'openBilling',
]);
const PROFILE_MESSAGES = new Set(['switch', 'rename', 'remove', 'setRenewal']);

/** Validates a message from the webview. Anything unexpected returns undefined. */
export function parseMessage(raw: unknown): WebviewMessage | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { type, profileId, code } = raw as Record<string, unknown>;
  if (typeof type !== 'string') {
    return undefined;
  }
  if (SIMPLE_MESSAGES.has(type)) {
    return { type } as WebviewMessage;
  }
  if (PROFILE_MESSAGES.has(type) && typeof profileId === 'string' && /^[\w-]{1,64}$/.test(profileId)) {
    return { type, profileId } as WebviewMessage;
  }
  if (type === 'signInCode' && typeof code === 'string' && code.trim() && code.length <= 512) {
    return { type, code };
  }
  return undefined;
}
