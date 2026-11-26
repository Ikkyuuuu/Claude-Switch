import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { nextRenewal } from './accountDetails';
import { AccountsView } from './accountsView';
import { ClaudeLogin, ClaudeLoginOptions, createLoginDir, findOnPath, isValidEmail, removeLoginDir, removeStaleLoginDirs, waitForLogin } from './addAccount';
import { delay, identityOf, OAuthAccount, SavedLogin } from './claudeFiles';
import { errorMessage } from './log';
import { ProfileMeta, ProfileStore } from './profileStore';
import { SwitchLog } from './switchLog';
import { SwitchStatusBar } from './statusBar';
import { LiveState, LockBusyError, SwitchEngine, UsageAnswer } from './switchEngine';
import { askClaudeForUsage, checkedAccount, clearInterruptedSaves, forgetSavedUsage, UsageCheckOptions, usageCheckDue } from './usageCheck';
import { accountForProject, LOGIN_DIR_VARIABLE, LoginFolders } from './windowAccounts';
import { MAX_ALIAS_LENGTH } from './webview/rules';
import { colourOf } from './viewModel';
import { SwitchSignal, WindowSync } from './windowSync';

export interface SwitchArgs {
  profileId?: string;
  /** Switch every window, by changing the default account in ~/.claude. Otherwise only this window switches. */
  allWindows?: boolean;
  /** Honoured only when the extension runs under the test runner. */
  skipConfirm?: boolean;
}

/** What the controller needs to give this window its own account. See windowAccounts.ts. */
export interface WindowContext {
  /** False when the user set CLAUDE_SECURESTORAGE_CONFIG_DIR themselves: every switch is then for all windows. */
  enabled: boolean;
  /** Identifies this window's workspace across reloads. */
  key: string;
  /** The window's project folders, as Claude Code names their conversation folders. Follows folders added later. */
  readonly projects: string[];
  folders: LoginFolders;
  /** The folder of the default login: ~/.claude, or CLAUDE_CONFIG_DIR. */
  defaultLoginDir: string;
  /** The login folder this window's Claude uses now; undefined means the default login. */
  readonly loginDir: string | undefined;
  /** Points this window's Claude, and its terminals, at a login folder. */
  setLoginDir(dir: string | undefined): void;
}

const DAY_MS = 24 * 60 * 60_000;
/** How often to see whether a usage check is due. */
const USAGE_TICK_MS = 1_000;
/** After a failed usage check, the wait before the next, doubling each time up to USAGE_BACKOFF_MAX_MS. */
const USAGE_BACKOFF_MS = 30_000;
const USAGE_BACKOFF_MAX_MS = 10 * 60_000;
/** After asking for a reload: if the window is still here this much later, it is not reloading. */
const RELOAD_GIVE_UP_MS = 5_000;
/** A login whose new tokens a usage check could not confirm is checked again after this long. */
const CONFIRM_RETRY_MS = 5 * 60_000;

const BILLING_URL = 'https://claude.ai/settings/billing';
const REFRESH_THROTTLE_MS = 30_000;

/**
 * What happens after the login files are swapped. By default the window
 * reloads, so every Claude process in it restarts on the new account and none
 * is left holding the old login. Claude Code also starts a fresh `claude`
 * process for each conversation, which reads the login from disk, so the
 * instant modes work too, but conversations that were already open keep the
 * old account and can write it back.
 */
type SwitchMode = 'newConversation' | 'instant' | 'restartExtensions' | 'reloadWindow';

/**
 * How often to check usage while Claude is idle; after Claude replies, checks
 * come sooner (see usageCheckDue). 0 means no checks at all. Each check starts
 * the Claude CLI for a few seconds, so not more often than every 10 seconds.
 */
function usageCheckSeconds(): number {
  const seconds = vscode.workspace.getConfiguration('claudeSwitch').get<number>('usageCheckSeconds', 60);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(10, seconds) : 0;
}

/**
 * How often to check the usage of the saved accounts this window doesn't use.
 * Theirs changes only when they are used elsewhere, such as on claude.ai, so
 * less often than this window's. 0 means only after Claude replies on them.
 */
function otherAccountsUsageMinutes(): number {
  const minutes = vscode.workspace.getConfiguration('claudeSwitch').get<number>('otherAccountsUsageCheckMinutes', 10);
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 0;
}

function switchMode(): SwitchMode {
  const mode = vscode.workspace.getConfiguration('claudeSwitch').get<string>('switchMode');
  return mode === 'newConversation' || mode === 'instant' || mode === 'restartExtensions' ? mode : 'reloadWindow';
}

/** Shown before switching every window in the modes that interrupt the user. */
const RESTART_DETAIL: Record<'restartExtensions' | 'reloadWindow', string> = {
  restartExtensions: [
    'VS Code restarts its extensions, which takes a few seconds. Your editors and terminals stay open.',
    'Claude tasks running now stop, and Claude conversations continue on the new account.',
  ].join('\n\n'),
  reloadWindow: [
    'This window reloads, and any Claude task running in it stops.',
    'Exit claude sessions running in terminals first: they keep the old account until restarted, and can write it back.',
    'Other open VS Code windows will offer to reload.',
  ].join('\n\n'),
};

/** Shown before switching only this window, in the modes that interrupt the user. */
const WINDOW_RESTART_DETAIL: Record<'restartExtensions' | 'reloadWindow', string> = {
  restartExtensions: [
    "VS Code restarts this window's extensions, which takes a few seconds. Your editors and terminals stay open.",
    'Claude tasks running in this window stop. Other windows keep their accounts.',
  ].join('\n\n'),
  reloadWindow: ['This window reloads, and any Claude task running in it stops.', 'Other windows keep their accounts.'].join('\n\n'),
};

/** How long after an instant switch to watch for an older conversation writing its login back. */
const WRITE_BACK_WATCH_MS = 12 * 60 * 60_000;

/**
 * The UI for every command. Questions, confirmations and messages all appear
 * inside the Claude Switch tab (see AccountsView); file and storage work
 * happens in SwitchEngine.
 */
export class SwitchController implements vscode.Disposable {
  /** The default login, in ~/.claude. */
  private live: LiveState = { kind: 'signed-out' };
  /** What this window uses: the account it chose, while that isn't the default, else `live`. */
  private windowLive: LiveState = { kind: 'signed-out' };
  /** The account whose login folder this window uses, when it isn't the default account. */
  private windowFolderId: string | undefined;
  private refreshedOnce = false;
  /** The account whose missing login folder was already reported. */
  private missingFolderWarned: string | undefined;
  private lastRefresh = 0;
  /** The refresh running now, and the one queued after it. See refresh(). */
  private refreshing: Promise<LiveState> | undefined;
  private refreshAgain: Promise<LiveState> | undefined;
  private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  private reloadPending: { alias?: string } | undefined;
  /** The Add Account sign-in running in the background, if any. */
  private signIn: { cli: ClaudeLogin; abort: AbortController; email?: string } | undefined;
  /** After an instant switch: the account switched to, and the one before it. */
  private watch: { profileId: string; alias: string; previousId?: string; until: number } | undefined;
  private switching = false;
  /** From the first question of Add Account until the new account is saved. */
  private addingAccount = false;
  private usageCheck: Promise<void> | undefined;
  /** When each account's usage was last checked, from this window. */
  private lastChecked = new Map<string, number>();
  /** Per account: failed usage checks in a row, and when to try again. Anthropic may be limiting its requests. */
  private usageBackoff = new Map<string, { failures: number; retryAt: number }>();
  /** Accounts Claude was used with since their last usage check, in any window: when first, and last. */
  private pendingUsage = new Map<string, { since: number; last: number }>();
  /** When a check was last asked for to confirm an account's new tokens; see SwitchEngine.unconfirmed. */
  private confirmAsked = new Map<string, number>();
  /** Accounts whose login turned out to be another's, already reported in this window, with that account's email. */
  private reportedSignedInAs = new Set<string>();

  // Integration tests replace these three, since the test window must not reload or restart.
  reloadWindow: () => Thenable<unknown> = () => vscode.commands.executeCommand('workbench.action.reloadWindow');
  restartExtensions: () => Thenable<unknown> = () => vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  /** Opens a new Claude Code conversation, which starts on the account now on disk. */
  startConversation: () => Thenable<unknown> = () => vscode.commands.executeCommand('claude-vscode.newConversation');

