import * as assert from 'node:assert/strict';
import { legacyCommandId, moveLegacySettings, moveLegacyState } from '../../src/legacyNames';
import { ProfileStore } from '../../src/profileStore';
import { fakeLogin, MemorySecrets, MemoryState } from '../fixtures';

// The old names are spelled out: they must match what versions before 0.14 saved.
suite('Names from before 0.14', () => {
  test('moves saved accounts and choices to the new names, and nothing is lost', async () => {
    // What 0.13 left behind.
    const old = new MemoryState();
    const secrets = new MemorySecrets();
    const before = new ProfileStore(new MemoryState(), secrets);
    const work = await before.add('Work', fakeLogin('Work'));
    await old.update('roster.profiles', [work]);
    await old.update('roster.windowAccounts', { 'window-1': { profileId: work.id, at: Date.now(), projects: [] } });
    await old.update('roster.lastSwitch', { profileId: work.id, at: 1 });
    await old.update('roster.warnedConfigDir', '/fake/config');
    await old.update('roster.dismissedIdentities', ['x']);
    const workspace = new MemoryState();
    await workspace.update('roster.windowKey', 'window-1');

    const writes = moveLegacyState(old, workspace);
    // Seen at once, before the writes finish: the window's account is decided straight after.
    const store = new ProfileStore(old, secrets);
    assert.deepEqual(
      store.list().map((p) => p.alias),
      ['Work'],
    );
    assert.equal(workspace.get('claudeSwitch.windowKey'), 'window-1');
    await writes;

    assert.equal(store.getWindowChoice('window-1')?.profileId, work.id);
    assert.equal(store.getLastSwitch()?.profileId, work.id);
    assert.ok(await store.getLogin(work.id), 'the saved login is still there');
    assert.equal(old.get('claudeSwitch.warnedConfigDir'), '/fake/config');
    assert.deepEqual([...old.data.keys()].filter((key) => key.startsWith('roster.')), [], 'no old keys left');
    assert.equal(old.get('claudeSwitch.dismissedIdentities'), undefined, 'unused data is dropped, not moved');
    assert.equal(workspace.get('roster.windowKey'), undefined);
  });

  test('leaves data already under the new names alone', async () => {
    const state = new MemoryState();
    await state.update('roster.profiles', [{ alias: 'Old' }]);
    await state.update('claudeSwitch.profiles', [{ alias: 'New' }]);
    await moveLegacyState(state, new MemoryState());
    assert.deepEqual(state.get('claudeSwitch.profiles'), [{ alias: 'New' }]);
    assert.equal(state.get('roster.profiles'), undefined);
  });

  test('moves settings to the new names once, without replacing new ones', async () => {
    const values = new Map<string, unknown>([
      ['claudeRoster.switchMode', 'instant'],
      ['claudeRoster.usageCheckSeconds', 0],
      ['claudeRoster.autoRefreshSeconds', 5],
      ['claudeSwitch.autoRefreshSeconds', 2],
    ]);
    const settings = {
      get: (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    };
    const state = new MemoryState();

    assert.deepEqual(await moveLegacySettings(state, settings), ['claudeSwitch.switchMode', 'claudeSwitch.usageCheckSeconds']);
    assert.equal(values.get('claudeSwitch.switchMode'), 'instant');
    assert.equal(values.get('claudeSwitch.usageCheckSeconds'), 0, 'falsy values count too');
    assert.equal(values.get('claudeSwitch.autoRefreshSeconds'), 2, 'a setting made under the new name wins');

    // The old entries stay in settings.json; once moved, they no longer count.
    values.delete('claudeSwitch.switchMode');
    assert.deepEqual(await moveLegacySettings(state, settings), []);
    assert.equal(values.get('claudeSwitch.switchMode'), undefined);
  });

  test("keeps the commands' old ids, for keybindings made before", () => {
    assert.equal(legacyCommandId('claudeSwitch.switch'), 'claudeRoster.switch');
    assert.equal(legacyCommandId('claudeSwitch.signIn.cancel'), 'claudeRoster.signIn.cancel');
  });
});
