import * as vscode from 'vscode';
import { LiveState } from './switchEngine';

export class RosterStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('claudeRoster.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Claude Switch';
    this.item.show();
  }

  get text(): string {
    return this.item.text;
  }

  /** reloadPending: another window switched accounts and this one still runs the old login. */
  update(live: LiveState, reloadPending?: { alias?: string }): void {
    this.item.command = 'claudeRoster.switch';
    this.item.backgroundColor = undefined;

    if (reloadPending) {
      this.item.text = `$(refresh) Reload for ${plain(reloadPending.alias ?? 'new account')}`;
      this.item.tooltip = 'The Claude account was switched in another window. Click to reload this window so Claude Code uses it.';
      this.item.command = 'workbench.action.reloadWindow';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    switch (live.kind) {
      case 'known': {
        const { alias, email, status, plan, usage } = live.profile;
        const expired = status === 'needs-relogin';
        const usageLine = [
          usage?.session ? `session ${Math.round(usage.session.percent)}%` : undefined,
          usage?.weekly ? `this week ${Math.round(usage.weekly.percent)}%` : undefined,
        ].filter(Boolean);
        this.item.text = `$(${expired ? 'warning' : 'account'}) ${plain(alias)}`;
        this.item.tooltip = [
          `Claude account: ${alias} (${email})${plan ? `, ${plan.label}` : ''}`,
          usageLine.length ? `Usage: ${usageLine.join(', ')}` : undefined,
          expired ? 'This login has expired. Run /login in Claude Code to sign in again.' : undefined,
          'Click to switch accounts.',
        ]
          .filter(Boolean)
          .join('\n');
        break;
      }
      case 'unknown':
        this.item.text = '$(account) Unsaved account';
        this.item.tooltip = `Claude is signed in as ${live.login.account.emailAddress}, which isn't saved in Claude Switch.\nClick to save it or switch accounts.`;
        break;
      case 'signed-out':
        this.item.text = '$(account) Claude: signed out';
        this.item.tooltip = 'Claude Code is not signed in. Click to switch to a saved account or add one.';
        break;
      case 'error':
        this.item.text = '$(error) Claude Switch';
        this.item.tooltip = `${live.message}\nClick for options.`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Keeps a user-chosen alias from being read as a $(icon) reference. */
function plain(text: string): string {
  return text.replace(/\$\(/g, '$​(');
}