  /** Integration tests replace this to sign in with a fake CLI. */
  createLogin: (options: ClaudeLoginOptions) => ClaudeLogin = (options) => new ClaudeLogin(options);
  /** Integration tests replace this, since the test window may not have the focus. */
  windowFocused: () => boolean = () => vscode.window.state.focused;
  /** Integration tests replace this, since the test window's fake login must never reach Anthropic. */
  askUsage: (options: UsageCheckOptions) => Promise<unknown> = askClaudeForUsage;

  constructor(
    private readonly engine: SwitchEngine,
    private readonly store: ProfileStore,
    private readonly statusBar: SwitchStatusBar,
    private readonly view: AccountsView,
    private readonly log: SwitchLog,
    private readonly sync: WindowSync,
    private readonly testMode: boolean,
    /** Claude Switch's own folder, where the CLI runs for usage checks. */
    private readonly storageDir: string,
    private readonly window: WindowContext,
  ) {
    if (testMode) {
      this.askUsage = () => Promise.reject(new Error('Usage checks are off under the test runner.'));
    }
  }

  /** Runs once per window, after activation. */
  async startup(): Promise<void> {
    void removeStaleLoginDirs().then((count) => {
      if (count) {
        this.log.info(`Deleted ${count} sign-in folder${count === 1 ? '' : 's'} left behind by an Add Account that did not finish.`);
      }
    });
    const check = await this.engine.verifyLastSwitch().catch((err) => {
      this.log.warn(`Could not check the last switch: ${errorMessage(err)}`);
      return { outcome: 'none' as const };
    });
    await this.refresh();
    this.startAutoRefresh();
    // Its own timer, so usage checks follow claudeSwitch.usageCheckSeconds whatever autoRefreshSeconds is.
    this.usageTimer = setInterval(() => this.checkUsageIfDue(), USAGE_TICK_MS);
    if (check.outcome === 'mismatch') {
      const choice = await this.view.notify(
        'warning',
        `The switch to "${check.profile.alias}" did not stick: another Claude process changed the login while this window reloaded. Exit running claude sessions, then switch again.`,
        [
          { id: 'again', label: 'Switch again', style: 'primary' },
          { id: 'log', label: 'Show log' },
        ],
      );
      if (choice === 'again') {
        await this.switchAccount({ profileId: check.profile.id, allWindows: true });
      } else if (choice === 'log') {
        this.showLog();
      }
    }
  }

