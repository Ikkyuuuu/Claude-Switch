import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isDateString, nextRenewal } from './accountDetails';
import { AccountsView } from './accountsView';
import { ClaudeLogin, ClaudeLoginOptions, createLoginDir, isValidEmail, removeLoginDir, waitForLogin } from './addAccount';
import { delay, identityOf, OAuthAccount, SavedLogin } from './claudeFiles';
import { errorMessage } from './log';
import { ProfileMeta, ProfileStore } from './profileStore';
import { RosterLog } from './rosterLog';
import { RosterStatusBar } from './statusBar';
import { LiveState, SwitchEngine } from './switchEngine';
import { SwitchSignal, WindowSync } from './windowSync';

export interface SwitchArgs {
  profileId?: string;
  /** Honoured only when the extension runs under the test runner. */
  skipConfirm?: boolean;
}

const MAX_ALIAS_LENGTH = 40;
const BILLING_URL = 'https://claude.ai/settings/billing';
const REFRESH_THROTTLE_MS = 30_000;

const SWITCH_DETAIL = [
  'This window reloads, and any Claude task running in it stops.',
  'Exit claude sessions running in terminals first: they keep the old account until restarted, and can write it back.',
  'Other open VS Code windows will offer to reload.',
].join('\n\n');

type PickAction = 'add' | 'save' | 'reload' | 'log';

/** The UI for every command. File and storage work happens in SwitchEngine. */
export class RosterController implements vscode.Disposable {
  private live: LiveState = { kind: 'signed-out' };
  private lastRefresh = 0;
  private inFlight: Promise<LiveState> | undefined;
  private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private reloadPending: { alias?: string } | undefined;
  /** The Add Account sign-in running in the background, if any. */
  private signIn: { cli: ClaudeLogin; abort: AbortController; email?: string } | undefined;
  /** Logins already offered for saving in this window, so the offer is not repeated. */
  private readonly offered = new Set<string>();

  /** Integration tests replace this, since the test window must not reload. */
  reloadWindow: () => Thenable<unknown> = () => vscode.commands.executeCommand('workbench.action.reloadWindow');

  /** Integration tests replace this to sign in with a fake CLI. */
  createLogin: (options: ClaudeLoginOptions) => ClaudeLogin = (options) => new ClaudeLogin(options);

  constructor(
    private readonly engine: SwitchEngine,
    private readonly store: ProfileStore,
    private readonly statusBar: RosterStatusBar,
    private readonly view: AccountsView,
    private readonly log: RosterLog,
    private readonly sync: WindowSync,
    private readonly testMode: boolean,
  ) {}

  /** Runs once per window, after activation. */
  async startup(): Promise<void> {
    const check = await this.engine.verifyLastSwitch().catch((err) => {
      this.log.warn(`Could not check the last switch: ${errorMessage(err)}`);
      return { outcome: 'none' as const };
    });
    await this.refresh({ offerToSave: true });
    this.startAutoRefresh();
    if (check.outcome === 'mismatch') {
      const choice = await vscode.window.showWarningMessage(
        `The switch to "${check.profile.alias}" did not stick: another Claude process changed the login while this window reloaded. Exit running claude sessions, then switch again.`,
        'Switch Again',
        'Show Log',
      );
      if (choice === 'Switch Again') {
        await this.switchAccount({ profileId: check.profile.id });
      } else if (choice === 'Show Log') {
        this.showLog();
      }
    }
  }

  async refresh(options: { offerToSave?: boolean } = {}): Promise<LiveState> {
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
    if (options.offerToSave && this.live.kind === 'unknown') {
      void this.offerToSave(this.live.login.account);
    }
    return this.live;
  }

