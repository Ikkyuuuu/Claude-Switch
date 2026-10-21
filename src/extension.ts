import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AccountsView } from './accountsView';
import { ClaudeActivity } from './claudeActivity';
import { ClaudePaths, resolvePaths } from './claudeFiles';
import { RosterController, SwitchArgs, WindowContext } from './commands';
import { ProfileStore } from './profileStore';
import { RosterLog } from './rosterLog';
import { RosterStatusBar } from './statusBar';
import { SwitchEngine } from './switchEngine';
import type { WebviewMessage } from './webview/protocol';
import { LOGIN_DIR_VARIABLE, LoginFolders, projectFolderName, startupLoginDir } from './windowAccounts';
import { WindowSync } from './windowSync';

/** Returned from activate() under the test runner only. */
export interface RosterTestApi {
  controller: RosterController;
  engine: SwitchEngine;
  store: ProfileStore;
  view: AccountsView;
  log: RosterLog;
  paths: ClaudePaths;
  window: WindowContext;
  ready: Promise<void>;
  statusText(): string;
}

const MAC_MESSAGE =
  'Claude Switch does not support macOS yet: Claude Code keeps logins in the macOS Keychain there, not in files.';
const WARNED_CONFIG_DIR_KEY = 'roster.warnedConfigDir';
/** workspaceState: this workspace's id among the windows' account choices. */
const WINDOW_KEY = 'roster.windowKey';

