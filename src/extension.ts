import * as path from 'node:path';
import * as vscode from 'vscode';
import { AccountsView } from './accountsView';
import { ClaudePaths, resolvePaths } from './claudeFiles';
import { RosterController, SwitchArgs } from './commands';
import { ProfileStore } from './profileStore';
import { RosterLog } from './rosterLog';
import { RosterStatusBar } from './statusBar';
import { SwitchEngine } from './switchEngine';
import type { WebviewMessage } from './webview/protocol';
import { WindowSync } from './windowSync';

/** Returned from activate() under the test runner only. */
export interface RosterTestApi {
  controller: RosterController;
  engine: SwitchEngine;
  store: ProfileStore;
  view: AccountsView;
  log: RosterLog;
  paths: ClaudePaths;
  ready: Promise<void>;
  statusText(): string;
}

const MAC_MESSAGE =
  'Claude Switch does not support macOS yet: Claude Code keeps logins in the macOS Keychain there, not in files.';
const WARNED_CONFIG_DIR_KEY = 'roster.warnedConfigDir';

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

  const paths = resolvePaths();
  const storageDir = context.globalStorageUri.fsPath;
  const store = new ProfileStore(context.globalState, context.secrets);
  const engine = new SwitchEngine(paths, store, log, { lockFile: path.join(storageDir, 'switch.lock') });
  const statusBar = new RosterStatusBar();
  const view = new AccountsView(store, log, context.extensionUri, (message) => void onViewMessage(message));
  const sync = new WindowSync(storageDir, vscode.env.sessionId, (signal) => {
    void controller.onRemoteSwitch(signal);
  });
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const controller = new RosterController(engine, store, statusBar, view, log, sync, testMode, storageDir);
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
      case 'openBilling':
        return controller.openBilling();
      case 'add':
        return controller.addAccount();
      case 'saveCurrent':
        return controller.saveCurrent();
      case 'reload':
        return controller.reloadWindow();
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
    context.subscriptions.push(vscode.commands.registerCommand(id, handlers[id]));
  }
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

  log.info(`Claude login files: ${paths.credentialsFile} and ${paths.globalConfigFile}`);
  warnAboutConfigDir(context, paths, log, view);
  await sync.start();
  const ready = controller.startup();

  if (!testMode) {
    return undefined;
  }
  return { controller, engine, store, view, log, paths, ready, statusText: () => statusBar.text };
}

export function deactivate(): void {}

const COMMAND_IDS = [
  'claudeRoster.switch',
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
