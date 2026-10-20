import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { nextRenewal } from './accountDetails';
import { AccountsView } from './accountsView';
import { ClaudeLogin, ClaudeLoginOptions, createLoginDir, findOnPath, isValidEmail, removeLoginDir, waitForLogin } from './addAccount';
import { delay, identityOf, OAuthAccount, SavedLogin } from './claudeFiles';
import { errorMessage } from './log';
import { ProfileMeta, ProfileStore } from './profileStore';
import { RosterLog } from './rosterLog';
import { RosterStatusBar } from './statusBar';
import { LiveState, LockBusyError, SwitchEngine } from './switchEngine';
import { askClaudeForUsage, UsageCheckOptions } from './usageCheck';
import { MAX_ALIAS_LENGTH } from './webview/rules';
import { colourOf } from './viewModel';
import { SwitchSignal, WindowSync } from './windowSync';

export interface SwitchArgs {
  profileId?: string;
  /** Honoured only when the extension runs under the test runner. */
  skipConfirm?: boolean;
}

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

/** 0 means off. Claude reuses usage numbers younger than a minute, so checking more often would not help. */
function usageCheckSeconds(): number {
  const seconds = vscode.workspace.getConfiguration('claudeRoster').get<number>('usageCheckSeconds', 60);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(60, seconds) : 0;
}

function switchMode(): SwitchMode {
  const mode = vscode.workspace.getConfiguration('claudeRoster').get<string>('switchMode');
  return mode === 'newConversation' || mode === 'instant' || mode === 'restartExtensions' ? mode : 'reloadWindow';
}

/** Shown before switching in the modes that interrupt the user. */
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

/** How long after an instant switch to watch for an older conversation writing its login back. */
const WRITE_BACK_WATCH_MS = 12 * 60 * 60_000;

/**
 * The UI for every command. Questions, confirmations and messages all appear
 * inside the Claude Switch tab (see AccountsView); file and storage work
 * happens in SwitchEngine.
 */
export class RosterController implements vscode.Disposable {
  private live: LiveState = { kind: 'signed-out' };
  private lastRefresh = 0;
  private inFlight: Promise<LiveState> | undefined;
  private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private reloadPending: { alias?: string } | undefined;
  /** The Add Account sign-in running in the background, if any. */
  private signIn: { cli: ClaudeLogin; abort: AbortController; email?: string } | undefined;
  /** After an instant switch: the account switched to, and the one before it. */
  private watch: { profileId: string; alias: string; previousId?: string; until: number } | undefined;
  private switching = false;
  /** From the first question of Add Account until the new account is saved. */
  private addingAccount = false;
  private usageCheck: Promise<void> | undefined;
  private lastUsageCheck = 0;
  private usageCheckFailed = false;

  // Integration tests replace these three, since the test window must not reload or restart.
  reloadWindow: () => Thenable<unknown> = () => vscode.commands.executeCommand('workbench.action.reloadWindow');
  restartExtensions: () => Thenable<unknown> = () => vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  /** Opens a new Claude Code conversation, which starts on the account now on disk. */
  startConversation: () => Thenable<unknown> = () => vscode.commands.executeCommand('claude-vscode.newConversation');

  /** Integration tests replace this to sign in with a fake CLI. */
  createLogin: (options: ClaudeLoginOptions) => ClaudeLogin = (options) => new ClaudeLogin(options);
  /** Integration tests replace this, since the test window's fake login must never reach Anthropic. */
  askUsage: (options: UsageCheckOptions) => Promise<unknown> = askClaudeForUsage;

  constructor(
    private readonly engine: SwitchEngine,
    private readonly store: ProfileStore,
    private readonly statusBar: RosterStatusBar,
    private readonly view: AccountsView,
    private readonly log: RosterLog,
    private readonly sync: WindowSync,
    private readonly testMode: boolean,
    /** Claude Switch's own folder, where the CLI runs for usage checks. */
    private readonly storageDir: string,
  ) {
    if (testMode) {
      this.askUsage = () => Promise.reject(new Error('Usage checks are off under the test runner.'));
    }
  }