  /**
   * Re-reads the login and updates everything shown. One runs at a time. One
   * asked for while another runs may follow a change the running one read too
   * early, such as a switch, so it runs once more afterwards, for every caller
   * that asked meanwhile.
   */
  refresh(): Promise<LiveState> {
    if (this.refreshing) {
      this.refreshAgain ??= this.refreshing
        .catch(() => undefined)
        .then(() => {
          this.refreshAgain = undefined;
          return this.refresh();
        });
      return this.refreshAgain;
    }
    this.refreshing = this.runRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<LiveState> {
    try {
      this.live = await this.engine.refresh(this.window.enabled ? this.window.folders : undefined);
    } catch (err) {
      this.live = { kind: 'error', message: errorMessage(err) };
    }
    await this.updateWindowAccount();
    this.lastRefresh = Date.now();
    this.render();
    this.checkWriteBack().catch((err: unknown) => this.showError(err));
    return this.live;
  }

  /**
   * Works out the account this window uses: the one it chose, else the default
   * account in ~/.claude. Keeps the login folders in order (see
   * windowAccounts.ts), points this window's Claude at the right login, and
   * saves tokens Claude refreshed in this window's folder.
   */
  private async updateWindowAccount(): Promise<void> {
    const first = !this.refreshedOnce;
    this.refreshedOnce = true;
    if (!this.window.enabled) {
      this.windowFolderId = undefined;
      this.windowLive = this.live;
      return;
    }
    // While the default login can't be read, leave the folders and this window as they are:
    // taking it for "no default account" would copy the default account into a folder too.
    if (this.live.kind === 'error') {
      if (!this.windowFolderId) {
        this.windowLive = this.live;
      }
      return;
    }
    const defaultId = this.live.kind === 'known' ? this.live.profile.id : undefined;
    const choice = this.store.getWindowChoice(this.window.key);
    // Choices unused for 30 days expire; using one keeps it. Its project folders, which tell which
    // account replied (see noteClaudeActivity), follow the workspace's, and were not kept before 0.13.
    const projectsChanged = (choice?.projects ?? []).join('|') !== this.window.projects.join('|');
    if (choice && (Date.now() - choice.at > DAY_MS || projectsChanged)) {
      void this.store.setWindowChoice(this.window.key, choice.profileId, this.window.projects).catch(() => undefined);
    }
    try {
      await this.engine.reconcileFolders(this.window.folders, defaultId, this.store.chosenAccounts());
    } catch (err) {
      // Another window is busy with the folders or a switch; try again next time.
      if (!(err instanceof LockBusyError)) {
        this.log.warn(`Could not update the login folders: ${errorMessage(err)}`);
      }
    }
    this.engine.usageCacheTrusted = (await this.window.folders.list()).length === 0;

    const folderId = choice && choice.profileId !== defaultId && this.window.folders.has(choice.profileId) ? choice.profileId : undefined;
    if (choice && choice.profileId !== defaultId && !folderId && this.missingFolderWarned !== choice.profileId) {
      // For example, its saved login is gone: the window uses the default account meanwhile.
      this.missingFolderWarned = choice.profileId;
      this.log.warn(`This window should use "${this.store.get(choice.profileId)?.alias}", but its login could not be prepared, so it uses the default account.`);
    }
    const loginDir = folderId ? this.window.folders.dirOf(folderId) : undefined;
    if (loginDir !== this.window.loginDir) {
      this.window.setLoginDir(loginDir);
      if (!first && !this.switching) {
        // Another window moved this window's login. Claude processes already running here hold it
        // where it was, and could write it back there, so this window should reload in every mode.
        this.log.info(`This window now uses ${folderId ? `"${this.store.get(folderId)?.alias}"` : 'the default account'}.`);
        this.reloadPending = { alias: folderId ? this.store.get(folderId)?.alias : this.live.kind === 'known' ? this.live.profile.alias : undefined };
      }
    }
    this.windowFolderId = folderId;
    const profile = folderId ? this.store.get(folderId) : undefined;
    this.windowLive = profile ? profileLive(profile) : this.live;

    if (folderId) {
      const raw = await this.window.folders.read(folderId).catch(() => undefined);
      if (raw) {
        await this.engine.syncFolder(folderId, raw).catch((err) => this.log.warn(`Could not save the refreshed login: ${errorMessage(err)}`));
      }
    }
  }

  /**
   * After an instant switch, Claude conversations that were already open still
   * hold the old login. One can rewrite .claude.json with the old oauthAccount,
   * which is put back quietly, or save its old tokens when it refreshes them,
   * which only closing that conversation fixes, so the user is told.
   */
  private async checkWriteBack(): Promise<void> {
    const watch = this.watch;
    const live = this.live;
    if (!watch) {
      return;
    }
    if (Date.now() > watch.until) {
      this.watch = undefined;
      return;
    }
    if (live.kind === 'known' && live.profile.id === watch.profileId) {
      return;
    }
    this.watch = undefined;
    // An account mix-up shows as an error; any other change was presumably on purpose.
    if (live.kind !== 'error' && !(live.kind === 'known' && live.profile.id === watch.previousId)) {
      return;
    }
    let outcome: Awaited<ReturnType<SwitchEngine['keepSwitch']>>;
    try {
      outcome = await this.engine.keepSwitch(watch.profileId);
    } catch (err) {
      // Still busy after waiting, or the files were unreadable; look again on the next refresh.
      this.log.warn(`Could not check the switch to "${watch.alias}": ${errorMessage(err)}`);
      this.watch = watch;
      return;
    }
    if (outcome === 'none') {
      return;
    }
    // Decided by what keepSwitch read under the lock, not by `live`: another check may have put things right since.
    // Tokens of another account next to the right account details come back as 'mismatch'.
    if (outcome === 'repaired' || outcome === 'ok') {
      this.watch = watch;
      await this.refresh();
      return;
    }
    const back = live.kind === 'known' ? `changed back to "${live.profile.alias}"` : 'was overwritten';
    this.log.warn(`Claude's login ${back} after switching to "${watch.alias}"; an older Claude conversation probably saved its old login.`);
    const choice = await this.view.notify(
      'warning',
      `Claude's login ${back}. A Claude conversation that was open before you switched to "${watch.alias}" probably saved its old login when it refreshed. Close older conversations, then switch again.`,
      [{ id: 'again', label: `Switch to "${watch.alias}"`, style: 'primary' }],
    );
    if (choice === 'again') {
      await this.switchAccount({ profileId: watch.profileId, allWindows: true });
    }
  }

  /** Cheap re-check when the window regains focus, in case Claude signed in or refreshed. */
  refreshIfStale(): void {
    if (Date.now() - this.lastRefresh > REFRESH_THROTTLE_MS) {
      void this.refresh();
    }
  }

  /**
   * Re-reads the login and usage every claudeSwitch.autoRefreshSeconds while
   * this window is focused. Local file reads only. Call again when the setting changes.
   */
  startAutoRefresh(): void {
    this.stopAutoRefresh();
    const seconds = vscode.workspace.getConfiguration('claudeSwitch').get<number>('autoRefreshSeconds', 1);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    this.autoRefreshTimer = setInterval(
      () => {
        if (this.windowFocused()) {
          void this.refresh().then(() => this.checkUsageIfDue());
        } else {
          this.renderFromStore();
        }
      },
      Math.max(1, seconds) * 1000,
    );
  }

  /**
   * In a window without the focus: shows what other windows saved, such as
   * the usage numbers the focused window just got, so every window shows the
   * same at the same time. Reads nothing from disk.
   */
  private renderFromStore(): void {
    if (this.windowLive.kind === 'known') {
      const profile = this.store.get(this.windowLive.profile.id);
      if (profile) {
        this.windowLive = { ...this.windowLive, profile };
      }
    }
    this.render();
  }

  /**
   * Claude was just used, in some window: that account's usage is about to
   * change. project is the conversation's project folder, which tells the
   * window, and so the account. See ClaudeActivity.
   */
  noteClaudeActivity(project?: string): void {
    const defaultId = this.live.kind === 'known' ? this.live.profile.id : undefined;
    const id = project ? accountForProject(project, this.store.windowChoices(), defaultId) : this.windowAccountId();
    if (!id) {
      return;
    }
    const now = Date.now();
    this.pendingUsage.set(id, { since: this.pendingUsage.get(id)?.since ?? now, last: now });
  }

  /**
   * Claude Code saves usage to .claude.json only now and then, so the focused
   * window asks Claude for the current numbers: of the account just used, in
   * any window, shortly after Claude replies; of this window's account every
   * claudeSwitch.usageCheckSeconds; and of every other saved account every
   * claudeSwitch.otherAccountsUsageCheckMinutes. Only the focused window checks,
   * and the others show what it found (see renderFromStore).
   */
  checkUsageIfDue(): void {
    const seconds = usageCheckSeconds();
    const now = Date.now();
    if (!seconds || this.usageCheck || !this.windowFocused()) {
      return;
    }
    // Logins changed to tokens not yet known to be their account's: a check, soon, confirms them, and they are saved.
    for (const id of this.engine.unconfirmed) {
      if (!this.pendingUsage.has(id) && now - (this.confirmAsked.get(id) ?? 0) >= CONFIRM_RETRY_MS) {
        this.confirmAsked.set(id, now);
        this.pendingUsage.set(id, { since: now, last: now });
      }
    }
    const own = this.windowAccountId();
    const others = otherAccountsUsageMinutes();
    // Not the accounts whose saved login expired, or is another account's: their checks would tell nothing new.
    const saved = others ? this.store.list().filter((p) => p.status === 'ok' && !p.signedInAs).map((p) => p.id) : [];
    for (const id of new Set([...this.pendingUsage.keys(), ...(own ? [own] : []), ...saved])) {
      if (now < (this.usageBackoff.get(id)?.retryAt ?? 0)) {
        continue;
      }
      const pending = this.pendingUsage.get(id);
      const due = usageCheckDue({
        now,
        // Another window may have got its numbers since; every window sees them.
        lastCheck: Math.max(this.lastChecked.get(id) ?? 0, this.store.get(id)?.usage?.fetchedAt ?? 0),
        intervalMs: id === own ? seconds * 1000 : others ? others * 60_000 : Number.POSITIVE_INFINITY,
        activitySince: pending?.since ?? 0,
        lastActivity: pending?.last ?? 0,
      });
      if (due) {
        void this.checkUsage(id);
        return;
      }
    }
  }

  /**
   * Asks Claude's CLI whose login a folder holds (see EngineOptions.identify):
   * a usage check in a settings folder of its own, thrown away afterwards.
   */
  async identify(loginDir: string): Promise<OAuthAccount | undefined> {
    const claude = resolveClaude();
    await fs.mkdir(this.storageDir, { recursive: true });
    const configDir = await fs.mkdtemp(path.join(this.storageDir, 'identify-'));
    try {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, [LOGIN_DIR_VARIABLE]: loginDir };
      // Claude looks the account up as it starts, so it is known even when the usage isn't.
      await this.askUsage({ command: claude.command, cwd: this.storageDir, env }).catch(() => undefined);
      return await checkedAccount(configDir);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Says, once per window, that an account's login turned out to be another account's. */
  private reportSignedInAs(profileId: string, email: string): void {
    const profile = this.store.get(profileId);
    const key = `${profileId} ${email}`;
    if (!profile || this.reportedSignedInAs.has(key)) {
      return;
    }
    this.reportedSignedInAs.add(key);
    void this.view
      .notify(
        'warning',
        `"${profile.alias}" is signed in as ${email}, not ${profile.email}, so Claude in windows that use "${profile.alias}" runs as ${email}. Sign in to "${profile.alias}" again and reload those windows, or keep it as ${email}'s account.`,
        [
          { id: 'signin', label: 'Sign in again', style: 'primary' },
          { id: 'keep', label: `Keep as ${email}` },
        ],
      )
      .then((choice) => (choice === 'signin' ? this.signInAgain(profileId) : choice === 'keep' ? this.keepAsSignedIn(profileId) : undefined))
      .catch((err: unknown) => this.showError(err));
  }

  /** Asks Claude Code's CLI for an account's usage now, this window's by default. See usageCheck.ts. */
  checkUsage(profileId = this.windowAccountId()): Promise<void> {
    this.usageCheck ??= this.runUsageCheck(profileId).finally(() => {
      this.usageCheck = undefined;
    });
    return this.usageCheck;
  }

  private async runUsageCheck(profileId: string | undefined): Promise<void> {
    if (!profileId) {
      return;
    }
    const lastChecked = this.lastChecked.get(profileId);
    this.lastChecked.set(profileId, Date.now());
    // This check covers what Claude did until now.
    const pending = this.pendingUsage.get(profileId);
    this.pendingUsage.delete(profileId);
    // Its login is where its Claude reads it: ~/.claude for the default account, else its folder. One that
    // neither the default nor any window uses gets its saved login lent, in its usage folder, for the check only.
    const defaultId = this.live.kind === 'known' ? this.live.profile.id : undefined;
    const folderId = profileId === defaultId ? undefined : profileId;
    const lent = !!folderId && !this.window.folders.has(folderId);
    const claude = resolveClaude();
    try {
      // A settings folder of its own per account: Claude's usage cache in ~/.claude.json is
      // shared, and labelled with the default account even when another account's login was used.
      const configDir = path.join(this.storageDir, 'usage', profileId);
      await fs.mkdir(configDir, { recursive: true });
      const loginDir = !folderId ? this.window.defaultLoginDir : lent ? configDir : this.window.folders.dirOf(folderId);
      const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, [LOGIN_DIR_VARIABLE]: loginDir };
      // Under the switch lock, like every usage check: no other window's Claude is using this folder meanwhile.
      const ask = async (): Promise<UsageAnswer> => {
        const leftovers = await clearInterruptedSaves(configDir);
        if (leftovers) {
          this.log.info(`Deleted ${leftovers} temporary file${leftovers === 1 ? '' : 's'} that an interrupted usage check left behind.`);
        }
        // Fresh numbers each time, and the account found afresh: the CLI would reuse what it saved there.
        await forgetSavedUsage(configDir);
        const utilization = await this.askUsage({ command: claude.command, cwd: this.storageDir, env });
        return { utilization, owner: await checkedAccount(configDir) };
      };
      const place = folderId ? { folders: this.window.folders, lendTo: lent ? configDir : undefined } : undefined;
      const { updated, signedInAs } = await this.engine.checkUsage(ask, folderId, place);
      this.usageBackoff.delete(profileId);
      if (signedInAs) {
        this.reportSignedInAs(profileId, signedInAs);
      }
      // A flagged account shows as such at once, numbers or not.
      if (updated || signedInAs) {
        await this.refresh();
      }
    } catch (err) {
      // Busy: a switch is running, in this window or another. Try again shortly, not an interval later.
      if (err instanceof LockBusyError) {
        if (pending) {
          this.pendingUsage.set(profileId, pending);
        }
        if (lastChecked === undefined) {
          this.lastChecked.delete(profileId);
        } else {
          this.lastChecked.set(profileId, lastChecked);
        }
        return;
      }
      const failures = (this.usageBackoff.get(profileId)?.failures ?? 0) + 1;
      this.usageBackoff.set(profileId, { failures, retryAt: Date.now() + Math.min(USAGE_BACKOFF_MAX_MS, USAGE_BACKOFF_MS * 2 ** (failures - 1)) });
      if (failures === 1) {
        const alias = this.store.get(profileId)?.alias;
        this.log.warn(
          `Could not get the current usage${alias ? ` of "${alias}"` : ''} from Claude, so the tab shows the numbers it had: ${errorMessage(err).replace(/\.$/, '')}. Trying again in a while.`,
        );
      }
    }
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  /** Without a profileId (status bar, Command Palette), opens the tab, which is the account picker. */
  async switchAccount(args: SwitchArgs = {}): Promise<void> {
    if (!args.profileId) {
      await this.refresh();
      this.view.reveal();
      return;
    }
    // Clicks while a switch is under way are ignored; the tab shows its progress.
    if (this.switching) {
      return;
    }
    this.switching = true;
    // The list dims at once, so the click visibly landed even before anything slow.
    this.render();
    try {
      if (args.allWindows || !this.window.enabled) {
        await this.switchToProfile(args.profileId, args.skipConfirm);
      } else {
        await this.switchWindow(args.profileId, args.skipConfirm);
      }
    } finally {
      this.switching = false;
      this.render();
    }
  }

  /** "Switch All Windows": profileId comes from the tab; without it, the tab asks which account. */
  async switchAllWindows(profileId?: string): Promise<void> {
    const profile = profileId ? this.store.get(profileId) : await this.pickProfile('Which account should every window use?');
    if (profile) {
      await this.switchAccount({ profileId: profile.id, allWindows: true });
    }
  }

  /**
   * Switches only this window: its Claude gets the account's own login, and
   * other windows keep theirs. Claude conversations already running here keep
   * the previous login, in its own place, so nothing is written back.
   */
  private async switchWindow(profileId: string, skipConfirmInTests?: boolean): Promise<void> {
    // Re-reading the login takes up to a second, so it runs in the background while the user answers, and the
    // question appears at once, going by what the tab shows. Only a refusal waits for the read, so it never comes
    // from what the tab showed; a yes is checked against it before anything changes.
    const checked = this.refresh();
    let asked = this.windowSwitchTarget(profileId, false);
    if (!asked) {
      await checked;
      asked = this.windowSwitchTarget(profileId, true);
    }
    if (!asked) {
      return;
    }
    if ((asked.status === 'needs-relogin' || asked.signedInAs) && !(await this.switchExpiredAnyway(asked))) {
      return;
    }
    const mode = switchMode();
    const skipConfirm = this.testMode && skipConfirmInTests;
    if (
      (mode === 'restartExtensions' || mode === 'reloadWindow') &&
      !skipConfirm &&
      vscode.workspace.getConfiguration('claudeSwitch').get<boolean>('confirmBeforeSwitch', true)
    ) {
      const choice = await this.view.confirm({
        title: `Switch this window to "${asked.alias}"?`,
        message: WINDOW_RESTART_DETAIL[mode],
        actions: [{ id: 'switch', label: mode === 'reloadWindow' ? 'Switch and reload' : 'Switch and restart', style: 'primary' }],
      });
      if (choice !== 'switch') {
        return;
      }
    }

    // Again, against the files: by now the read that started with the click has usually finished, or auto-refresh
    // has read them since. Under the switch lock, reconcileFolders reads the default login once more anyway.
    await checked;
    const profile = this.windowSwitchTarget(profileId, true);
    if (!profile) {
      return;
    }
    const defaultId = this.live.kind === 'known' ? this.live.profile.id : undefined;
    try {
      await this.view.busy(`Switching this window to "${profile.alias}"…`, async () => {
        await this.store.setWindowChoice(this.window.key, profile.id, this.window.projects);
        // Gives the account its own login folder, unless it is the default account.
        await this.engine.reconcileFolders(this.window.folders, defaultId, this.store.chosenAccounts(), false);
        if (profile.id !== defaultId && !this.window.folders.has(profile.id)) {
          throw new Error(`Claude Switch could not prepare the login for "${profile.alias}".`);
        }
      });
    } catch (err) {
      await this.refresh();
      this.showError(err);
      return;
    }
    this.log.info(`Switched this window to "${profile.alias}".`);
    await this.store.markUsed(profile.id).catch(() => undefined);
    this.reloadPending = undefined;
    // Points this window's Claude at the new login; while switching, that is not news to report.
    await this.refresh();

    if (mode === 'reloadWindow' || mode === 'restartExtensions') {
      await this.restartWindow(mode, `Switching to ${profile.alias}…`);
      return;
    }
    // Instant: new Claude conversations in this window use the account from now on.
    if (usageCheckSeconds()) {
      void this.checkUsage();
    }
    const opened = mode === 'newConversation' && (await this.openConversation());
    void this.view
      .notify(
        'success',
        `This window now uses "${profile.alias}". ${opened ? 'A new Claude conversation is open on it.' : 'New Claude conversations here use it.'} Conversations and terminals that were already open keep the previous account; other windows keep theirs.`,
        opened ? [] : [{ id: 'new', label: 'New conversation', style: 'primary' }],
      )
      .then((choice) => {
        if (choice === 'new') {
          void this.openConversation();
        }
      });
  }

  /**
   * The account to switch this window to, going by the last refresh; undefined when this window can't switch to
   * it, and then, with report, the user is told why.
   */
  private windowSwitchTarget(profileId: string, report: boolean): ProfileMeta | undefined {
    const profile = this.store.get(profileId);
    if (!profile) {
      if (report) {
        void this.view.notify('error', 'That account is no longer saved in Claude Switch.');
      }
      return undefined;
    }
    if (this.live.kind === 'error') {
      // Which account is the default decides which accounts get a login folder: guessing could put one login in two places.
      if (report) {
        this.showError(this.live.message);
      }
      return undefined;
    }
    if (this.windowLive.kind === 'known' && this.windowLive.profile.id === profile.id) {
      if (report) {
        void this.view.notify('info', `This window already uses "${profile.alias}".`);
      }
      return undefined;
    }
    return profile;
  }

  /**
   * For an account whose saved login expired, or turned out to be another
   * account's: offers to sign in again, or for the latter to keep it as that
   * account. True means switch anyway.
   */
  private async switchExpiredAnyway(profile: ProfileMeta): Promise<boolean> {
    const other = profile.signedInAs;
    const choice = await this.view.confirm({
      title: other ? `The saved login for "${profile.alias}" is ${other}'s, not ${profile.email}'s` : `The saved login for "${profile.alias}" has expired`,
      message: other
        ? `Sign in to ${profile.email} again in your browser, or keep "${profile.alias}" as ${other}'s account: its name and colour stay, and its email and plan become ${other}'s. Your current login is not affected.`
        : 'Sign in to it again in your browser. Your current login is not affected.',
      actions: [
        { id: 'signin', label: 'Sign in again', style: 'primary' },
        ...(other ? [{ id: 'keep', label: `Keep as ${other}` }] : []),
        { id: 'switch', label: 'Switch anyway' },
      ],
    });
    // Not awaited: signing in takes a while, and switching should not stay blocked meanwhile.
    if (choice === 'signin') {
      this.addAccount(isValidEmail(profile.email) ? profile.email : undefined, profile.id).catch((err: unknown) => this.showError(err));
    } else if (choice === 'keep') {
      this.keepAsSignedIn(profile.id, false).catch((err: unknown) => this.showError(err));
    }
    return choice === 'switch';
  }

  /** Switches every window, by changing the default login in ~/.claude. */
  private async switchToProfile(profileId: string, skipConfirmInTests?: boolean): Promise<void> {
    const live = await this.refresh();
    const profile = this.store.get(profileId);
    if (!profile) {
      void this.view.notify('error', 'That account is no longer saved in Claude Switch.');
      return;
    }
    const othersChose = [...this.store.chosenAccounts()].some((id) => id !== profile.id);
    if (live.kind === 'known' && live.profile.id === profile.id && !othersChose) {
      void this.view.notify('info', `"${profile.alias}" is already the active Claude account.`);
      return;
    }
    if ((profile.status === 'needs-relogin' || profile.signedInAs) && !(await this.switchExpiredAnyway(profile))) {
      return;
    }
    if (live.kind === 'unknown') {
      const choice = await this.view.confirm({
        title: 'Save the current login first?',
        message: `Claude is signed in as ${live.login.account.emailAddress}, which isn't saved in Claude Switch. Save it to be able to switch back. A backup is kept either way.`,
        actions: [
          { id: 'save', label: 'Save and switch', style: 'primary' },
          { id: 'skip', label: 'Switch without saving' },
        ],
      });
      if (!choice) {
        return;
      }
      if (choice === 'save' && !(await this.saveCurrentLogin(live.login.account))) {
        return;
      }
    }
    // Instant switches interrupt nothing, so only the restarting modes ask first.
    const mode = switchMode();
    const skipConfirm = this.testMode && skipConfirmInTests;
    if (
      (mode === 'restartExtensions' || mode === 'reloadWindow') &&
      !skipConfirm &&
      vscode.workspace.getConfiguration('claudeSwitch').get<boolean>('confirmBeforeSwitch', true)
    ) {
      const choice = await this.view.confirm({
        title: this.window.enabled ? `Switch every window to "${profile.alias}"?` : `Switch Claude to "${profile.alias}"?`,
        message: RESTART_DETAIL[mode],
        actions: [{ id: 'switch', label: mode === 'reloadWindow' ? 'Switch and reload' : 'Switch and restart', style: 'primary' }],
      });
      if (choice !== 'switch') {
        return;
      }
    }

    const target = profile;
    const title = this.window.enabled ? `Switching every window to "${target.alias}"…` : `Switching Claude to "${target.alias}"…`;
    await this.applyAndActivate(title, async () => {
      // Its newest tokens may be in its login folder, if a window used it; the folder goes with the switch.
      const result = await this.engine.switchTo(target.id, { folders: this.window.enabled ? this.window.folders : undefined });
      if (this.window.enabled) {
        // Every window now uses the default account; the target's login folder goes, after its tokens are saved.
        try {
          await this.store.clearWindowChoices();
          await this.engine.reconcileFolders(this.window.folders, result.profile.id, new Set(), false);
        } catch (err) {
          // The switch itself is done; the next refresh finishes this.
          this.log.warn(`Switched, but could not tidy up the login folders yet: ${errorMessage(err)}`);
        }
      }
      if (result.outcome === 'already-active' && !othersChose) {
        void this.view.notify('info', `"${target.alias}" is already the active Claude account.`);
        return undefined;
      }
      return { alias: result.profile.alias, profileId: result.profile.id };
    });
  }

  /**
   * defaultEmail pre-fills the prompt, for signing in again to a saved account,
   * expectedId; see saveSignedInLogin for when the browser signs in to another.
   */
  async addAccount(defaultEmail?: string, expectedId?: string): Promise<void> {
    if (this.addingAccount) {
      // The tab already shows the sign-in in progress, or its first question.
      this.view.reveal();
      return;
    }
    this.addingAccount = true;
    try {
      const email = await this.view.input({
        title: 'Add an account',
        message: 'Email of the account to add. Optional: it pre-fills the sign-in page.',
        placeholder: 'name@example.com',
        value: defaultEmail,
        rule: 'email',
        optional: true,
        confirmLabel: 'Continue',
      });
      if (email === undefined) {
        return;
      }
      const login = await this.signInInBackground(email || undefined);
      if (login) {
        await this.saveSignedInLogin(login, expectedId);
      }
    } finally {
      this.addingAccount = false;
    }
  }

  /**
   * "Sign in again" on an account whose saved login expired, or is another
   * account's: Add Account, with its email filled in.
   */
  async signInAgain(profileId: string): Promise<void> {
    const profile = this.store.get(profileId);
    if (profile) {
      await this.addAccount(isValidEmail(profile.email) ? profile.email : undefined, profile.id);
    }
  }

  /**
   * "Keep as …" on an account whose login turned out to be another account's
   * (see ProfileMeta.signedInAs): makes it that account, keeping its name and
   * colour. ask: false when the user already chose it in a dialog.
   */
  async keepAsSignedIn(profileId: string, ask = true): Promise<void> {
    const profile = this.store.get(profileId);
    const email = profile?.signedInAs;
    if (!profile || !email) {
      return;
    }
    if (ask) {
      const choice = await this.view.confirm({
        title: `Make "${profile.alias}" ${email}'s account?`,
        message: `Claude here really runs as ${email}. "${profile.alias}" keeps its name and colour, and its email, plan and login become ${email}'s. ${profile.email} is no longer saved; add it again with Add account if you need it.`,
        actions: [{ id: 'keep', label: `Keep as ${email}`, style: 'primary' }],
      });
      if (choice !== 'keep') {
        return;
      }
    }
    const updated = await this.view.busy(`Asking Claude whose login "${profile.alias}" has…`, () =>
      this.engine.keepAsSignedIn(profileId, this.window.folders, path.join(this.storageDir, 'usage', profileId)),
    );
    await this.refresh();
    void this.view.notify(
      'success',
      updated.email === profile.email ? `The login of "${profile.alias}" is its own after all.` : `"${profile.alias}" is now ${updated.email}'s account.`,
    );
  }

  /** "Open page" on the sign-in card. */
  async signInOpenPage(): Promise<void> {
    const url = this.signIn?.cli.url;
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  /** "Copy link" on the sign-in card. */
  async signInCopyLink(): Promise<void> {
    const url = this.signIn?.cli.url;
    if (url) {
      await vscode.env.clipboard.writeText(url);
      void this.view.notify('success', 'Sign-in link copied. Open it in a private window, or a browser signed in to the account to add.');
    }
  }

  /** "Paste Sign-in Code" from the Command Palette; the sign-in card has its own code box. */
  async signInPasteCode(): Promise<void> {
    const signIn = this.signIn;
    if (!signIn) {
      return;
    }
    const code = await this.view.input({
      title: 'Paste the sign-in code',
      message: 'Paste the code the sign-in page shows after you approve access.',
      rule: 'code',
      confirmLabel: 'Submit',
    });
    if (code && this.signIn === signIn) {
      this.signInSendCode(code);
    }
  }

  /** Sends the code from the sign-in page to the waiting `claude auth login`. */
  signInSendCode(code: string): void {
    if (!this.signIn) {
      return;
    }
    try {
      this.signIn.cli.sendCode(code);
      this.log.info('Add Account: sent the code from the sign-in page to Claude.');
    } catch (err) {
      this.showError(err);
    }
  }

  signInCancel(): void {
    this.signIn?.abort.abort();
  }

  /** Changes an account's name and avatar colour. profileId comes from the tab; without it, the tab asks which account. */
  async editAccount(profileId?: string): Promise<void> {
    const profile = profileId ? this.store.get(profileId) : await this.pickProfile('Which account do you want to edit?');
    if (!profile) {
      return;
    }
    const color = colourOf(profile);
    const taken = this.store
      .list()
      .filter((p) => p.id !== profile.id)
      .map((p) => p.alias);
    const result = await this.view.editProfile({ title: 'Edit account', message: profile.email, value: profile.alias, taken, color, confirmLabel: 'Save' });
    if (!result || (result.alias === profile.alias && result.color === color)) {
      return;
    }
    await this.store.edit(profile.id, result);
    this.log.info(result.alias === profile.alias ? `Changed the colour of "${profile.alias}".` : `Renamed "${profile.alias}" to "${result.alias}".`);
    await this.refresh();
  }

  /**
   * profileId comes from the tab; without it, the tab asks which account. Accounts in use can go too: windows
   * that use one through its login folder go back to the default account, and the default account's login
   * stays in ~/.claude, only no longer saved in Claude Switch.
   */
  async removeAccount(profileId?: string): Promise<void> {
    await this.refresh();
    const profile = profileId ? this.store.get(profileId) : await this.pickProfile('Which account do you want to remove?');
    if (!profile) {
      return;
    }
    const isDefault = this.live.kind === 'known' && this.live.profile.id === profile.id;
    // This window uses it through its own login folder, so it goes back to the default account.
    const thisWindows = profile.id === this.windowAccountId() && !isDefault;
    const mode = switchMode();
    const restarts = thisWindows && (mode === 'reloadWindow' || mode === 'restartExtensions');
    const fallback = this.live.kind === 'known' ? `"${this.live.profile.alias}"` : 'the default login';
    const choice = await this.view.confirm({
      title: `Remove "${profile.alias}"?`,
      message: [
        `The saved login for ${profile.email} and its backups are deleted from this device. Your Anthropic account is not affected.`,
        isDefault
          ? `It is the default account: Claude stays signed in to it, and windows without their own account keep using it, but Claude Switch no longer saves it. You can save it again with Save.`
          : thisWindows
            ? `This window, and any other that uses it, goes back to the default account, ${fallback}${restarts ? `; this window ${mode === 'reloadWindow' ? 'reloads' : 'restarts its extensions'}` : ''}.`
            : this.store.chosenAccounts().has(profile.id)
              ? 'Windows that use it go back to the default account.'
              : undefined,
      ]
        .filter(Boolean)
        .join('\n\n'),
      actions: [{ id: 'remove', label: restarts ? (mode === 'reloadWindow' ? 'Remove and reload' : 'Remove and restart') : 'Remove', style: 'danger' }],
    });
    if (choice !== 'remove') {
      return;
    }
    await this.store.remove(profile.id);
    await this.forgetFolders(profile.id);
    this.log.info(`Removed "${profile.alias}".`);
    // Points this window's Claude at the default login, when it used the account's.
    await this.refresh();
    if (thisWindows) {
      // As after switching this window to the default account: its login moving is not news to report.
      this.reloadPending = undefined;
      if (restarts) {
        await this.restartWindow(mode, 'Reloading…');
        return;
      }
      this.render();
    }
    void this.view.notify('success', `Removed "${profile.alias}".`);
  }

  /** The account this window uses, if it is a saved one. */
  private windowAccountId(): string | undefined {
    return this.windowLive.kind === 'known' ? this.windowLive.profile.id : undefined;
  }

  /** Deletes an account's login folder and its usage-check settings folder; all of them without an id. */
  private async forgetFolders(profileId?: string): Promise<void> {
    const targets = profileId
      ? [this.window.folders.dirOf(profileId), path.join(this.storageDir, 'usage', profileId)]
      : [this.window.folders.root, path.join(this.storageDir, 'usage')];
    for (const target of targets) {
      await fs.rm(target, { recursive: true, force: true }).catch((err) => this.log.warn(`Could not delete ${target}: ${errorMessage(err)}`));
    }
  }

  async recapture(): Promise<void> {
    let live: LiveState;
    try {
      live = await this.engine.recapture();
    } catch (err) {
      this.showError(err);
      return;
    }
    // Also brings this window's card and the status bar up to date, not only the default login.
    await this.refresh();
    switch (live.kind) {
      case 'known':
        void this.view.notify('success', `Saved the current login into "${live.profile.alias}".`);
        break;
      case 'unknown':
        await this.saveCurrentLogin(live.login.account);
        break;
      case 'signed-out':
        void this.view.notify('warning', 'Claude Code is not signed in. Use Add account to sign in.');
        break;
      case 'error':
        this.showError(live.message);
        break;
    }
  }

  /** Lets the user replace the estimated renewal date with the real one. */
  async setRenewal(profileId?: string): Promise<void> {
    const profile = profileId ? this.store.get(profileId) : await this.pickProfile('Which account do you want to set a renewal date for?');
    if (!profile) {
      return;
    }
    const shown = nextRenewal(profile.plan, profile.renewal, Date.now());
    const date = await this.view.input({
      title: `Renewal date for "${profile.alias}"`,
      message: profile.renewal
        ? 'The next renewal date. Leave it empty to go back to the estimate.'
        : 'The next renewal date, as shown on the claude.ai billing page.',
      value: shown?.date ?? '',
      placeholder: 'YYYY-MM-DD',
      rule: 'date',
      optional: true,
      confirmLabel: 'Next',
    });
    if (date === undefined) {
      return;
    }
    if (!date) {
      await this.store.setRenewal(profile.id, undefined);
      this.log.info(`Cleared the renewal date for "${profile.alias}".`);
      await this.refresh();
      return;
    }
    const cycle = await this.view.confirm({
      title: 'How often does it renew?',
      actions: [
        { id: 'monthly', label: 'Monthly', style: 'primary' },
        { id: 'yearly', label: 'Yearly' },
      ],
    });
    if (cycle !== 'monthly' && cycle !== 'yearly') {
      return;
    }
    await this.store.setRenewal(profile.id, { date, cycle });
    this.log.info(`Set a ${cycle} renewal date for "${profile.alias}".`);
    await this.refresh();
  }

  /** Opens claude.ai's billing page, where the exact renewal date is. */
  async openBilling(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(BILLING_URL));
  }

  async saveCurrent(): Promise<void> {
    const live = await this.refresh();
    switch (live.kind) {
      case 'unknown':
        await this.saveCurrentLogin(live.login.account);
        break;
      case 'known':
        void this.view.notify('info', `The current login is already saved as "${live.profile.alias}".`);
        break;
      case 'signed-out':
        void this.view.notify('warning', 'Claude Code is not signed in. Use Add account to sign in.');
        break;
      case 'error':
        this.showError(live.message);
        break;
    }
  }

  async restoreBackup(): Promise<void> {
    const latest = this.store.listBackups()[0];
    if (!latest) {
      void this.view.notify('info', 'There is no backup yet. Claude Switch saves one each time the default account changes, with Switch All Windows.');
      return;
    }
    const from = latest.fromProfileId ? this.store.get(latest.fromProfileId)?.alias : undefined;
    const to = latest.toProfileId ? this.store.get(latest.toProfileId)?.alias : undefined;
    const choice = await this.view.confirm({
      title: 'Restore the default login from before the last Switch All Windows?',
      message: [
        `Backup taken ${new Date(latest.at).toLocaleString()}, when switching from ${from ? `"${from}"` : 'an unsaved or removed login'} to ${to ? `"${to}"` : 'another account'}.`,
        this.window.enabled ? 'This changes the default account, which windows without their own account use.' : undefined,
      ]
        .filter(Boolean)
        .join('\n\n'),
      actions: [{ id: 'restore', label: 'Restore', style: 'primary' }],
    });
    if (choice !== 'restore') {
      return;
    }
    await this.applyAndActivate('Restoring the Claude login backup…', async () => {
      // If a window used the account since, its newest tokens are in its login folder, which goes with the restore.
      const { profile } = await this.engine.restoreBackup(latest.slot, this.window.enabled ? this.window.folders : undefined);
      return { alias: profile?.alias, profileId: profile?.id };
    });
  }

  /**
   * Shows the loading screen, then reloads this window or restarts its
   * extensions. If the window is still here a while later, the reload was
   * cancelled (say, at a prompt to save), so the accounts come back.
   */
  private async restartWindow(how: 'reloadWindow' | 'restartExtensions', text: string): Promise<void> {
    await this.view.showReloading(text);
    await (how === 'reloadWindow' ? this.reloadWindow() : this.restartExtensions());
    setTimeout(() => void this.refresh(), RELOAD_GIVE_UP_MS);
  }

  /** The Reload button on the banner and status bar, after this window's account changed elsewhere. */
  async reloadNow(): Promise<void> {
    await this.restartWindow(switchMode() === 'restartExtensions' ? 'restartExtensions' : 'reloadWindow', 'Reloading…');
  }

  /** Opens the activity log page in the Claude Switch tab. */
  showLog(): void {
    this.view.openLog();
  }

  async forgetAll(): Promise<void> {
    const choice = await this.view.confirm({
      title: 'Remove all accounts and backups?',
      message:
        'Every login Claude Switch saved is deleted from this device, and every window goes back to the default login in ~/.claude, which stays as it is.',
      actions: [{ id: 'remove', label: 'Remove all', style: 'danger' }],
    });
    if (choice !== 'remove') {
      return;
    }
    await this.store.clearAll();
    await this.forgetFolders();
    this.log.info('Removed all saved accounts and backups.');
    await this.refresh();
    void this.view.notify('success', 'Removed all saved accounts and backups.');
  }

  /**
   * Another window changed the default account. Windows with their own account
   * are unaffected, unless the change took that away, in which case refresh()
   * asks them to reload. Windows on the default account: the restarting modes
   * ask to reload; in the instant modes, new conversations pick the login up.
   */
  async onRemoteSwitch(signal: SwitchSignal): Promise<void> {
    // The user chose another account on purpose; this window's watch no longer applies.
    this.watch = undefined;
    await this.refresh();
    if (this.windowFolderId || this.reloadPending) {
      return;
    }
    const mode = switchMode();
    if (mode === 'restartExtensions' || mode === 'reloadWindow') {
      this.reloadPending = { alias: signal.alias };
      this.render();
      return;
    }
    void this.view.notify(
      'info',
      `Switched to ${signal.alias ? `"${signal.alias}"` : 'another account'} in another window. New Claude conversations here use it too.`,
    );
  }

  dispose(): void {
    this.stopAutoRefresh();
    clearInterval(this.usageTimer);
    this.signIn?.cli.cancel();
  }

  private render(): void {
    this.statusBar.update(this.windowLive, this.reloadPending);
    const signIn = this.signIn && { email: this.signIn.email, url: this.signIn.cli.url };
    // When this window has its own account, say which one the other windows use by default.
    let windowNote: string | undefined;
    if (this.windowFolderId) {
      if (this.live.kind === 'known') {
        windowNote = `Other windows use ${this.live.profile.alias} unless you switch them.`;
      } else if (this.live.kind === 'unknown') {
        windowNote = `Other windows use ${this.live.login.account.emailAddress}, which isn't saved, unless you switch them.`;
      } else if (this.live.kind === 'signed-out') {
        windowNote = "Other windows aren't signed in to Claude unless you switch them.";
      }
    }
    this.view.update(this.windowLive, this.reloadPending, signIn, this.switching, windowNote, this.window.enabled);
  }

  /** Swaps the login, then makes Claude Code use it as claudeSwitch.switchMode says. */
  private async applyAndActivate(
    title: string,
    apply: () => Promise<{ alias?: string; profileId?: string } | undefined>,
  ): Promise<void> {
    const previousId = this.live.kind === 'known' ? this.live.profile.id : undefined;
    let applied: { alias?: string; profileId?: string } | undefined;
    try {
      applied = await this.view.busy(title, apply);
    } catch (err) {
      await this.refresh();
      this.showError(err);
      return;
    }
    if (!applied) {
      return;
    }
    this.reloadPending = undefined;
    await this.sync.publish(applied.alias).catch((err) => {
      this.log.warn(`Could not notify other windows: ${errorMessage(err)}`);
    });

    const mode = switchMode();
    if (mode === 'reloadWindow' || mode === 'restartExtensions') {
      await this.refresh();
      await this.restartWindow(mode, applied.alias ? `Switching to ${applied.alias}…` : 'Reloading…');
      return;
    }

    // Instant: nothing restarts. New conversations read the new login from disk.
    // The watch below replaces the after-reload check, which no window should run for this switch.
    await this.store.setLastSwitch(undefined).catch(() => undefined);
    const alias = applied.alias ?? 'the new account';
    this.watch = applied.profileId ? { profileId: applied.profileId, alias, previousId, until: Date.now() + WRITE_BACK_WATCH_MS } : undefined;
    await this.refresh();
    // The new account's numbers are from when it was last active.
    if (usageCheckSeconds()) {
      void this.checkUsage();
    }
    let opened = false;
    if (mode === 'newConversation') {
      opened = await this.openConversation();
    }
    // Not awaited: the switch is done, and the next one should not wait for this notice to close.
    void this.view
      .notify(
        'success',
        `Switched to "${alias}". ${opened ? 'A new Claude conversation is open on it.' : 'New Claude conversations use it.'} Conversations that were already open keep the previous account until you start a new one.`,
        opened ? [] : [{ id: 'new', label: 'New conversation', style: 'primary' }],
      )
      .then((choice) => {
        if (choice === 'new') {
          void this.openConversation();
        }
      });
  }

  private async openConversation(): Promise<boolean> {
    try {
      await this.startConversation();
      return true;
    } catch (err) {
      // Claude Code may be missing or disabled; the switch itself still worked.
      this.log.warn(`Could not open a new Claude Code conversation: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * Runs `claude auth login` hidden, with its own CLAUDE_CONFIG_DIR, so the live
   * login is never touched. The tab's sign-in card shows progress and fallbacks.
   */
  private async signInInBackground(email?: string): Promise<SavedLogin | undefined> {
    const claude = resolveClaude();
    const dir = await createLoginDir();
    let cli: ClaudeLogin;
    try {
      cli = this.createLogin({ command: claude.command, dir, email });
    } catch (err) {
      await this.cleanUpLoginDir(dir);
      this.showError(err);
      return undefined;
    }
    const abort = new AbortController();
    this.signIn = { cli, abort, email };
    const stopWatchingUrl = cli.onUrl(() => this.render());
    void vscode.commands.executeCommand('setContext', 'claudeSwitch.signingIn', true);
    this.render();
    this.view.reveal();
    this.log.info(`Add Account: started a background sign-in with the Claude CLI from ${claude.source}.`);

    let failure: string | undefined;
    let settled = false;
    void cli.exited.then(({ code, lastLine }) => {
      if (settled || abort.signal.aborted) {
        return;
      }
      if (code !== 0) {
        failure = `Claude's sign-in stopped${code === null ? '' : ` (exit code ${code})`}. ${lastLine}`.trim();
        abort.abort();
        return;
      }
      // Claude reports success; its files should already be there.
      setTimeout(() => {
        if (!settled && !abort.signal.aborted) {
          failure = 'Claude finished signing in, but Claude Switch could not find the new login.';
          abort.abort();
        }
      }, 20_000);
    });

    let login: SavedLogin | undefined;
    try {
      login = await waitForLogin(dir, { signal: abort.signal, intervalMs: 1000 });
    } catch (err) {
      if (!failure && !abort.signal.aborted) {
        failure = errorMessage(err);
      } else if (!failure) {
        this.log.info('Add Account: cancelled.');
      }
    } finally {
      settled = true;
      stopWatchingUrl();
      cli.cancel();
      this.signIn = undefined;
      void vscode.commands.executeCommand('setContext', 'claudeSwitch.signingIn', false);
      this.render();
      await this.cleanUpLoginDir(dir);
    }

    if (failure) {
      this.log.error(`Add Account: ${failure}`);
      // Not awaited: the notice stays until dismissed, and Add Account must not stay busy meanwhile.
      void this.view
        .notify('error', failure, [
          { id: 'terminal', label: 'Sign in in a terminal' },
          { id: 'log', label: 'Show log' },
        ])
        .then((choice) => {
          if (choice === 'terminal') {
            this.addAccountInTerminal(claude.command).catch((err: unknown) => this.showError(err));
          } else if (choice === 'log') {
            this.showLog();
          }
        });
    }
    return login;
  }

  /** The terminal fallback offered when the background sign-in fails. */
  private async addAccountInTerminal(command: string): Promise<void> {
    if (this.addingAccount) {
      this.view.reveal();
      return;
    }
    this.addingAccount = true;
    try {
      const login = await this.signInInTerminal(command);
      if (login) {
        await this.saveSignedInLogin(login);
      }
    } finally {
      this.addingAccount = false;
    }
  }

  /**
   * Fallback, only on request: runs the Claude CLI itself as a terminal, with
   * its own CLAUDE_CONFIG_DIR, for when the background sign-in does not work.
   */
  private async signInInTerminal(command: string): Promise<SavedLogin | undefined> {
    const dir = await createLoginDir();
    const abort = new AbortController();
    const terminal = vscode.window.createTerminal({
      name: 'Claude Switch: Sign In',
      shellPath: command,
      cwd: dir,
      // null removes a variable: an API key can't replace the sign-in, and the window's login folder can't catch it.
      env: {
        CLAUDE_CONFIG_DIR: dir,
        [LOGIN_DIR_VARIABLE]: null,
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_AUTH_TOKEN: null,
        CLAUDE_CODE_OAUTH_TOKEN: null,
      },
      iconPath: new vscode.ThemeIcon('account'),
      isTransient: true,
    });
    const closed = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        abort.abort();
      }
    });
    this.log.info('Add Account: opened an isolated sign-in terminal.');
    try {
      terminal.show();
      return await this.view.busy('Sign in in the terminal. If Claude does not ask you to, type /login. Close the terminal to cancel.', () =>
        waitForLogin(dir, { signal: abort.signal }),
      );
    } catch (err) {
      if (abort.signal.aborted) {
        this.log.info('Add Account: cancelled.');
      } else {
        this.showError(err);
      }
      return undefined;
    } finally {
      closed.dispose();
      terminal.dispose();
      await this.cleanUpLoginDir(dir);
    }
  }

  private async cleanUpLoginDir(dir: string): Promise<void> {
    // Let the claude process exit and release its files first.
    await delay(1000);
    try {
      await removeLoginDir(dir);
    } catch (err) {
      this.log.warn(`Could not delete the sign-in folder: ${errorMessage(err)}`);
      void this.view.notify(
        'warning',
        `Claude Switch could not delete its temporary sign-in folder, which contains login tokens. Delete it manually: ${dir}`,
      );
    }
  }

  /**
   * expectedId: the account being signed in to again. When the browser signed
   * in to another account, one that isn't saved, the user chooses between
   * making the account that one and adding it as a new account.
   */
  private async saveSignedInLogin(login: SavedLogin, expectedId?: string): Promise<void> {
    const email = login.account.emailAddress;
    const existing = this.store.findByAccount(login.account);
    const expected = expectedId ? this.store.get(expectedId) : undefined;
    if (!existing && expected) {
      const choice = await this.view.confirm({
        title: `You signed in as ${email}, not ${expected.email}`,
        message: `The sign-in page signed in to another account. To sign in to ${expected.email}, choose it there, or use "Copy link" in a private window.\n\nOr keep this sign-in: make "${expected.alias}" ${email}'s account, keeping its name and colour, or add ${email} as a new account.`,
        actions: [
          { id: 'adopt', label: `Make "${expected.alias}" ${email}`, style: 'primary' },
          { id: 'new', label: 'Add as new account' },
        ],
      });
      if (choice === 'adopt') {
        const wasDefault = this.live.kind === 'known' && this.live.profile.id === expected.id;
        const adopted = await this.engine.adoptLogin(expected.id, login, this.window.enabled ? this.window.folders : undefined);
        await this.refresh();
        if (wasDefault) {
          await this.offerNewSignIn(adopted);
        } else {
          void this.view.notify('success', `"${adopted.alias}" is now ${email}'s account.`);
        }
        return;
      }
      if (choice !== 'new') {
        return;
      }
    }
    if (!existing) {
      const alias = await this.promptAlias('Name this account', `A name for ${email}, such as Work or Personal.`, this.suggestAlias(login.account));
      if (!alias) {
        return;
      }
      const profile = await this.store.add(alias, login);
      this.log.info(`Added "${profile.alias}".`);
      await this.refresh();
      void this.view
        .notify('success', `Added "${profile.alias}" (${email}).`, [{ id: 'switch', label: 'Switch now', style: 'primary' }])
        .then((choice) => (choice === 'switch' ? this.switchAccount({ profileId: profile.id }) : undefined))
        .catch((err: unknown) => this.showError(err));
      return;
    }

    const choice = await this.view.confirm({
      title: `${email} is already saved as "${existing.alias}"`,
      message:
        'Replace its saved login with this sign-in?\n\nMeant to add a different account? Your browser is probably signed in to this one. Sign out of claude.ai there, or use "Copy link" in a private window, and add the account again.',
      actions: [{ id: 'replace', label: 'Replace', style: 'primary' }],
    });
    if (choice !== 'replace') {
      return;
    }
    await this.store.updateLogin(existing.id, login);
    this.log.info(`Replaced the saved login for "${existing.alias}".`);
    const live = await this.refresh();
    if (live.kind !== 'known' || live.profile.id !== existing.id) {
      // Windows that use it through its login folder get the new sign-in for their next Claude conversations.
      if (this.window.enabled && this.window.folders.has(existing.id)) {
        await this.window.folders.write(existing.id, login.credentialsRaw);
        this.log.info(`Gave the windows that use "${existing.alias}" the new sign-in.`);
      }
      void this.view.notify('success', `Updated the saved login for "${existing.alias}".`);
      return;
    }
    await this.offerNewSignIn(existing);
  }

  /** The account just signed in to again is the default one, so Claude still holds the old tokens until they are replaced. */
  private async offerNewSignIn(profile: ProfileMeta): Promise<void> {
    const apply = await this.view.confirm({
      title: `"${profile.alias}" is the active account`,
      message: 'Use the new sign-in now?',
      actions: [{ id: 'apply', label: 'Use now', style: 'primary' }],
    });
    if (apply === 'apply') {
      await this.applyAndActivate(`Applying the new sign-in for "${profile.alias}"…`, async () => {
        const result = await this.engine.switchTo(profile.id, { replaceLive: true });
        return { alias: result.profile.alias, profileId: result.profile.id };
      });
    }
  }

  private async saveCurrentLogin(account: OAuthAccount): Promise<ProfileMeta | undefined> {
    const first = this.store.list().length === 0;
    const alias = await this.promptAlias(
      first ? 'Save as your first account' : 'Save the current login',
      `A name for ${account.emailAddress}, such as Work or Personal.`,
      this.suggestAlias(account),
    );
    if (!alias) {
      return undefined;
    }
    try {
      const profile = await this.engine.saveCurrent(alias, identityOf(account));
      await this.refresh();
      void this.view.notify('success', `Saved the current login as "${profile.alias}".`);
      return profile;
    } catch (err) {
      this.showError(err);
      return undefined;
    }
  }

  private async pickProfile(title: string, profiles = this.store.list(), message?: string): Promise<ProfileMeta | undefined> {
    if (profiles.length === 0) {
      void this.view.notify('info', 'No accounts are saved yet. Add one first.');
      return undefined;
    }
    const id = await this.view.choose({
      title,
      message,
      options: profiles.map((profile) => ({ id: profile.id, label: profile.alias, description: profile.email })),
    });
    return id ? this.store.get(id) : undefined;
  }

  private async promptAlias(title: string, message: string, value: string, excludeId?: string): Promise<string | undefined> {
    const taken = this.store
      .list()
      .filter((p) => p.id !== excludeId)
      .map((p) => p.alias);
    const alias = await this.view.input({ title, message, value, placeholder: 'Work, Personal…', rule: 'alias', taken, confirmLabel: 'Save' });
    return alias || undefined;
  }

  private suggestAlias(account: OAuthAccount): string {
    const taken = new Set(this.store.list().map((p) => p.alias.toLowerCase()));
    const org = typeof account.organizationName === 'string' ? account.organizationName : '';
    // Personal plans name the organization after the email, which makes a poor alias.
    const base = (org && !org.includes('@') ? org : account.emailAddress.split('@')[0]).slice(0, MAX_ALIAS_LENGTH - 3);
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      candidate = `${base} ${n}`;
    }
    return candidate;
  }

  /** Shows an error in the tab, with a button to the log. Also for errors from clicks and commands. */
  showError(err: unknown): void {
    const message = typeof err === 'string' ? err : errorMessage(err);
    this.log.error(message);
    void this.view.notify('error', message, [{ id: 'log', label: 'Show log' }]).then((choice) => {
      if (choice === 'log') {
        this.showLog();
      }
    });
  }
}

