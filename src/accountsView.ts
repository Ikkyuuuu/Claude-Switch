import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ProfileStore } from './profileStore';
import { RosterLog } from './rosterLog';
import { LiveState } from './switchEngine';
import { buildViewState, parseMessage, SignInState, unsupportedState } from './viewModel';
import type { HostMessage, Notice, PromptAction, PromptSpec, RosterViewState, WebviewMessage } from './webview/protocol';
import { isAvatarColour } from './webview/avatar';
import { checkInput } from './webview/rules';

export type { SignInState };

type Without<T, K extends keyof T> = Omit<T, K>;
export type InputOptions = Without<Extract<PromptSpec, { kind: 'input' }>, 'kind' | 'id'>;
export type ConfirmOptions = Without<Extract<PromptSpec, { kind: 'confirm' }>, 'kind' | 'id'>;
export type ChoiceOptions = Without<Extract<PromptSpec, { kind: 'choice' }>, 'kind' | 'id'>;
export type ProfileOptions = Without<Extract<PromptSpec, { kind: 'profile' }>, 'kind' | 'id'>;

interface Answer {
  value?: string;
  action?: string;
  color?: number;
}

interface PendingPrompt {
  spec: PromptSpec;
  resolve: (answer: Answer | undefined) => void;
}

/** How long success and info notices stay; warnings and errors stay until dismissed. */
const NOTICE_MS = 6_000;
const NOTICE_WITH_ACTIONS_MS = 15_000;
const MAX_NOTICES = 4;

/**
 * The Accounts view in the Claude Switch activity bar tab: a webview drawn by
 * src/webview/main.ts and styled by media/roster.css.
 */
