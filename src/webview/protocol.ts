/** Types shared by the extension and the Accounts webview. Types only, no code. */

import type { InputRule } from './rules';

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
  /** A switch is under way; the account list waits. */
  switching?: boolean;
  /** Set when this window has its own account: which account other windows use. */
  windowNote?: string;
  /** False when every switch is for all windows: the user set CLAUDE_SECURESTORAGE_CONFIG_DIR. */
  perWindow?: boolean;
}

/** Webview to extension. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'switch'; profileId: string }
  | { type: 'rename'; profileId: string }
  | { type: 'remove'; profileId: string }
  | { type: 'setRenewal'; profileId: string }
  /** "Sign in again" on an account whose saved login expired. */
  | { type: 'signInAgain'; profileId: string }
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
  | { type: 'openOutput' }
  /** The answer to the open dialog: a value for input, an action id otherwise; neither means cancelled. */
  | { type: 'promptResult'; id: string; value?: string; action?: string; color?: number }
  /** A notice's button was clicked, or (no action) the notice was dismissed. */
  | { type: 'noticeAction'; id: string; action?: string };

export interface PromptAction {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
}

/** A dialog shown inside the tab, in place of VS Code's input boxes, pickers and modal messages. */
export type PromptSpec =
  | {
      kind: 'input';
      id: string;
      title: string;
      message?: string;
      value?: string;
      placeholder?: string;
      confirmLabel: string;
      rule: InputRule;
      /** Aliases already in use, for the alias rule. */
      taken?: string[];
      optional?: boolean;
    }
  /** Edit an account: its name and avatar colour, with a live preview. */
  | {
      kind: 'profile';
      id: string;
      title: string;
      message?: string;
      value: string;
      taken?: string[];
      /** The current colour, 0 to AVATAR_COLOURS - 1. */
      color: number;
      confirmLabel: string;
    }
  | { kind: 'confirm'; id: string; title: string; message?: string; actions: PromptAction[] }
  | { kind: 'choice'; id: string; title: string; message?: string; options: { id: string; label: string; description?: string }[] };

/** A message shown at the bottom of the tab, in place of VS Code notifications. */
export interface Notice {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
  actions?: PromptAction[];
}

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
  | { type: 'openLog' }
  /** The dialog to show, or null for none. */
  | { type: 'prompt'; prompt: PromptSpec | null }
  | { type: 'notices'; notices: Notice[] }
  /** Work in progress, shown as a banner; null when done. */
  | { type: 'busy'; text: string | null }
  /** The window is about to reload or restart: show the loading screen, with this text, until it is back. */
  | { type: 'reloading'; text: string };