/**
 * A window's own account, in the shape the status bar and the tab take. For a
 * saved account they show only the profile, so the login is left empty.
 */
function profileLive(profile: ProfileMeta): LiveState {
  return { kind: 'known', profile, login: { credentialsRaw: '', account: { accountUuid: '', emailAddress: profile.email } } };
}

/**
 * The Claude CLI used to sign in: the claudeSwitch.claudePath setting, else the
 * CLI bundled with the Claude Code extension (the same version that will use
 * the login), else `claude` on PATH.
 */
function resolveClaude(): { command: string; source: string } {
  // Machine-scoped, so a workspace's settings can never choose what runs here.
  const configured = vscode.workspace.getConfiguration('claudeSwitch').get<string>('claudePath')?.trim();
  if (configured) {
    // A bare name such as `claude` is looked up on PATH as a terminal would, so an npm-installed claude.cmd starts too.
    const bare = path.basename(configured) === configured;
    return { command: (bare && findOnPath(configured)) || configured, source: 'the claudeSwitch.claudePath setting' };
  }
  const claudeExtension = vscode.extensions.getExtension('anthropic.claude-code');
  if (claudeExtension) {
    const binary = path.join(
      claudeExtension.extensionPath,
      'resources',
      'native-binary',
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    );
    if (existsSync(binary)) {
      return { command: binary, source: 'the Claude Code extension' };
    }
  }
  return { command: findOnPath('claude') ?? 'claude', source: 'PATH' };
}

