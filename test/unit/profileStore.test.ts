import * as assert from 'node:assert/strict';
import { MAX_BACKUPS, ProfileStore } from '../../src/profileStore';
import { EchoingState, fakeLogin, MemorySecrets, MemoryState } from '../fixtures';

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

  test('edits the name and colour without touching the login', async () => {
    const login = fakeLogin('A');
    const profile = await store.add('Work', login);
    await store.edit(profile.id, { alias: 'Office', color: 9 });
    const edited = store.get(profile.id);
    assert.equal(edited?.alias, 'Office');
    assert.equal(edited?.color, 9);
    assert.equal(edited?.email, profile.email);
    assert.deepEqual(await store.getLogin(profile.id), login);
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
    // Written by versions before 0.9.
    await state.update('roster.dismissedIdentities', ['x']);
    await store.clearAll();
    assert.equal(secrets.data.size, 0);
    assert.equal(state.data.size, 0);
  });

  test("remembers each window's account until it is removed or expires", async () => {
    const a = await store.add('Work', fakeLogin('A'));
    const b = await store.add('Personal', fakeLogin('B'));
    await store.setWindowChoice('window-1', a.id);
    await store.setWindowChoice('window-2', b.id);
    assert.equal(store.getWindowChoice('window-1')?.profileId, a.id);
    assert.deepEqual([...store.chosenAccounts()].sort(), [a.id, b.id].sort());

    // Unused for more than 30 days: forgotten.
    assert.deepEqual([...store.chosenAccounts(Date.now() + 31 * 24 * 60 * 60_000)], []);
    assert.equal(store.getWindowChoice('window-1', Date.now() + 31 * 24 * 60 * 60_000), undefined);

    // Removing an account sends its windows back to the default account.
    await store.remove(b.id);
    assert.equal(store.getWindowChoice('window-2'), undefined);
    assert.deepEqual([...store.chosenAccounts()], [a.id]);

    await store.setWindowChoice('window-1', undefined);
    assert.equal(store.getWindowChoice('window-1'), undefined);

    await store.setWindowChoice('window-1', a.id);
    await store.clearWindowChoices();
    assert.deepEqual([...store.chosenAccounts()], []);
  });

  test('does not write when nothing changes', async () => {
    const a = await store.add('Work', fakeLogin('A'));
    let writes = 0;
    const update = state.update.bind(state);
    state.update = async (key, value) => {
      writes++;
      await update(key, value);
    };
    await store.setStatus(a.id, 'ok');
    await store.edit(a.id, { alias: 'Work', color: 2 });
    await store.edit(a.id, { alias: 'Work', color: 2 });
    assert.equal(writes, 1);
  });

  test('keeps a rename made while an earlier write is coming back from VS Code', async () => {
    const echoing = new EchoingState();
    const racy = new ProfileStore(echoing, new MemorySecrets());
    const adding = racy.add('Work', fakeLogin('A'));
    await echoing.settle();
    const profile = await adding;

    // A background usage update, then a rename, then the usage write's echo lands,
    // then another background update. Unordered, the echo undid the rename.
    const usage = racy.setDetails(profile.id, { usage: { fetchedAt: 1, session: { percent: 5 } } });
    const edit = racy.edit(profile.id, { alias: 'Office', color: 3 });
    await new Promise((resolve) => setImmediate(resolve));
    echoing.deliverOne();
    await new Promise((resolve) => setImmediate(resolve));
    const status = racy.setStatus(profile.id, 'needs-relogin');
    await echoing.settle();
    await Promise.all([usage, edit, status]);

    const saved = racy.get(profile.id);
    assert.equal(saved?.alias, 'Office');
    assert.equal(saved?.color, 3);
    assert.equal(saved?.usage?.session?.percent, 5);
    assert.equal(saved?.status, 'needs-relogin');
  });

  test('shows and keeps a rename while an older value comes back from VS Code', async () => {
    const a = await store.add('Work', fakeLogin('A'));
    const before = state.get('roster.profiles');
    await store.edit(a.id, { alias: 'Office', color: 1 });
    // A moment later, VS Code sends an older write back.
    await state.update('roster.profiles', before);
    assert.equal(store.get(a.id)?.alias, 'Office');
    await store.setStatus(a.id, 'needs-relogin');
    const stored = state.get<{ alias: string; status: string }[]>('roster.profiles');
    assert.deepEqual([stored?.[0].alias, stored?.[0].status], ['Office', 'needs-relogin'], 'the next write keeps the rename');
  });

  test('applies a change again when another window overwrote it', async () => {
    const a = await store.add('Work', fakeLogin('A'));
    const update = state.update.bind(state);
    let overwritten = false;
    state.update = async (key, value) => {
      await update(key, value);
      if (!overwritten) {
        // Another window's older write arrives just after ours.
        overwritten = true;
        await update('roster.profiles', [{ ...a }]);
      }
    };
    await store.edit(a.id, { alias: 'Office', color: 4 });
    assert.equal(store.get(a.id)?.alias, 'Office');
  });
});
