import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ProfileStore } from './profileStore';
import { RosterLog } from './rosterLog';
import { LiveState } from './switchEngine';
import { buildViewState, parseMessage, SignInState, unsupportedState } from './viewModel';
import type { HostMessage, RosterViewState, WebviewMessage } from './webview/protocol';

export type { SignInState };

/**
 * The Accounts view in the Claude Switch activity bar tab: a webview drawn by
 * src/webview/main.ts and styled by media/roster.css.
 */
export class AccountsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'claudeRoster.accounts';

  private view: vscode.WebviewView | undefined;
  private current: RosterViewState;
  private badge: vscode.ViewBadge | undefined;
  private description: string | undefined;
  private readonly shown = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** The webview's script has loaded and can receive messages. */
  private ready = false;
  private lastPosted = '';
  /** "Show Log" was asked for before the webview was ready. */
  private logRequested = false;
  private logTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stopWatchingLog: () => void;

  /** Fires whenever the view becomes visible, so a stale list can be refreshed. */
  readonly onDidBecomeVisible = this.shown.event;

  /** store is undefined on platforms Claude Switch does not support. */
  constructor(
    private readonly store: ProfileStore | undefined,
    private readonly log: RosterLog,
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: WebviewMessage) => void,
  ) {
    this.current = store
      ? buildViewState({ profiles: store.list(), live: { kind: 'signed-out' }, hasBackup: false })
      : unsupportedState();
    // Several entries often arrive together; send them in one message.
    this.stopWatchingLog = log.onDidChange(() => {
      this.logTimer ??= setTimeout(() => {
        this.logTimer = undefined;
        this.postLog();
      }, 100);
    });
  }

  /** Shows the activity log page in the tab, opening the tab first if needed. */
  openLog(): void {
    this.logRequested = true;
    void vscode.commands.executeCommand(`${AccountsView.id}.focus`);
    this.flushLogRequest();
  }

  /** What the webview currently shows. */
  get state(): RosterViewState {
    return this.current;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = this.html(view.webview);
    view.badge = this.badge;
    view.description = this.description;
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((raw) => this.receive(raw)),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.shown.fire();
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
      }),
    );
  }

  /** Handles a message from the webview. Anything unexpected is ignored. */
  receive(raw: unknown): void {
    const message = parseMessage(raw);
    if (!message) {
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      this.post(true);
      this.postLog();
      this.flushLogRequest();
      this.shown.fire();
      return;
    }
    this.onMessage(message);
  }

  update(live: LiveState, reloadPending?: { alias?: string }, signIn?: SignInState): void {
    if (!this.store) {
      return;
    }
    const profiles = this.store.list();
    this.current = buildViewState({
      profiles,
      live,
      reloadPending,
      signIn,
      hasBackup: this.store.listBackups().length > 0,
    });

    this.description = live.kind === 'known' ? live.profile.alias : undefined;
    const expired = profiles.filter((p) => p.status === 'needs-relogin').length;
    const reasons = [
      reloadPending ? 'reload this window to use the new account' : undefined,
      expired ? `${expired} account${expired === 1 ? '' : 's'} need${expired === 1 ? 's' : ''} a new sign-in` : undefined,
    ].filter((reason): reason is string => !!reason);
    this.badge = reasons.length
      ? { value: expired + (reloadPending ? 1 : 0), tooltip: `Claude Switch: ${reasons.join('; ')}` }
      : undefined;

    if (this.view) {
      this.view.description = this.description;
      this.view.badge = this.badge;
    }
    this.post();
  }

  dispose(): void {
    this.stopWatchingLog();
    if (this.logTimer) {
      clearTimeout(this.logTimer);
    }
    this.shown.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  /** Sends the state, unless the webview already shows exactly this (auto-refresh repeats often). */
  private post(force = false): void {
    const json = JSON.stringify(this.current);
    if (!force && json === this.lastPosted) {
      return;
    }
    this.lastPosted = json;
    this.send({ type: 'state', state: this.current });
  }

  private postLog(): void {
    this.send({ type: 'log', entries: this.log.entries });
  }

  private flushLogRequest(): void {
    if (this.logRequested && this.view && this.ready) {
      this.logRequested = false;
      this.send({ type: 'openLog' });
    }
  }

  private send(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const asset = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...segments));
    // Nothing loads from outside the extension, and only the bundled script runs.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'roster.css')}">
  <title>Claude Switch</title>
</head>
<body>
  <div id="app" data-logo="${asset('media', 'logo.svg')}"></div>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
  }
}