  /** Runs once per window, after activation. */
  async startup(): Promise<void> {
    const check = await this.engine.verifyLastSwitch().catch((err) => {
      this.log.warn(`Could not check the last switch: ${errorMessage(err)}`);
      return { outcome: 'none' as const };
    });
    await this.refresh();
    this.startAutoRefresh();
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
        await this.switchAccount({ profileId: check.profile.id });
      } else if (choice === 'log') {
        this.showLog();
      }
    }
  }

  async refresh(): Promise<LiveState> {
    this.inFlight ??= this.engine.refresh().finally(() => {
      this.inFlight = undefined;
    });
    try {
      this.live = await this.inFlight;
    } catch (err) {
      this.live = { kind: 'error', message: errorMessage(err) };
    }
    this.lastRefresh = Date.now();
    this.render();
    void this.checkWriteBack();
    return this.live;
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
    // 'ok' with an error: the account is right, but the tokens next to it are another account's.
    if (outcome === 'repaired' || (outcome === 'ok' && live.kind !== 'error')) {
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
      await this.switchAccount({ profileId: watch.profileId });
    }
  }

  /** Cheap re-check when the window regains focus, in case Claude signed in or refreshed. */
  refreshIfStale(): void {
    if (Date.now() - this.lastRefresh > REFRESH_THROTTLE_MS) {
      void this.refresh();
    }
  }

  /**
   * Re-reads the login and usage every claudeRoster.autoRefreshSeconds while
   * this window is focused. Local file reads only. Call again when the setting changes.
   */
  startAutoRefresh(): void {
    this.stopAutoRefresh();
    const seconds = vscode.workspace.getConfiguration('claudeRoster').get<number>('autoRefreshSeconds', 10);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    this.autoRefreshTimer = setInterval(
      () => {
        if (vscode.window.state.focused) {
          void this.refresh().then(() => this.checkUsageIfDue());
        }
      },
      Math.max(5, seconds) * 1000,
    );
  }

  /**
   * Claude Code saves usage to .claude.json only now and then, so every
   * claudeRoster.usageCheckSeconds, while the tab shows and the window is
   * focused, ask Claude for the current numbers.
   */
  checkUsageIfDue(): void {
    const seconds = usageCheckSeconds();
    if (
      seconds &&
      !this.usageCheck &&
      this.live.kind === 'known' &&
      this.view.visible &&
      vscode.window.state.focused &&
      Date.now() - this.lastUsageCheck >= seconds * 1000
    ) {
      void this.checkUsage();
    }
  }

  /** Asks Claude Code's CLI for the live account's usage now. See usageCheck.ts. */
  checkUsage(): Promise<void> {
    this.usageCheck ??= this.runUsageCheck().finally(() => {
      this.usageCheck = undefined;
    });
    return this.usageCheck;
  }

  private async runUsageCheck(): Promise<void> {
    this.lastUsageCheck = Date.now();
    const claude = resolveClaude();
    try {
      const updated = await this.engine.checkUsage(() => this.askUsage({ command: claude.command, cwd: this.storageDir }));
      this.usageCheckFailed = false;
      if (updated) {
        await this.refresh();
      }
    } catch (err) {
      // Busy: a switch is running, in this window or another. Try again next time.
      if (!(err instanceof LockBusyError) && !this.usageCheckFailed) {
        this.usageCheckFailed = true;
        this.log.warn(`Could not get the current usage from Claude, so the tab shows the numbers Claude Code last saved: ${errorMessage(err)}`);
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
    try {
      await this.switchToProfile(args.profileId, args.skipConfirm);
    } finally {
      this.switching = false;
      this.render();
    }
  }

  private async switchToProfile(profileId: string, skipConfirmInTests?: boolean): Promise<void> {
    const live = await this.refresh();
    const profile = this.store.get(profileId);
    if (!profile) {
      void this.view.notify('error', 'That account is no longer saved in Claude Switch.');
      return;
    }
    if (live.kind === 'known' && live.profile.id === profile.id) {
      void this.view.notify('info', `"${profile.alias}" is already the active Claude account.`);
      return;
    }
    if (profile.status === 'needs-relogin') {
      const choice = await this.view.confirm({
        title: `The saved login for "${profile.alias}" has expired`,
        message: 'Sign in to it again in your browser. Your current login is not affected.',
        actions: [
          { id: 'signin', label: 'Sign in again', style: 'primary' },
          { id: 'switch', label: 'Switch anyway' },
        ],
      });
      if (choice === 'signin') {
        // Not awaited: signing in takes a while, and switching should not stay blocked meanwhile.
        void this.addAccount(isValidEmail(profile.email) ? profile.email : undefined);
        return;
      } else if (choice !== 'switch') {
        return;
      }
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
      vscode.workspace.getConfiguration('claudeRoster').get<boolean>('confirmBeforeSwitch', true)
    ) {
      const choice = await this.view.confirm({
        title: `Switch Claude to "${profile.alias}"?`,
        message: RESTART_DETAIL[mode],
        actions: [{ id: 'switch', label: mode === 'reloadWindow' ? 'Switch and reload' : 'Switch and restart', style: 'primary' }],
      });
      if (choice !== 'switch') {
        return;
      }
    }

    const target = profile;
    await this.applyAndActivate(`Switching Claude to "${target.alias}"…`, async () => {
      const result = await this.engine.switchTo(target.id);
      if (result.outcome === 'already-active') {
        void this.view.notify('info', `"${target.alias}" is already the active Claude account.`);
        return undefined;
      }
      return { alias: result.profile.alias, profileId: result.profile.id };
    });
  }

  /** defaultEmail pre-fills the prompt, for signing in again to a saved account. */
  async addAccount(defaultEmail?: string): Promise<void> {
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
        await this.saveSignedInLogin(login);
      }
    } finally {
      this.addingAccount = false;
    }
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

  /** profileId comes from the tab; without it, the tab asks which account. */
  async removeAccount(profileId?: string): Promise<void> {
    const live = await this.refresh();
    const activeId = live.kind === 'known' ? live.profile.id : undefined;
    let profile: ProfileMeta | undefined;
    if (profileId) {
      profile = this.store.get(profileId);
      if (profile?.id === activeId) {
        void this.view.notify('info', "The active account can't be removed. Switch to another account first.");
        return;
      }
    } else {
      const candidates = this.store.list().filter((p) => p.id !== activeId);
      if (candidates.length === 0) {
        void this.view.notify(
          'info',
          activeId ? "The active account can't be removed. Switch to another account first." : 'No accounts are saved yet.',
        );
        return;
      }
      profile = await this.pickProfile(
        'Which account do you want to remove?',
        candidates,
        activeId ? 'The active account is not listed; switch away from it to remove it.' : undefined,
      );
    }
    if (!profile) {
      return;
    }
    const choice = await this.view.confirm({
      title: `Remove "${profile.alias}"?`,
      message: `The saved login for ${profile.email} and its backups are deleted from this device. Your Anthropic account is not affected.`,
      actions: [{ id: 'remove', label: 'Remove', style: 'danger' }],
    });
    if (choice !== 'remove') {
      return;
    }
    const now = await this.refresh();
    if (now.kind === 'known' && now.profile.id === profile.id) {
      void this.view.notify('warning', `"${profile.alias}" became the active account, so it was not removed.`);
      return;
    }
    await this.store.remove(profile.id);
    this.log.info(`Removed "${profile.alias}".`);
    await this.refresh();
    void this.view.notify('success', `Removed "${profile.alias}".`);
  }

  async recapture(): Promise<void> {
    let live: LiveState;
    try {
      live = await this.engine.recapture();
    } catch (err) {
      this.showError(err);
      return;
    }
    this.live = live;
    this.render();
    switch (live.kind) {
      case 'known':
        void this.view.notify('success', `Saved the current login into "${live.profile.alias}".`);
        break;
      case 'unknown':
        await this.saveCurrentLogin(live.login.account);
        break;
      case 'signed-out':
        void this.view.notify('warning', 'Claude Code is not signed in. Sign in with /login first.');
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
        void this.view.notify('warning', 'Claude Code is not signed in. Sign in with /login first.');
        break;
      case 'error':
        this.showError(live.message);
        break;
    }
  }

  async restoreBackup(): Promise<void> {
    const latest = this.store.listBackups()[0];
    if (!latest) {
      void this.view.notify('info', 'There is no backup yet. Claude Switch saves one before every switch.');
      return;
    }
    const from = latest.fromProfileId ? this.store.get(latest.fromProfileId)?.alias : undefined;
    const to = latest.toProfileId ? this.store.get(latest.toProfileId)?.alias : undefined;
    const choice = await this.view.confirm({
      title: 'Restore the login from before the last switch?',
      message: `Backup taken ${new Date(latest.at).toLocaleString()}, when switching from ${from ? `"${from}"` : 'an unsaved or removed login'} to ${to ? `"${to}"` : 'another account'}.`,
      actions: [{ id: 'restore', label: 'Restore', style: 'primary' }],
    });
    if (choice !== 'restore') {
      return;
    }
    await this.applyAndActivate('Restoring the Claude login backup…', async () => {
      const { profile } = await this.engine.restoreBackup(latest.slot);
      return { alias: profile?.alias, profileId: profile?.id };
    });
  }

  /** Opens the activity log page in the Claude Switch tab. */
  showLog(): void {
    this.view.openLog();
  }

  async forgetAll(): Promise<void> {
    const choice = await this.view.confirm({
      title: 'Remove all accounts and backups?',
      message: 'Every login Claude Switch saved is deleted from this device. The login Claude Code is using right now stays as it is.',
      actions: [{ id: 'remove', label: 'Remove all', style: 'danger' }],
    });
    if (choice !== 'remove') {
      return;
    }
    await this.store.clearAll();
    this.log.info('Removed all saved accounts and backups.');
    await this.refresh();
    void this.view.notify('success', 'Removed all saved accounts and backups.');
  }

  /**
   * Another window switched accounts. New Claude conversations here pick up the
   * new login on their own; only the restarting modes ask this window to reload.
   */
  async onRemoteSwitch(signal: SwitchSignal): Promise<void> {
    // The user chose another account on purpose; this window's watch no longer applies.
    this.watch = undefined;
    const mode = switchMode();
    if (mode === 'restartExtensions' || mode === 'reloadWindow') {
      this.reloadPending = { alias: signal.alias };
    }
    await this.refresh();
    if (!this.reloadPending) {
      void this.view.notify(
        'info',
        `Switched to ${signal.alias ? `"${signal.alias}"` : 'another account'} in another window. New Claude conversations here use it too.`,
      );
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.signIn?.cli.cancel();
  }

  private render(): void {
    this.statusBar.update(this.live, this.reloadPending);
    const signIn = this.signIn && { email: this.signIn.email, url: this.signIn.cli.url };
    this.view.update(this.live, this.reloadPending, signIn, this.switching);
  }

  /** Swaps the login, then makes Claude Code use it as claudeRoster.switchMode says. */
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
      await (mode === 'reloadWindow' ? this.reloadWindow() : this.restartExtensions());
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
    void vscode.commands.executeCommand('setContext', 'claudeRoster.signingIn', true);
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
      void vscode.commands.executeCommand('setContext', 'claudeRoster.signingIn', false);
      this.render();
      await this.cleanUpLoginDir(dir);
    }

    if (failure) {
      this.log.error(`Add Account: ${failure}`);
      const choice = await this.view.notify('error', failure, [
        { id: 'terminal', label: 'Sign in in a terminal' },
        { id: 'log', label: 'Show log' },
      ]);
      if (choice === 'terminal') {
        return this.signInInTerminal(claude.command);
      } else if (choice === 'log') {
        this.showLog();
      }
    }
    return login;
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
      // null removes the variable, so an API key in the environment can't replace the sign-in.
      env: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null },
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

  private async saveSignedInLogin(login: SavedLogin): Promise<void> {
    const email = login.account.emailAddress;
    const existing = this.store.findByAccount(login.account);
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
        .then((choice) => (choice === 'switch' ? this.switchAccount({ profileId: profile.id }) : undefined));
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
      void this.view.notify('success', `Updated the saved login for "${existing.alias}".`);
      return;
    }
    // The account is the active one, so Claude still holds the old tokens until they are replaced.
    const apply = await this.view.confirm({
      title: `"${existing.alias}" is the active account`,
      message: 'Use the new sign-in now?',
      actions: [{ id: 'apply', label: 'Use now', style: 'primary' }],
    });
    if (apply === 'apply') {
      await this.applyAndActivate(`Applying the new sign-in for "${existing.alias}"…`, async () => {
        const result = await this.engine.switchTo(existing.id, { replaceLive: true });
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

  private showError(err: unknown): void {
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
 * The Claude CLI used to sign in: the claudeRoster.claudePath setting, else the
 * CLI bundled with the Claude Code extension (the same version that will use
 * the login), else `claude` on PATH.
 */
function resolveClaude(): { command: string; source: string } {
  // Machine-scoped, so a workspace's settings can never choose what runs here.
  const configured = vscode.workspace.getConfiguration('claudeRoster').get<string>('claudePath')?.trim();
  if (configured) {
    return { command: configured, source: 'the claudeRoster.claudePath setting' };
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

