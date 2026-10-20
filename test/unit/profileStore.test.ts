import * as assert from 'node:assert/strict';
import { MAX_BACKUPS, ProfileStore } from '../../src/profileStore';
import { fakeLogin, MemorySecrets, MemoryState } from '../fixtures';

suite('ProfileStore', () => {
  let state: MemoryState;
  let secrets: MemorySecrets;
  let store: ProfileStore;

  setup(() => {
    state = new MemoryState();
    secrets = new MemorySecrets();
    store = new ProfileStore(state, secrets);
  });

  test('keeps secrets in SecretStorage and only display data in globalState', async () => {
    const login = fakeLogin('A');
    const profile = await store.add('Work', login);
    assert.deepEqual(await store.getLogin(profile.id), login);
    const stateText = JSON.stringify([...state.data.values()]);
    assert.ok(!stateText.includes('fake-access'), 'no tokens in globalState');
    assert.ok(!stateText.includes('acct-A'), 'no raw account IDs in globalState');
  });

  test('rejects the same account twice', async () => {
    await store.add('Work', fakeLogin('A'));
    await assert.rejects(store.add('Again', fakeLogin('A')), /already saved as "Work"/);
  });

  test('treats the same person in another organization as a separate account', async () => {
    await store.add('Work', fakeLogin('A', { org: 'org-work' }));
    await store.add('Personal', fakeLogin('A', { org: 'org-personal' }));
    assert.equal(store.list().length, 2);
  });

  test('refuses to save another account into a profile', async () => {
    const profile = await store.add('Work', fakeLogin('A'));
    await assert.rejects(store.updateLogin(profile.id, fakeLogin('B')), /different account/);
  });

  test(`rotates backups, keeping the newest ${MAX_BACKUPS}`, async () => {
    for (let i = 1; i <= 5; i++) {
      await store.pushBackup(fakeLogin(`N${i}`), {});
    }
    const backups = store.listBackups();
    assert.equal(backups.length, MAX_BACKUPS);
    const newest = await store.getBackup(backups[0].slot);
    assert.equal(newest?.account?.accountUuid, 'acct-N5');
    const kept = await Promise.all(backups.map((b) => store.getBackup(b.slot)));
    assert.deepEqual(
      kept.map((s) => s?.account?.accountUuid),
      ['acct-N5', 'acct-N4', 'acct-N3'],
    );
    assert.equal([...secrets.data.keys()].filter((k) => k.startsWith('backup:')).length, MAX_BACKUPS);
  });

  test('remove wipes the profile, its secrets and its backups only', async () => {
    const a = await store.add('Work', fakeLogin('A'));
    const b = await store.add('Personal', fakeLogin('B'));
    await store.pushBackup(fakeLogin('A'), { fromProfileId: a.id, toProfileId: b.id });
    await store.pushBackup(fakeLogin('B'), { fromProfileId: b.id, toProfileId: a.id });

    await store.remove(a.id);

    assert.deepEqual(
      store.list().map((p) => p.alias),
      ['Personal'],
    );
    assert.equal(await store.getLogin(a.id), undefined);
    assert.ok(![...secrets.data.values()].some((v) => v.includes('fake-access-A')), 'no trace of A left');
    assert.equal(store.listBackups().length, 1);
    assert.ok(await store.getLogin(b.id));
  });

  test('clearAll leaves nothing behind', async () => {
    const a = await store.add('Work', fakeLogin('A'));
    await store.pushBackup(fakeLogin('A'), { fromProfileId: a.id });
    await store.dismiss('x');
    await store.clearAll();
    assert.equal(secrets.data.size, 0);
    assert.equal(state.data.size, 0);
  });
});
