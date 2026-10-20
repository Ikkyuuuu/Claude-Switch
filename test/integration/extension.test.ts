import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClaudeLogin } from '../../src/addAccount';
import { readSnapshot } from '../../src/claudeFiles';
import type { RosterTestApi } from '../../src/extension';
import type { AccountCard } from '../../src/webview/protocol';
import { fakeLogin, fakeUsageCache, OTHER_CONFIG, writeLive } from '../fixtures';

/**
 * Runs inside a real VS Code. .vscode-test.mjs points CLAUDE_CONFIG_DIR at a
 * throwaway folder, so these tests never see the real Claude login.
 */
suite('Claude Switch in VS Code', () => {
  let api: RosterTestApi;
  let reloads = 0;

  suiteSetup(async () => {
    assert.ok(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR must point at a fake folder');
    const extension = vscode.extensions.getExtension<RosterTestApi>('your-publisher-id.claude-account-roster');
    assert.ok(extension, 'extension is installed');
    api = (await extension.activate())!;
    assert.ok(api, 'activate() returns the test API under the test runner');
    assert.ok(api.paths.fromEnv && api.paths.configDir === process.env.CLAUDE_CONFIG_DIR, 'uses the fake folder');
    await api.ready;
    api.controller.reloadWindow = async () => {
      reloads++;
    };
    // Clicks in the webview carry no skipConfirm, and a modal dialog would block the test.
    await vscode.workspace.getConfiguration('claudeRoster').update('confirmBeforeSwitch', false, vscode.ConfigurationTarget.Global);
  });

  test('registers every command and the activity bar tab', async () => {
    const commands = await vscode.commands.getCommands(true);
    const ids = [
      'switch',
      'add',
      'rename',
      'remove',
      'saveCurrent',
      'recapture',
      'restore',
      'refresh',
      'showLog',
      'forgetAll',
      'signIn.openPage',
      'signIn.copyLink',
      'signIn.pasteCode',
      'signIn.cancel',
    ];
    for (const id of ids) {
      assert.ok(commands.includes(`claudeRoster.${id}`), `claudeRoster.${id}`);
    }
    assert.ok(commands.includes('workbench.view.extension.claudeRoster'), 'Claude Switch tab is contributed');
    await vscode.commands.executeCommand('workbench.view.extension.claudeRoster');
  });

  test('shows the live account, switches from a click in the view, and reloads', async () => {
    const work = fakeLogin('Work');
    const personal = fakeLogin('Personal');
    await writeLive(api.paths, work);

    await api.controller.refresh();
    assert.match(api.statusText(), /Unsaved account/);
    assert.deepEqual(api.view.state.current, { kind: 'unsaved', email: 'work@example.test' });

    const workProfile = await api.engine.saveCurrent('Work');
    const personalProfile = await api.store.add('Personal', personal);
    await api.controller.refresh();
    assert.match(api.statusText(), /\$\(account\) Work/);
    assert.deepEqual(summary(), { current: 'Work', others: ['Personal'] });

    // Claude Code's cached /usage numbers appear on the active account's card.
    await writeLive(api.paths, work, {
      ...OTHER_CONFIG,
      cachedUsageUtilization: fakeUsageCache(work.account, Date.now() + 1000, 42, 61),
    });
    await api.controller.refresh();
    const card = activeCard();
    assert.equal(card?.plan, 'Pro');
    assert.deepEqual(
      card?.usage?.meters.map((m) => [m.key, m.percent]),
      [
        ['session', 42],
        ['weekly', 61],
      ],
    );

    // The same message a click on the "Personal" card sends.
    api.view.receive({ type: 'switch', profileId: personalProfile.id });
    await waitFor(async () => (reloads === 1 ? true : undefined));

    assert.match(api.statusText(), /\$\(account\) Personal/);
    assert.deepEqual(summary(), { current: 'Personal', others: ['Work'] });
    const live = await readSnapshot(api.paths);
    assert.equal(live.credentialsRaw, personal.credentialsRaw);
    assert.equal(live.account?.emailAddress, personal.account.emailAddress);

    await vscode.commands.executeCommand('claudeRoster.switch', { profileId: workProfile.id, skipConfirm: true });
    assert.equal(reloads, 2);
    assert.match(api.statusText(), /\$\(account\) Work/);
    assert.equal(api.view.state.hasBackup, true);
  });

  test('records what happened in the activity log shown in the tab', async () => {
    const messages = api.log.entries.map((e) => e.message);
    assert.ok(messages.includes('Switched to "Personal".'), messages.join('\n'));
    assert.ok(messages.includes('Switched to "Work".'));
    // Opens the log page in the tab; must not throw or open anything else.
    const terminalsBefore = vscode.window.terminals.length;
    await vscode.commands.executeCommand('claudeRoster.showLog');
    assert.equal(vscode.window.terminals.length, terminalsBefore);
  });

  test('ignores malformed messages from the view', async () => {
    const before = reloads;
    api.view.receive({ type: 'switch', profileId: '../../../etc' });
    api.view.receive({ type: 'runCommand', command: 'workbench.action.reloadWindow' });
    api.view.receive('switch');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(reloads, before);
  });

  test('adds an account through a background sign-in, without a terminal', async () => {
    const fakeClaude = path.join(__dirname, '..', 'fakeClaude.js');
    api.controller.createLogin = (options) =>
      new ClaudeLogin({
        ...options,
        command: process.execPath,
        commandArgs: [fakeClaude],
        env: { ...process.env, FAKE_CLAUDE_MODE: 'auto' },
      });
    const terminalsBefore = vscode.window.terminals.length;

    // The same message the "Add account" button sends.
    api.view.receive({ type: 'add' });
    // Accepts the optional-email prompt (empty) and then the suggested alias.
    const added = await waitFor(async () => {
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return api.store.list().find((p) => p.email === 'new@example.test');
    });

    assert.equal(added.alias, 'New Org');
    assert.equal(vscode.window.terminals.length, terminalsBefore, 'no terminal was opened');
    // The view drops the sign-in card and lists the new account once it refreshes.
    await waitFor(async () => (!api.view.state.signIn && summary().others.includes('New Org') ? true : undefined));
  });

  test('shows the sign-in card while signing in', async () => {
    api.view.update({ kind: 'signed-out' }, undefined, { email: 'pick@example.test', url: 'https://claude.example.test/oauth' });
    assert.deepEqual(api.view.state.signIn, { email: 'pick@example.test', hasLink: true });
    await api.controller.refresh();
    assert.equal(api.view.state.signIn, undefined);
  });

  async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  function activeCard(): AccountCard | undefined {
    const { current } = api.view.state;
    return current.kind === 'account' ? current.account : undefined;
  }

  function summary(): { current: string; others: string[] } {
    const { current, others } = api.view.state;
    return {
      current: current.kind === 'account' ? current.account.alias : current.kind,
      others: others.map((card) => card.alias),
    };
  }
});