export async function activate(context: vscode.ExtensionContext): Promise<RosterTestApi | undefined> {
  // Shown in the tab's log page; the output channel keeps a copy for bug reports.
  const output = vscode.window.createOutputChannel('Claude Switch', { log: true });
  const log = new RosterLog(output);
  context.subscriptions.push(output);

  if (process.platform === 'darwin') {
    log.warn(MAC_MESSAGE);
    // With no store, the view shows a "not supported" page.
    const view = new AccountsView(undefined, log, context.extensionUri, () => undefined);
    context.subscriptions.push(view, vscode.window.registerWebviewViewProvider(AccountsView.id, view));
    for (const id of COMMAND_IDS) {
      context.subscriptions.push(
        // The tab itself explains that macOS is not supported.
        vscode.commands.registerCommand(id, () => view.reveal()),
      );
    }
    return undefined;
  }

  const storageDir = context.globalStorageUri.fsPath;
  // A login folder variable that points into Claude Switch's own folders came from another window (see windowContext);
  // only one the user set says where the default login is.
  const inherited = process.env[LOGIN_DIR_VARIABLE];
  const userLoginDir = inherited !== undefined && !isInside(inherited, path.join(storageDir, 'logins')) ? inherited : undefined;
  const paths = resolvePaths({ ...process.env, [LOGIN_DIR_VARIABLE]: userLoginDir });
  const store = new ProfileStore(context.globalState, context.secrets);
  // First, before Claude Code starts any claude process: this window's account.
  const window = windowContext(context, store, paths, storageDir, log);
  const engine = new SwitchEngine(paths, store, log, { lockFile: path.join(storageDir, 'switch.lock') });
  const statusBar = new RosterStatusBar();
  // A failed click shows its error in the tab rather than vanishing.
  const view = new AccountsView(store, log, context.extensionUri, (message) => {
    Promise.resolve()
      .then(() => onViewMessage(message))
      .catch((err: unknown) => controller.showError(err));
  });
  const sync = new WindowSync(storageDir, vscode.env.sessionId, (signal) => {
    void controller.onRemoteSwitch(signal);
  });
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const controller = new RosterController(engine, store, statusBar, view, log, sync, testMode, storageDir, window);
  context.subscriptions.push(statusBar, view, controller, { dispose: () => sync.dispose() });

  /** Clicks in the Accounts view. Messages are already validated by AccountsView. */
  const onViewMessage = (message: WebviewMessage): Promise<unknown> | unknown => {
    switch (message.type) {
      case 'switch':
        return controller.switchAccount({ profileId: message.profileId });
      case 'rename':
        return controller.editAccount(message.profileId);
      case 'remove':
        return controller.removeAccount(message.profileId);
      case 'setRenewal':
        return controller.setRenewal(message.profileId);
      case 'signInAgain':
        return controller.signInAgain(message.profileId);
      case 'openBilling':
        return controller.openBilling();
      case 'add':
        return controller.addAccount();
      case 'saveCurrent':
        return controller.saveCurrent();
      case 'reload':
        return controller.reloadNow();
      case 'copyLog':
        return vscode.env.clipboard
          .writeText(log.toText())
          .then(() => view.notify('success', 'Copied the log. It contains no secrets.'));
      case 'clearLog':
        return log.clear();
      case 'openOutput':
        return output.show();
      case 'restore':
        return controller.restoreBackup();
      case 'signInOpen':
        return controller.signInOpenPage();
      case 'signInCopy':
        return controller.signInCopyLink();
      case 'signInCode':
        return controller.signInSendCode(message.code);
      case 'signInCancel':
        return controller.signInCancel();
      case 'ready':
      case 'promptResult':
      case 'noticeAction':
        // Handled by AccountsView itself.
        return undefined;
    }
  };

  // Right-clicking an account in the view passes { profileId } to Edit and Remove.
  const handlers: Record<(typeof COMMAND_IDS)[number], (...args: unknown[]) => unknown> = {
    'claudeRoster.switch': (args) => controller.switchAccount(isSwitchArgs(args) ? args : undefined),
    'claudeRoster.switchAll': (row) => controller.switchAllWindows(profileIdOf(row)),
    'claudeRoster.add': () => controller.addAccount(),
    'claudeRoster.rename': (row) => controller.editAccount(profileIdOf(row)),
    'claudeRoster.remove': (row) => controller.removeAccount(profileIdOf(row)),
    'claudeRoster.setRenewal': (row) => controller.setRenewal(profileIdOf(row)),
    'claudeRoster.saveCurrent': () => controller.saveCurrent(),
    'claudeRoster.recapture': () => controller.recapture(),
    'claudeRoster.restore': () => controller.restoreBackup(),
    'claudeRoster.refresh': () => controller.refresh(),
    'claudeRoster.showLog': () => controller.showLog(),
    'claudeRoster.forgetAll': () => controller.forgetAll(),
    'claudeRoster.signIn.openPage': () => controller.signInOpenPage(),
    'claudeRoster.signIn.copyLink': () => controller.signInCopyLink(),
    'claudeRoster.signIn.pasteCode': () => controller.signInPasteCode(),
    'claudeRoster.signIn.cancel': () => controller.signInCancel(),
  };
  for (const id of COMMAND_IDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args: unknown[]) =>
        Promise.resolve()
          .then(() => handlers[id](...args))
          .catch((err: unknown) => controller.showError(err)),
      ),
    );
  }
  // For the status bar's Reload button; not in the Command Palette.
  context.subscriptions.push(vscode.commands.registerCommand('claudeRoster.reloadNow', () => controller.reloadNow()));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AccountsView.id, view),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        controller.refreshIfStale();
        controller.checkUsageIfDue();
      }
    }),
    // Another window may have added or removed accounts since this list was drawn.
    view.onDidBecomeVisible(() => {
      controller.refreshIfStale();
      controller.checkUsageIfDue();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudeRoster.autoRefreshSeconds')) {
        controller.startAutoRefresh();
      }
    }),
  );

  // Usage is checked shortly after Claude replies, in any window.
  const activity = new ClaudeActivity(paths.configDir, (project) => controller.noteClaudeActivity(project));
  activity.start();
  context.subscriptions.push(activity);

  log.info(`Claude login files: ${paths.credentialsFile} and ${paths.globalConfigFile}`);
  warnAboutConfigDir(context, paths, log, view);
  await sync.start();
  const ready = controller.startup();

  if (!testMode) {
    return undefined;
  }
  return { controller, engine, store, view, log, paths, window, ready, statusText: () => statusBar.text };
}

