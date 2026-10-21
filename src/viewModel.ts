import { nextRenewal, UsageInfo } from './accountDetails';
import type { ProfileMeta } from './profileStore';
import type { LiveState } from './switchEngine';
import { AVATAR_COLOURS, DEFAULT_AVATAR_COLOURS, initialsOf, isAvatarColour } from './webview/avatar';
import type { AccountCard, RenewalView, SwitchViewState, UsageMeter, WebviewMessage } from './webview/protocol';

// Also exported from here for existing callers.
export { AVATAR_COLOURS, initialsOf };

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
  switching?: boolean;
  windowNote?: string;
  perWindow?: boolean;
  /** For renewal dates; defaults to the current time. */
  now?: number;
}

/** Everything the Accounts webview shows. The sign-in link itself stays in the extension. */
export function buildViewState(input: ViewInput): SwitchViewState {
  const { live } = input;
  const activeId = live.kind === 'known' ? live.profile.id : undefined;
  const now = input.now ?? Date.now();
  const toCard = (profile: ProfileMeta) => accountCard(profile, now);

  let current: SwitchViewState['current'];
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
    ...(input.switching && { switching: true }),
    ...(input.windowNote && { windowNote: input.windowNote }),
    ...(input.perWindow === false && { perWindow: false }),
  };
}

export function unsupportedState(): SwitchViewState {
  return { unsupported: true, current: { kind: 'signed-out' }, others: [], hasBackup: false };
}

function accountCard(profile: ProfileMeta, now: number): AccountCard {
  return {
    id: profile.id,
    alias: profile.alias,
    email: profile.email,
    initials: initialsOf(profile.alias),
    avatar: colourOf(profile),
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

/** A stable default colour per account, so an avatar keeps its colour across renames. */
export function avatarOf(id: string): number {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % DEFAULT_AVATAR_COLOURS;
}

/** The colour the user chose for the account, else its default. */
export function colourOf(profile: Pick<ProfileMeta, 'id' | 'color'>): number {
  return isAvatarColour(profile.color) ? profile.color : avatarOf(profile.id);
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
const PROFILE_MESSAGES = new Set(['switch', 'rename', 'remove', 'setRenewal', 'signInAgain']);

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
  // Dialog answers and notice clicks: the receiver checks them against what it asked.
  const { id, value, action, color } = raw as Record<string, unknown>;
  const isId = (x: unknown): x is string => typeof x === 'string' && /^[\w-]{1,64}$/.test(x);
  if ((type === 'promptResult' || type === 'noticeAction') && isId(id) && (action === undefined || isId(action))) {
    if (type === 'noticeAction') {
      return { type, id, action };
    }
    const valueOk = value === undefined || (typeof value === 'string' && value.length <= 512);
    if (valueOk && (color === undefined || isAvatarColour(color))) {
      return color === undefined ? { type, id, value, action } : { type, id, value, action, color };
    }
  }
  return undefined;
}
