import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClaudeLogin } from '../../src/addAccount';
import { readSnapshot } from '../../src/claudeFiles';
import type { RosterTestApi } from '../../src/extension';
import type { UsageCheckOptions } from '../../src/usageCheck';
import type { AccountCard } from '../../src/webview/protocol';
import { fakeLogin, fakeUsageCache, OTHER_CONFIG, writeLive } from '../fixtures';

/**
 * Runs inside a real VS Code. .vscode-test.mjs points CLAUDE_CONFIG_DIR at a
 * throwaway folder, so these tests never see the real Claude login.
 */
suite('Claude Switch in VS Code', () => {
  let api: RosterTestApi;
  let reloads = 0;
  let restarts = 0;
  let conversations = 0;
  const usageAsks: UsageCheckOptions[] = [];
  let usageReply: unknown = {};

  suiteSetup(async () => {
    assert.ok(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR must point at a fake folder');
    const extension = vscode.extensions.getExtension<RosterTestApi>('wattanun42.claude-switch-accounts');
    assert.ok(extension, 'extension is installed');
    api = (await extension.activate())!;
    assert.ok(api, 'activate() returns the test API under the test runner');
    assert.ok(api.paths.fromEnv && api.paths.configDir === process.env.CLAUDE_CONFIG_DIR, 'uses the fake folder');
    await api.ready;
    api.controller.reloadWindow = async () => {
      reloads++;
    };
    api.controller.restartExtensions = async () => {
      restarts++;
    };
    api.controller.startConversation = async () => {
      conversations++;
    };
    api.controller.askUsage = async (options) => {
      usageAsks.push(options);
      return usageReply;
    };
    // Clicks in the webview carry no skipConfirm, and a modal dialog would block the test.
    await vscode.workspace.getConfiguration('claudeRoster').update('confirmBeforeSwitch', false, vscode.ConfigurationTarget.Global);
    // Most tests look at the instant mode's checks; one test covers the default, reloading.
    await vscode.workspace.getConfiguration('claudeRoster').update('switchMode', 'newConversation', vscode.ConfigurationTarget.Global);
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

  test('shows the live account, and switches instantly from a click in the view', async () => {
    const work = fakeLogin('Work');
    const personal = fakeLogin('Personal');
    await writeLive(api.paths, work);

    await api.controller.refresh();
    assert.match(api.statusText(), /Unsaved account/);
    assert.deepEqual(api.view.state.current, { kind: 'unsaved', email: 'work@example.test' });

    await api.engine.saveCurrent('Work');
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

    // The same message a click on the "Personal" card sends. By default nothing
    // reloads or restarts: a new Claude conversation opens on the new account.
    api.view.receive({ type: 'switch', profileId: personalProfile.id });
    await waitFor(async () => (conversations === 1 ? true : undefined));
    assert.equal(reloads, 0);
    assert.equal(restarts, 0);
    await waitFor(async () => (api.view.currentNotices.some((n) => n.level === 'success' && n.text.includes('Switched to "Personal"')) ? true : undefined));

    assert.match(api.statusText(), /\$\(account\) Personal/);
    assert.deepEqual(summary(), { current: 'Personal', others: ['Work'] });
    const live = await readSnapshot(api.paths);
    assert.equal(live.credentialsRaw, personal.credentialsRaw);
    assert.equal(live.account?.emailAddress, personal.account.emailAddress);
    assert.equal(api.view.state.hasBackup, true);

    // A conversation opened before the switch rewrites .claude.json with its old
    // oauthAccount: put back quietly.
    await writeLive(api.paths, { credentialsRaw: personal.credentialsRaw, account: work.account });
    await api.controller.refresh();
    await waitFor(async () => ((await readSnapshot(api.paths)).account?.emailAddress === personal.account.emailAddress ? true : undefined));
    await waitFor(async () => (/\$\(account\) Personal/.test(api.statusText()) ? true : undefined));
    assert.ok(!api.view.currentNotices.some((n) => n.level === 'warning'), 'no warning for a repair');

    // It refreshes its token and writes the whole old login back: only the user can fix that.
    await writeLive(api.paths, work);
    await api.controller.refresh();
    await waitFor(async () => (api.view.currentNotices.some((n) => n.level === 'warning' && n.text.includes('changed back to "Work"')) ? true : undefined));
    assert.match(api.statusText(), /\$\(account\) Work/);
  });

  test('reloads the window by default, and restarts as switchMode says', async () => {
    const config = vscode.workspace.getConfiguration('claudeRoster');
    const personalProfile = api.store.list().find((p) => p.alias === 'Personal');
    const workProfile = api.store.list().find((p) => p.alias === 'Work');
    assert.ok(personalProfile && workProfile);
    try {
      await config.update('switchMode', undefined, vscode.ConfigurationTarget.Global);
      assert.equal(vscode.workspace.getConfiguration('claudeRoster').inspect('switchMode')?.defaultValue, 'reloadWindow');
      await vscode.commands.executeCommand('claudeRoster.switch', { profileId: personalProfile.id, skipConfirm: true });
      assert.equal(reloads, 1);
      assert.match(api.statusText(), /\$\(account\) Personal/);

      await config.update('switchMode', 'restartExtensions', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('claudeRoster.switch', { profileId: workProfile.id, skipConfirm: true });
      assert.equal(restarts, 1);
      assert.equal(reloads, 1);
      assert.match(api.statusText(), /\$\(account\) Work/);
      assert.equal(conversations, 1, 'no new conversation in the restarting modes');
    } finally {
      await config.update('switchMode', 'newConversation', vscode.ConfigurationTarget.Global);
    }
  });

  test("asks Claude for the active account's current usage", async () => {
    const before = usageAsks.length;
    usageReply = {
      five_hour: { utilization: 87, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 31, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() },
    };
    await api.controller.checkUsage();
    assert.equal(usageAsks.length, before + 1);
    const asked = usageAsks[usageAsks.length - 1];
    // Claude runs in Claude Switch's own folder, never in the workspace.
    assert.ok(path.isAbsolute(asked.cwd) && /claude-switch-accounts/i.test(asked.cwd), asked.cwd);
    assert.deepEqual(
      activeCard()?.usage?.meters.map((m) => [m.key, m.percent]),
      [
        ['session', 87],
        ['weekly', 31],
      ],
    );
  });

  test('switches once however many times an account is clicked', async () => {
    const personalProfile = api.store.list().find((p) => p.alias === 'Personal');
    const workProfile = api.store.list().find((p) => p.alias === 'Work');
    assert.ok(personalProfile && workProfile);
    const switched = () => api.log.entries.filter((e) => e.message === 'Switched to "Personal".').length;
    const switchesBefore = switched();
    const conversationsBefore = conversations;

    for (let i = 0; i < 5; i++) {
      api.view.receive({ type: 'switch', profileId: personalProfile.id });
    }
    await waitFor(async () => (/\$\(account\) Personal/.test(api.statusText()) ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(switched(), switchesBefore + 1);
    assert.equal(conversations, conversationsBefore + 1, 'one new conversation');

    // Clicking the account that is already active shows one notice, not one per click.
    for (let i = 0; i < 3; i++) {
      await api.controller.switchAccount({ profileId: personalProfile.id });
    }
    assert.equal(api.view.currentNotices.filter((n) => n.text.includes('already the active')).length, 1);

    await api.controller.switchAccount({ profileId: workProfile.id });
    assert.match(api.statusText(), /\$\(account\) Work/);
  });

  test('warns once when an older conversation writes back only its tokens', async () => {
    const personalProfile = api.store.list().find((p) => p.alias === 'Personal');
    const workProfile = api.store.list().find((p) => p.alias === 'Work');
    assert.ok(personalProfile && workProfile);
    await api.controller.switchAccount({ profileId: personalProfile.id });
    assert.equal(api.view.state.switching, undefined, 'the list is clickable again');

    // Work's tokens next to Personal's identity: the files no longer agree.
    const refresh = api.engine.refresh.bind(api.engine);
    let refreshes = 0;
    api.engine.refresh = () => {
      refreshes++;
      return refresh();
    };
    try {
      await writeLive(api.paths, { credentialsRaw: fakeLogin('Work').credentialsRaw, account: fakeLogin('Personal').account });
      await api.controller.refresh();
      await waitFor(async () => (api.view.currentNotices.some((n) => n.level === 'warning' && n.text.includes('was overwritten')) ? true : undefined));
      const after = refreshes;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.ok(refreshes - after <= 1, `refreshed ${refreshes - after} more times`);
    } finally {
      api.engine.refresh = refresh;
    }

    await api.controller.switchAccount({ profileId: workProfile.id });
    assert.match(api.statusText(), /\$\(account\) Work/);
  });

  test('records what happened in the activity log shown in the tab', async () => {
    const messages = api.log.entries.map((e) => e.message);
    assert.ok(messages.includes('Switched to "Personal".'), messages.join('\n'));
    assert.ok(messages.includes('Switched to "Work".'));
    assert.ok(
      messages.some((m) => m.includes('changed back to "Work"')),
      'the write-back is logged',
    );
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

    // The same message the "Add account" button sends. Every question is a dialog in the tab.
    api.view.receive({ type: 'add' });
    const emailPrompt = await waitFor(async () => {
      const p = api.view.currentPrompt;
      return p?.kind === 'input' && p.rule === 'email' ? p : undefined;
    });
    api.view.receive({ type: 'promptResult', id: emailPrompt.id, value: '' });

    const namePrompt = await waitFor(async () => {
      const p = api.view.currentPrompt;
      return p?.kind === 'input' && p.rule === 'alias' ? p : undefined;
    });
    assert.equal(namePrompt.value, 'New Org', 'suggests a name');
    // An answer that breaks the rules is ignored, and the dialog stays open.
    api.view.receive({ type: 'promptResult', id: namePrompt.id, value: 'x'.repeat(41) });
    assert.equal(api.view.currentPrompt?.id, namePrompt.id);
    api.view.receive({ type: 'promptResult', id: namePrompt.id, value: namePrompt.value });

    const added = await waitFor(async () => api.store.list().find((p) => p.email === 'new@example.test'));
    assert.equal(added.alias, 'New Org');
    assert.equal(vscode.window.terminals.length, terminalsBefore, 'no terminal was opened');
    // The confirmation is a notice in the tab, not a VS Code notification.
    await waitFor(async () => (api.view.currentNotices.some((n) => n.level === 'success' && n.text.includes('New Org')) ? true : undefined));
    // The view drops the sign-in card and lists the new account once it refreshes.
    await waitFor(async () => (!api.view.state.signIn && summary().others.includes('New Org') ? true : undefined));
  });

  test('asks inside the tab before removing an account', async () => {
    const target = api.store.list().find((p) => p.alias === 'New Org');
    assert.ok(target);
    api.view.receive({ type: 'remove', profileId: target.id });
    const confirm = await waitFor(async () => {
      const p = api.view.currentPrompt;
      return p?.kind === 'confirm' ? p : undefined;
    });
    assert.match(confirm.title, /Remove "New Org"/);
    // Only the actions the dialog offered count.
    api.view.receive({ type: 'promptResult', id: confirm.id, action: 'not-offered' });
    assert.equal(api.view.currentPrompt?.id, confirm.id);
    api.view.receive({ type: 'promptResult', id: confirm.id, action: 'remove' });
    await waitFor(async () => (api.store.get(target.id) ? undefined : true));
    assert.equal(api.view.currentPrompt, undefined);
  });

  test('edits the name and avatar colour in a dialog in the tab', async () => {
    const target = api.store.list().find((p) => p.alias === 'Personal');
    assert.ok(target);
    // The pencil button on an account card.
    api.view.receive({ type: 'rename', profileId: target.id });
    const edit = await waitFor(async () => {
      const p = api.view.currentPrompt;
      return p?.kind === 'profile' ? p : undefined;
    });
    assert.equal(edit.value, 'Personal');
    assert.ok(edit.taken?.includes('Work') && !edit.taken.includes('Personal'));
    // Out-of-range colours and taken names are refused, and the dialog stays open.
    api.view.receive({ type: 'promptResult', id: edit.id, value: 'Home', color: 99 });
    api.view.receive({ type: 'promptResult', id: edit.id, value: 'Work', color: 3 });
    assert.equal(api.view.currentPrompt?.id, edit.id);
    api.view.receive({ type: 'promptResult', id: edit.id, value: 'Home', color: 10 });

    await waitFor(async () => (api.store.get(target.id)?.alias === 'Home' ? true : undefined));
    assert.equal(api.store.get(target.id)?.color, 10);
    const card = await waitFor(async () => api.view.state.others.find((c) => c.id === target.id && c.alias === 'Home'));
    assert.equal(card.avatar, 10);
    assert.equal(card.initials, 'H');
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