export class AccountsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'claudeRoster.accounts';

  private view: vscode.WebviewView | undefined;
  private current: RosterViewState;
  /** False until the controller's first update: before it, the tab shows its loading screen. */
  private loaded: boolean;
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
  /** Dialogs waiting for an answer; the first one is on screen. */
  private readonly prompts: PendingPrompt[] = [];
  private notices: Notice[] = [];
  private readonly noticeResolvers = new Map<string, (action?: string) => void>();
  /** Tasks showing a progress banner; the latest one's text shows. */
  private busyTasks: { text: string }[] = [];
  private nextId = 0;

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
    this.loaded = !store;
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

  /** The dialog on screen, if any. */
  get currentPrompt(): PromptSpec | undefined {
    return this.prompts[0]?.spec;
  }

  /** Whether the tab is open and showing. */
  get visible(): boolean {
    return !!this.view?.visible;
  }

  get currentNotices(): Notice[] {
    return [...this.notices];
  }

  /** Opens the Claude Switch tab. */
  reveal(): void {
    void vscode.commands.executeCommand(`${AccountsView.id}.focus`);
  }

  // ------------------------------------------------------------ in-tab UI
  // Everything the user is asked or told appears inside the tab, in place of
  // VS Code's input boxes, pickers, modal dialogs and notifications.

  /** Asks for text. Resolves to the trimmed answer ('' when optional and left empty), or undefined if cancelled. */
  async input(options: InputOptions): Promise<string | undefined> {
    return (await this.ask({ kind: 'input', id: this.newId(), ...options }))?.value;
  }

  /** Asks the user to pick one of the actions. Resolves to its id, or undefined if cancelled. */
  async confirm(options: ConfirmOptions): Promise<string | undefined> {
    return (await this.ask({ kind: 'confirm', id: this.newId(), ...options }))?.action;
  }

  /** Asks the user to pick from a list. Resolves to the option's id, or undefined if cancelled. */
  async choose(options: ChoiceOptions): Promise<string | undefined> {
    return (await this.ask({ kind: 'choice', id: this.newId(), ...options }))?.action;
  }

  /** Asks for an account's name and avatar colour. Resolves to both, or undefined if cancelled. */
  async editProfile(options: ProfileOptions): Promise<{ alias: string; color: number } | undefined> {
    const answer = await this.ask({ kind: 'profile', id: this.newId(), ...options });
    return answer?.value !== undefined && answer.color !== undefined ? { alias: answer.value, color: answer.color } : undefined;
  }

  /**
   * Shows a notice at the bottom of the tab. Resolves to the id of the button the
   * user clicked, or undefined when it is dismissed or times out.
   */
  notify(level: Notice['level'], text: string, actions: PromptAction[] = []): Promise<string | undefined> {
    const notice: Notice = { id: this.newId(), level, text, actions };
    // The same message again, say from repeated clicks, replaces the one showing rather than stacking.
    for (const same of this.notices.filter((n) => n.level === level && n.text === text)) {
      this.closeNotice(same.id);
    }
    for (const dropped of this.notices.slice(0, Math.max(0, this.notices.length + 1 - MAX_NOTICES))) {
      this.closeNotice(dropped.id);
    }
    this.notices = [...this.notices, notice];
    this.sendNotices();
    if (level === 'warning' || level === 'error') {
      this.reveal();
    }
    return new Promise((resolve) => {
      this.noticeResolvers.set(notice.id, resolve);
      if (level === 'info' || level === 'success') {
        setTimeout(() => this.closeNotice(notice.id), actions.length ? NOTICE_WITH_ACTIONS_MS : NOTICE_MS);
      }
    });
  }

  /**
   * Before a reload or restart: the tab shows its loading screen with this
   * text, and keeps it across the reload until the accounts are back.
   */
  async showReloading(text: string): Promise<void> {
    const message: HostMessage = { type: 'reloading', text };
    // If the reload does not happen after all, the next update must reach the tab even if nothing changed.
    this.lastPosted = '';
    await this.view?.webview.postMessage(message);
    // Lets the webview save the text before the window goes down.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  /** Shows a banner while the task runs. Tasks can overlap; each one's banner stays until it ends. */
  async busy<T>(text: string, task: () => Promise<T>): Promise<T> {
    const entry = { text };
    this.busyTasks.push(entry);
    this.sendBusy();
    try {
      return await task();
    } finally {
      this.busyTasks = this.busyTasks.filter((t) => t !== entry);
      this.sendBusy();
    }
  }

  private sendBusy(): void {
    this.send({ type: 'busy', text: this.busyTasks[this.busyTasks.length - 1]?.text ?? null });
  }

  private ask(spec: PromptSpec): Promise<Answer | undefined> {
    return new Promise((resolve) => {
      this.prompts.push({ spec, resolve });
      if (this.prompts.length === 1) {
        this.sendPrompt();
      }
      this.reveal();
    });
  }

  /** Accepts an answer only for the dialog on screen, and re-checks it: webview input is untrusted. */
  private answer(id: string, value: string | undefined, action: string | undefined, color: number | undefined): void {
    const head = this.prompts[0];
    if (!head || head.spec.id !== id) {
      return;
    }
    let result: Answer | undefined;
    if (value !== undefined || action !== undefined) {
      const spec = head.spec;
      if (spec.kind === 'input') {
        if (value === undefined || checkInput(spec.rule, value, { taken: spec.taken, optional: spec.optional })) {
          return;
        }
        result = { value: value.trim() };
      } else if (spec.kind === 'profile') {
        if (value === undefined || checkInput('alias', value, { taken: spec.taken }) || !isAvatarColour(color)) {
          return;
        }
        result = { value: value.trim(), color };
      } else {
        const allowed = spec.kind === 'confirm' ? spec.actions.map((a) => a.id) : spec.options.map((o) => o.id);
        if (!action || !allowed.includes(action)) {
          return;
        }
        result = { action };
      }
    }
    this.prompts.shift();
    this.sendPrompt();
    head.resolve(result);
  }

  private closeNotice(id: string, action?: string): void {
    const notice = this.notices.find((n) => n.id === id);
    if (!notice) {
      return;
    }
    this.notices = this.notices.filter((n) => n.id !== id);
    this.sendNotices();
    const resolve = this.noticeResolvers.get(id);
    this.noticeResolvers.delete(id);
    resolve?.(action && notice.actions?.some((a) => a.id === action) ? action : undefined);
  }

  private sendPrompt(): void {
    this.send({ type: 'prompt', prompt: this.prompts[0]?.spec ?? null });
  }

  private sendNotices(): void {
    this.send({ type: 'notices', notices: this.notices });
  }

  private newId(): string {
    return `p${++this.nextId}`;
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
          this.flushLogRequest();
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
    switch (message.type) {
      case 'ready':
        // A (re)loaded webview starts empty: send everything it should show.
        this.ready = true;
        this.post(true);
        this.postLog();
        this.sendPrompt();
        this.sendNotices();
        this.sendBusy();
        this.flushLogRequest();
        this.shown.fire();
        return;
      case 'promptResult':
        this.answer(message.id, message.value, message.action, message.color);
        return;
      case 'noticeAction':
        this.closeNotice(message.id, message.action);
        return;
      default:
        this.onMessage(message);
    }
  }

  /**
   * windowNote: set when this window has its own account; says which account other windows use.
   * perWindow: false when every switch is for all windows (the user set the login folder variable).
   */
  update(
    live: LiveState,
    reloadPending?: { alias?: string },
    signIn?: SignInState,
    switching = false,
    windowNote?: string,
    perWindow = true,
  ): void {
    if (!this.store) {
      return;
    }
    this.loaded = true;
    const profiles = this.store.list();
    this.current = buildViewState({
      profiles,
      live,
      reloadPending,
      signIn,
      hasBackup: this.store.listBackups().length > 0,
      switching,
      windowNote,
      perWindow,
    });

    this.description = live.kind === 'known' ? live.profile.alias : undefined;
    const expired = profiles.filter((p) => p.status === 'needs-relogin').length;
    const unsaved = live.kind === 'unknown';
    const reasons = [
      reloadPending ? 'reload this window to use the new account' : undefined,
      expired ? `${expired} account${expired === 1 ? '' : 's'} need${expired === 1 ? 's' : ''} a new sign-in` : undefined,
      // In place of a "save it?" notification: the tab shows a Save button.
      unsaved ? "the current login isn't saved yet" : undefined,
    ].filter((reason): reason is string => !!reason);
    this.badge = reasons.length
      ? { value: expired + (reloadPending ? 1 : 0) + (unsaved ? 1 : 0), tooltip: `Claude Switch: ${reasons.join('; ')}` }
      : undefined;

    if (this.view) {
      this.view.description = this.description;
      this.view.badge = this.badge;
    }
    this.post();
  }

  dispose(): void {
    // Let anything still waiting on the user finish as cancelled.
    for (const pending of this.prompts.splice(0)) {
      pending.resolve(undefined);
    }
    for (const resolve of this.noticeResolvers.values()) {
      resolve(undefined);
    }
    this.noticeResolvers.clear();
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
    if (!this.loaded) {
      return;
    }
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

  /** A hidden tab drops messages, so the request stays until the tab confirms it got it. */
  private flushLogRequest(): void {
    const view = this.view;
    if (!this.logRequested || !view?.visible || !this.ready) {
      return;
    }
    const message: HostMessage = { type: 'openLog' };
    void view.webview.postMessage(message).then((delivered) => {
      if (delivered) {
        this.logRequested = false;
      }
    });
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