export function deactivate(): void {}

const COMMAND_IDS = [
  'claudeRoster.switch',
  'claudeRoster.switchAll',
  'claudeRoster.add',
  'claudeRoster.rename',
  'claudeRoster.remove',
  'claudeRoster.setRenewal',
  'claudeRoster.saveCurrent',
  'claudeRoster.recapture',
  'claudeRoster.restore',
  'claudeRoster.refresh',
  'claudeRoster.showLog',
  'claudeRoster.forgetAll',
  'claudeRoster.signIn.openPage',
  'claudeRoster.signIn.copyLink',
  'claudeRoster.signIn.pasteCode',
  'claudeRoster.signIn.cancel',
] as const;

function isSwitchArgs(value: unknown): value is SwitchArgs {
  return typeof value === 'object' && value !== null && !(value instanceof vscode.Uri);
}

function profileIdOf(value: unknown): string | undefined {
  const id = typeof value === 'object' && value !== null ? (value as { profileId?: unknown }).profileId : undefined;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Sets up this window's own account (see windowAccounts.ts) and points its
 * Claude at it straight away, from what is already on disk.
 */
function windowContext(context: vscode.ExtensionContext, store: ProfileStore, paths: ClaudePaths, storageDir: string, log: RosterLog): WindowContext {
  const folders = new LoginFolders(path.join(storageDir, 'logins'));
  const terminals = context.environmentVariableCollection;
  terminals.description = "Points Claude in this window's terminals at this window's Claude account.";
  // A value in Claude Switch's own folders came from the window whose terminal ran `code` to open this one.
  const inherited = process.env[LOGIN_DIR_VARIABLE];
  const enabled = inherited === undefined || isInside(inherited, folders.root);
  if (!enabled) {
    log.warn(`${LOGIN_DIR_VARIABLE} is set, so Claude Switch switches the account of every window together.`);
    terminals.delete(LOGIN_DIR_VARIABLE);
  }
  let key = context.workspaceState.get<string>(WINDOW_KEY);
  if (!key) {
    key = randomUUID();
    void context.workspaceState.update(WINDOW_KEY, key);
  }
  const window: WindowContext = {
    enabled,
    key,
    projects: (vscode.workspace.workspaceFolders ?? []).map((folder) => projectFolderName(folder.uri.fsPath)),
    folders,
    defaultLoginDir: path.dirname(paths.credentialsFile),
    get loginDir() {
      return enabled ? process.env[LOGIN_DIR_VARIABLE] : undefined;
    },
    setLoginDir(dir) {
      if (!enabled) {
        return;
      }
      if (dir) {
        process.env[LOGIN_DIR_VARIABLE] = dir;
        terminals.replace(LOGIN_DIR_VARIABLE, dir);
      } else {
        delete process.env[LOGIN_DIR_VARIABLE];
        terminals.delete(LOGIN_DIR_VARIABLE);
      }
    },
  };
  if (enabled) {
    const identities = new Map(store.list().map((profile) => [profile.id, profile.identity]));
    window.setLoginDir(startupLoginDir({ choice: store.getWindowChoice(key), identities, paths, folders }));
  }
  return window;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Warns once per folder: Claude Switch follows CLAUDE_CONFIG_DIR, but the Claude extension may not. */
function warnAboutConfigDir(context: vscode.ExtensionContext, paths: ClaudePaths, log: RosterLog, view: AccountsView): void {
  if (!paths.fromEnv || context.extensionMode === vscode.ExtensionMode.Test) {
    return;
  }
  const message = `CLAUDE_CONFIG_DIR is set, so Claude Switch switches the login in ${paths.configDir}. The Claude Code extension may ignore this variable and keep using ~/.claude.`;
  log.warn(message);
  if (context.globalState.get<string>(WARNED_CONFIG_DIR_KEY) !== paths.configDir) {
    void context.globalState.update(WARNED_CONFIG_DIR_KEY, paths.configDir);
    void view.notify('warning', message);
  }
}
