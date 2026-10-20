/** Types shared by the extension and the Accounts webview. Types only, no code. */

export interface AccountCard {
  id: string;
  alias: string;
  email: string;
  /** One or two letters for the avatar. */
  initials: string;
  /** Index into the avatar colour set, 0 to AVATAR_COLOURS - 1. */
  avatar: number;
  /** The saved login's refresh token has expired. */
  expired: boolean;
  lastUsedAt?: string;
  /** For example "Pro", "Max 20x" or "Team". */
  plan?: string;
  /** The last usage numbers seen for this account. */
  usage?: { updatedAt: number; meters: UsageMeter[] };
  renewal?: RenewalView;
}

export interface UsageMeter {
  key: 'session' | 'weekly' | 'weeklyOpus' | 'weeklySonnet';
  label: string;
  /** 0 to 100. */
  percent: number;
  /** ISO time the limit resets. */
  resetsAt?: string;
}

export type RenewalView =
  /** date is YYYY-MM-DD; estimated means it was worked out from the start date. */
  | { kind: 'date'; date: string; estimated: boolean }
  /** Team and Enterprise plans, which the organization pays for. */
  | { kind: 'organization' };

export interface RosterViewState {
  /** macOS, where Claude Switch cannot work yet. */
  unsupported?: boolean;
  /** The live Claude login, matched against the saved accounts. */
  current:
    | { kind: 'account'; account: AccountCard }
    | { kind: 'unsaved'; email: string }
    | { kind: 'signed-out' }
    | { kind: 'error'; message: string };
  /** Saved accounts other than the active one. */
  others: AccountCard[];
  /** Another window switched accounts, and this one still runs the old login. */
  reloadPending?: { alias?: string };
  /** Add Account is waiting for the browser sign-in. */
  signIn?: { email?: string; hasLink: boolean };
  hasBackup: boolean;
}

/** Webview to extension. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'switch'; profileId: string }
  | { type: 'rename'; profileId: string }
  | { type: 'remove'; profileId: string }
  | { type: 'setRenewal'; profileId: string }
  | { type: 'openBilling' }
  | { type: 'add' }
  | { type: 'saveCurrent' }
  | { type: 'reload' }
  | { type: 'restore' }
  | { type: 'signInOpen' }
  | { type: 'signInCopy' }
  | { type: 'signInCode'; code: string }
  | { type: 'signInCancel' }
  | { type: 'copyLog' }
  | { type: 'clearLog' }
  | { type: 'openOutput' };

/** One line of the activity log. Never contains secrets. */
export interface LogEntry {
  /** Epoch ms. */
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Extension to webview. */
export type HostMessage =
  | { type: 'state'; state: RosterViewState }
  /** The whole log, oldest first. */
  | { type: 'log'; entries: LogEntry[] }
  /** Show the log page, for "Claude Switch: Show Log" and "Show Log" buttons. */
  | { type: 'openLog' };