  /** Cheap re-check when the window regains focus, in case Claude signed in or refreshed. */
  refreshIfStale(): void {
    if (Date.now() - this.lastRefresh > REFRESH_THROTTLE_MS) {
      void this.refresh({ offerToSave: true });
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
          void this.refresh();
        }
      },
      Math.max(5, seconds) * 1000,
    );
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  async switchAccount(args: SwitchArgs = {}): Promise<void> {
    const live = await this.refresh();
    let profile: ProfileMeta | undefined;
    if (args.profileId) {
      profile = this.store.get(args.profileId);
      if (!profile) {
        void vscode.window.showErrorMessage('That account is no longer saved in Claude Switch.');
        return;
      }
    } else {
      const picked = await this.pickForSwitch(live);
      if (picked === 'add') {
        return this.addAccount();
      } else if (picked === 'save' && live.kind === 'unknown') {
        await this.saveCurrentLogin(live.login.account);
        return;
      } else if (picked === 'reload') {
        await this.reloadWindow();
        return;
      } else if (picked === 'log') {
        this.showLog();
        return;
      } else if (typeof picked !== 'object') {
        return;
      }
      profile = picked;
    }

    if (live.kind === 'known' && live.profile.id === profile.id) {
      void vscode.window.showInformationMessage(`"${profile.alias}" is already the active Claude account.`);
      return;
    }
    if (profile.status === 'needs-relogin') {
      const choice = await vscode.window.showWarningMessage(
        `The saved login for "${profile.alias}" has expired.`,
        { modal: true, detail: 'Sign in to it again in your browser. Your current login is not affected.' },
        'Sign In Again',
        'Switch Anyway',
      );
      if (choice === 'Sign In Again') {
        return this.addAccount(isValidEmail(profile.email) ? profile.email : undefined);
      } else if (choice !== 'Switch Anyway') {
        return;
      }
    }
    if (live.kind === 'unknown') {
      const choice = await vscode.window.showWarningMessage(
        'Save the current login before switching?',
        {
          modal: true,
          detail: `Claude is signed in as ${live.login.account.emailAddress}, which isn't saved in Claude Switch. Save it to be able to switch back. A backup is kept either way.`,
        },
        'Save and Switch',
        'Switch Without Saving',
      );
      if (choice === undefined) {
        return;
      }
      if (choice === 'Save and Switch' && !(await this.saveCurrentLogin(live.login.account))) {
        return;
      }
    }
    const skipConfirm = this.testMode && args.skipConfirm;
    if (!skipConfirm && vscode.workspace.getConfiguration('claudeRoster').get<boolean>('confirmBeforeSwitch', true)) {
      const choice = await vscode.window.showWarningMessage(
        `Switch Claude to "${profile.alias}"?`,
        { modal: true, detail: SWITCH_DETAIL },
        'Switch and Reload',
      );
      if (choice !== 'Switch and Reload') {
        return;
      }
    }

    const target = profile;
    await this.applyAndReload(`Switching Claude to "${target.alias}"…`, async () => {
      const result = await this.engine.switchTo(target.id);
      if (result.outcome === 'already-active') {
        void vscode.window.showInformationMessage(`"${target.alias}" is already the active Claude account.`);
        return undefined;
      }
      return { alias: result.profile.alias };
    });
  }

  /** defaultEmail pre-fills the prompt, for signing in again to a saved account. */
  async addAccount(defaultEmail?: string): Promise<void> {
    if (this.signIn) {
      void vscode.commands.executeCommand('claudeRoster.accounts.focus');
      void vscode.window.showInformationMessage('A sign-in is already in progress in the Claude Switch tab.');
      return;
    }
    const email = await vscode.window.showInputBox({
      title: 'Claude Switch: Add Account',
      prompt: 'Email of the account to add. Optional: it pre-fills the sign-in page. Press Enter to skip.',
      placeHolder: 'name@example.com',
      value: defaultEmail,
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value.trim() || isValidEmail(value.trim()) ? undefined : 'Enter a valid email address, or leave it empty.',
    });
    if (email === undefined) {
      return;
    }
    const login = await this.signInInBackground(email.trim() || undefined);
    if (login) {
      await this.saveSignedInLogin(login);
    }
  }

  /** "Open sign-in page" in the Accounts view. */
  async signInOpenPage(): Promise<void> {
    const url = this.signIn?.cli.url;
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  /** "Copy sign-in link" in the Accounts view. */
  async signInCopyLink(): Promise<void> {
    const url = this.signIn?.cli.url;
    if (url) {
      await vscode.env.clipboard.writeText(url);
      void vscode.window.showInformationMessage(
        'Sign-in link copied. Open it in a private window, or a browser signed in to the account to add.',
      );
    }
  }

  /** "Paste code…" in the Accounts view, for when the sign-in page shows a code instead of finishing. */
  async signInPasteCode(): Promise<void> {
    const signIn = this.signIn;
    if (!signIn) {
      return;
    }
    const code = await vscode.window.showInputBox({
      title: 'Claude Switch: Paste Code',
      prompt: 'Paste the code the sign-in page shows after you approve access.',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Paste the code from the sign-in page.'),
    });
    if (code && this.signIn === signIn) {
      this.signInSendCode(code);
    }
  }

  /** Sends the code from the sign-in page, typed into the Accounts view or the prompt above. */
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

  /** profileId comes from a row in the Accounts view; without it, a picker opens. */
  async renameAccount(profileId?: string): Promise<void> {
    const profile = profileId ? this.store.get(profileId) : await this.pickProfile('Select the account to rename');
    if (!profile) {
      return;
    }
    const alias = await this.promptAlias(`New name for ${profile.email}`, profile.alias, profile.id);
    if (!alias || alias === profile.alias) {
      return;
    }
    await this.store.rename(profile.id, alias);
    this.log.info(`Renamed "${profile.alias}" to "${alias}".`);
    await this.refresh();
  }

  /** profileId comes from a row in the Accounts view; without it, a picker opens. */
  async removeAccount(profileId?: string): Promise<void> {
    const live = await this.refresh();
    const activeId = live.kind === 'known' ? live.profile.id : undefined;
    let profile: ProfileMeta | undefined;
    if (profileId) {
      profile = this.store.get(profileId);
      if (profile?.id === activeId) {
        void vscode.window.showInformationMessage("The active account can't be removed. Switch to another account first.");
        return;
      }
    } else {
      const candidates = this.store.list().filter((p) => p.id !== activeId);
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage(
          activeId ? "The active account can't be removed. Switch to another account first." : 'No accounts are saved yet.',
        );
        return;
      }
      profile = await this.pickProfile(
        activeId ? 'Select the account to remove (the active account is not listed)' : 'Select the account to remove',
        candidates,
      );
    }
    if (!profile) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Remove "${profile.alias}" from Claude Switch?`,
      {
        modal: true,
        detail: `The saved login for ${profile.email} and its backups are deleted from this device. Your Anthropic account is not affected.`,
      },
      'Remove',
    );
    if (choice !== 'Remove') {
      return;
    }
    const now = await this.refresh();
    if (now.kind === 'known' && now.profile.id === profile.id) {
      void vscode.window.showWarningMessage(`"${profile.alias}" became the active account, so it was not removed.`);
      return;
    }
    await this.store.remove(profile.id);
    this.log.info(`Removed "${profile.alias}".`);
    await this.refresh();
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
        void vscode.window.showInformationMessage(`Saved the current login into "${live.profile.alias}".`);
        break;
      case 'unknown':
        await this.saveCurrentLogin(live.login.account);
        break;
      case 'signed-out':
        void vscode.window.showWarningMessage('Claude Code is not signed in. Sign in with /login first.');
        break;
      case 'error':
        this.showError(live.message);
        break;
    }
  }

  /** Lets the user replace the estimated renewal date with the real one. */
  async setRenewal(profileId?: string): Promise<void> {
    const profile = profileId ? this.store.get(profileId) : await this.pickProfile('Select the account to set a renewal date for');
    if (!profile) {
      return;
    }
    const shown = nextRenewal(profile.plan, profile.renewal, Date.now());
    const date = await vscode.window.showInputBox({
      title: `Claude Switch: Renewal Date for ${profile.alias}`,
      prompt: profile.renewal
        ? 'Next renewal date (YYYY-MM-DD). Leave empty to go back to the estimate.'
        : 'Next renewal date (YYYY-MM-DD), as shown on the claude.ai billing page.',
      value: shown?.date ?? '',
      placeHolder: 'YYYY-MM-DD',
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value.trim() || isDateString(value.trim()) ? undefined : 'Enter a real date as YYYY-MM-DD, for example 2026-11-14.',
    });
    if (date === undefined) {
      return;
    }
    if (!date.trim()) {
      await this.store.setRenewal(profile.id, undefined);
      this.log.info(`Cleared the renewal date for "${profile.alias}".`);
      await this.refresh();
      return;
    }
    const cycle = await vscode.window.showQuickPick(
      [
        { label: 'Monthly', value: 'monthly' as const },
        { label: 'Yearly', value: 'yearly' as const },
      ],
      { title: 'Claude Switch: Billing Cycle', placeHolder: 'How often does this subscription renew?' },
    );
    if (!cycle) {
      return;
    }
    await this.store.setRenewal(profile.id, { date: date.trim(), cycle: cycle.value });
    this.log.info(`Set a ${cycle.value} renewal date for "${profile.alias}".`);
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
        void vscode.window.showInformationMessage(`The current login is already saved as "${live.profile.alias}".`);
        break;
      case 'signed-out':
        void vscode.window.showWarningMessage('Claude Code is not signed in. Sign in with /login first.');
        break;
      case 'error':
        this.showError(live.message);
        break;
    }
  }

  async restoreBackup(): Promise<void> {
    const latest = this.store.listBackups()[0];
    if (!latest) {
      void vscode.window.showInformationMessage('There is no backup yet. Claude Switch saves one before every switch.');
      return;
    }
    const from = latest.fromProfileId ? this.store.get(latest.fromProfileId)?.alias : undefined;
    const to = latest.toProfileId ? this.store.get(latest.toProfileId)?.alias : undefined;
    const choice = await vscode.window.showWarningMessage(
      'Restore the login from before the last switch?',
      {
        modal: true,
        detail: `Backup taken ${new Date(latest.at).toLocaleString()}, when switching from ${from ? `"${from}"` : 'an unsaved or removed login'} to ${to ? `"${to}"` : 'another account'}. This window will reload.`,
      },
      'Restore and Reload',
    );
    if (choice !== 'Restore and Reload') {
      return;
    }
    await this.applyAndReload('Restoring the Claude login backup…', async () => {
      const { profile } = await this.engine.restoreBackup(latest.slot);
      return { alias: profile?.alias };
    });
  }

  /** Opens the activity log page in the Claude Switch tab. */
  showLog(): void {
    this.view.openLog();
  }

  async forgetAll(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Remove all accounts and backups saved by Claude Switch?',
      {
        modal: true,
        detail: 'Every saved login is deleted from this device. The login Claude Code is using right now stays as it is.',
      },
      'Remove All',
    );
    if (choice !== 'Remove All') {
      return;
    }
    await this.store.clearAll();
    this.offered.clear();
    this.log.info('Removed all saved accounts and backups.');
    await this.refresh();
  }

  /** Another window switched accounts: this window's Claude still runs the old login. */
  async onRemoteSwitch(signal: SwitchSignal): Promise<void> {
    this.reloadPending = { alias: signal.alias };
    await this.refresh();
    const choice = await vscode.window.showInformationMessage(
      `The Claude account was switched${signal.alias ? ` to "${signal.alias}"` : ''} in another window. Reload this window so Claude Code uses it?`,
      'Reload Now',
      'Later',
    );
    if (choice === 'Reload Now') {
      await this.reloadWindow();
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.signIn?.cli.cancel();
    this.offered.clear();
  }

  private render(): void {
    this.statusBar.update(this.live, this.reloadPending);
    const signIn = this.signIn && { email: this.signIn.email, url: this.signIn.cli.url };
    this.view.update(this.live, this.reloadPending, signIn);
  }

  private async applyAndReload(title: string, apply: () => Promise<{ alias?: string } | undefined>): Promise<void> {
    let applied: { alias?: string } | undefined;
    try {
      applied = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, apply);
    } catch (err) {
      await this.refresh();
      this.showError(err);
      return;
    }
    if (!applied) {
      return;
    }
    this.reloadPending = undefined;
    await this.refresh();
    await this.sync.publish(applied.alias).catch((err) => {
      this.log.warn(`Could not notify other windows: ${errorMessage(err)}`);
    });
    await this.reloadWindow();
  }

  /**
   * Runs `claude auth login` hidden, with its own CLAUDE_CONFIG_DIR, so the live
   * login is never touched. Progress and fallbacks show in the Accounts view.
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
    void vscode.commands.executeCommand('claudeRoster.accounts.focus');
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
      login = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Claude Switch', cancellable: true },
        (progress, token) => {
          progress.report({
            message: 'Finish signing in in your browser. The Claude Switch tab can reopen the page or take a code.',
          });
          token.onCancellationRequested(() => abort.abort());
          return waitForLogin(dir, { signal: abort.signal, intervalMs: 1000 });
        },
      );
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
      const choice = await vscode.window.showErrorMessage(failure, 'Sign In in Terminal', 'Show Log');
      if (choice === 'Sign In in Terminal') {
        return this.signInInTerminal(claude.command);
      } else if (choice === 'Show Log') {
        this.showLog();
      }
    }
    return login;
  }

  /**
   * Fallback: runs the Claude CLI itself as a terminal, with its own
   * CLAUDE_CONFIG_DIR, for when the background sign-in does not work.
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
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Claude Switch', cancellable: true },
        (progress, token) => {
          progress.report({
            message: 'Sign in with the account to add in the terminal. If Claude does not ask you to, type /login.',
          });
          token.onCancellationRequested(() => abort.abort());
          return waitForLogin(dir, { signal: abort.signal });
        },
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
      void vscode.window.showWarningMessage(
        `Claude Switch could not delete its temporary sign-in folder, which contains login tokens. Delete it manually: ${dir}`,
      );
    }
  }

  private async saveSignedInLogin(login: SavedLogin): Promise<void> {
    const email = login.account.emailAddress;
    const existing = this.store.findByAccount(login.account);
    if (!existing) {
      const alias = await this.promptAlias(`Name for ${email}`, this.suggestAlias(login.account));
      if (!alias) {
        return;
      }
      const profile = await this.store.add(alias, login);
      this.log.info(`Added "${profile.alias}".`);
      await this.refresh();
      const choice = await vscode.window.showInformationMessage(`Added "${profile.alias}" (${email}).`, 'Switch Now');
      if (choice === 'Switch Now') {
        await this.switchAccount({ profileId: profile.id });
      }
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `${email} is already saved as "${existing.alias}". Replace its saved login with this sign-in?`,
      {
        modal: true,
        detail:
          'Meant to add a different account? Your browser is probably signed in to this one. Sign out of claude.ai there, or use "Copy sign-in link" in a private window, and add the account again.',
      },
      'Replace',
    );
    if (choice !== 'Replace') {
      return;
    }
    await this.store.updateLogin(existing.id, login);
    this.log.info(`Replaced the saved login for "${existing.alias}".`);
    const live = await this.refresh();
    if (live.kind !== 'known' || live.profile.id !== existing.id) {
      void vscode.window.showInformationMessage(`Updated the saved login for "${existing.alias}".`);
      return;
    }
    // The account is the active one, so Claude still holds the old tokens until they are replaced.
    const apply = await vscode.window.showInformationMessage(
      `"${existing.alias}" is the active account. Use the new sign-in now? This window will reload.`,
      'Use Now',
    );
    if (apply === 'Use Now') {
      await this.applyAndReload(`Applying the new sign-in for "${existing.alias}"…`, async () => {
        const result = await this.engine.switchTo(existing.id, { replaceLive: true });
        return { alias: result.profile.alias };
      });
    }
  }

  private async offerToSave(account: OAuthAccount): Promise<void> {
    const identity = identityOf(account);
    if (this.store.isDismissed(identity) || this.offered.has(identity)) {
      return;
    }
    this.offered.add(identity);
    const message =
      this.store.list().length === 0
        ? `Claude Switch found a Claude login (${account.emailAddress}). Save it as your first account?`
        : `Claude is signed in as ${account.emailAddress}, which isn't saved in Claude Switch. Save it?`;
    const choice = await vscode.window.showInformationMessage(message, 'Save…', "Don't Ask Again");
    if (choice === "Don't Ask Again") {
      await this.store.dismiss(identity);
    } else if (choice === 'Save…') {
      await this.saveCurrentLogin(account);
    }
  }

  private async saveCurrentLogin(account: OAuthAccount): Promise<ProfileMeta | undefined> {
    const alias = await this.promptAlias(`Name for ${account.emailAddress}`, this.suggestAlias(account));
    if (!alias) {
      return undefined;
    }
    try {
      const profile = await this.engine.saveCurrent(alias, identityOf(account));
      await this.refresh();
      void vscode.window.showInformationMessage(`Saved the current login as "${profile.alias}".`);
      return profile;
    } catch (err) {
      this.showError(err);
      return undefined;
    }
  }

  private async pickForSwitch(live: LiveState): Promise<ProfileMeta | PickAction | undefined> {
    type Item = vscode.QuickPickItem & { profile?: ProfileMeta; action?: PickAction };
    const activeId = live.kind === 'known' ? live.profile.id : undefined;
    const items: Item[] = [];
    if (this.reloadPending) {
      items.push({
        label: '$(refresh) Reload Window',
        detail: 'The account was switched in another window. Reload so Claude Code uses it here.',
        action: 'reload',
      });
    }
    for (const profile of this.store.list()) {
      const active = profile.id === activeId;
      const expired = profile.status === 'needs-relogin';
      const markers = [active ? 'Active' : undefined, expired ? 'Needs re-login' : undefined].filter(Boolean);
      items.push({
        label: `${active ? '$(check)' : expired ? '$(warning)' : '$(account)'} ${profile.alias}`,
        description: profile.email,
        detail: markers.length ? markers.join(' · ') : undefined,
        profile,
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    if (live.kind === 'unknown') {
      items.push({ label: '$(save) Save Current Login…', description: live.login.account.emailAddress, action: 'save' });
    }
    items.push({ label: '$(add) Add Account…', description: 'Sign in to another account in your browser', action: 'add' });
    if (live.kind === 'error') {
      items.push({ label: '$(output) Show Log', description: live.message, action: 'log' });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Claude Switch',
      placeHolder: 'Select the Claude account to use',
      matchOnDescription: true,
    });
    return picked?.profile ?? picked?.action;
  }

  private async pickProfile(placeHolder: string, profiles = this.store.list()): Promise<ProfileMeta | undefined> {
    if (profiles.length === 0) {
      void vscode.window.showInformationMessage('No accounts are saved yet. Use "Claude Switch: Add Account" first.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({ label: profile.alias, description: profile.email, profile })),
      { title: 'Claude Switch', placeHolder, matchOnDescription: true },
    );
    return picked?.profile;
  }

  private async promptAlias(prompt: string, value: string, excludeId?: string): Promise<string | undefined> {
    const taken = new Set(
      this.store
        .list()
        .filter((p) => p.id !== excludeId)
        .map((p) => p.alias.toLowerCase()),
    );
    const alias = await vscode.window.showInputBox({
      title: 'Claude Switch',
      prompt,
      value,
      validateInput: (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          return 'Enter a name, such as Work or Personal.';
        }
        if (trimmed.length > MAX_ALIAS_LENGTH) {
          return `Use at most ${MAX_ALIAS_LENGTH} characters.`;
        }
        if (taken.has(trimmed.toLowerCase())) {
          return 'Another saved account already uses this name.';
        }
        return undefined;
      },
    });
    return alias?.trim() || undefined;
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
    void vscode.window.showErrorMessage(message, 'Show Log').then((choice) => {
      if (choice) {
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
  return { command: 'claude', source: 'PATH' };
}
