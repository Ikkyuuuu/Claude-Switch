import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ClaudePaths, readSnapshot, SavedLogin } from '../../src/claudeFiles';
import { silentLogger } from '../../src/log';
import { ProfileMeta, ProfileStore } from '../../src/profileStore';
import { acquireLock, LockBusyError, Step, SwitchEngine, SwitchError } from '../../src/switchEngine';
import {
  fakeLogin,
  fakeUsageCache,
  makeFakeHome,
  MemorySecrets,
  MemoryState,
  OTHER_CONFIG,
  readFiles,
  removeFakeHomes,
  writeLive,
} from '../fixtures';

suite('SwitchEngine', () => {
  let home: string;
  let paths: ClaudePaths;
  let store: ProfileStore;
  let failAt: Step | undefined;
  let onStep: ((step: Step) => Promise<void>) | undefined;
  let now: number;
  let engine: SwitchEngine;
  let loginA: SavedLogin;
  let loginB: SavedLogin;
  let work: ProfileMeta;
  let personal: ProfileMeta;

  setup(async () => {
    ({ home, paths } = await makeFakeHome());
    store = new ProfileStore(new MemoryState(), new MemorySecrets());
    failAt = undefined;
    onStep = undefined;
    now = Date.now();
    engine = new SwitchEngine(paths, store, silentLogger, {
      lockFile: path.join(home, 'storage', 'switch.lock'),
      settleMs: 1,
      now: () => now,
      onStep: async (step) => {
        await onStep?.(step);
        if (step === failAt) {
          throw new Error(`simulated failure at ${step}`);
        }
      },
    });
    loginA = fakeLogin('A');
    loginB = fakeLogin('B');
    await writeLive(paths, loginA);
    work = await engine.saveCurrent('Work');
    personal = await store.add('Personal', loginB);
  });

  teardown(removeFakeHomes);

  test('detects the live login and its profile', async () => {
    const live = await engine.detect();
    assert.equal(live.kind, 'known');
    assert.equal(live.kind === 'known' && live.profile.id, work.id);
  });

  test('switches both files, keeps other config, and backs up the old login', async () => {
    const result = await engine.switchTo(personal.id);

    assert.equal(result.outcome, 'switched');
    const live = await readSnapshot(paths);
    assert.equal(live.credentialsRaw, loginB.credentialsRaw);
    assert.deepEqual(live.account, loginB.account);
    const config = JSON.parse((await readFiles(paths)).config);
    assert.deepEqual({ ...config, oauthAccount: undefined }, { ...OTHER_CONFIG, oauthAccount: undefined });

    const backup = await store.getBackup(store.listBackups()[0].slot);
    assert.equal(backup?.credentialsRaw, loginA.credentialsRaw);
    assert.equal(store.listBackups()[0].fromProfileId, work.id);
    assert.equal(store.getLastSwitch()?.profileId, personal.id);
    assert.equal((await engine.detect()).kind, 'known');
  });

  test('saves refreshed tokens into the active profile before switching away', async () => {
    const refreshed = fakeLogin('A', { version: 2 });
    await writeLive(paths, refreshed);

    await engine.switchTo(personal.id);

    assert.equal((await store.getLogin(work.id))?.credentialsRaw, refreshed.credentialsRaw);
    await engine.switchTo(work.id);
    assert.equal((await readSnapshot(paths)).credentialsRaw, refreshed.credentialsRaw);
  });

  test('keeps a saved login that is newer than the live one', async () => {
    const newer = fakeLogin('A', { version: 5 });
    await store.updateLogin(work.id, newer);
    await engine.refresh();
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, newer.credentialsRaw);
  });

  test('does nothing when the profile is already active', async () => {
    const before = await readFiles(paths);
    const result = await engine.switchTo(work.id);
    assert.equal(result.outcome, 'already-active');
    assert.deepEqual(await readFiles(paths), before);
    assert.equal(store.listBackups().length, 0);
  });

  for (const step of ['apply-credentials', 'apply-account', 'validate'] as const) {
    test(`rolls back to the exact previous files when ${step} fails`, async () => {
      const before = await readFiles(paths);
      failAt = step;
      await assert.rejects(engine.switchTo(personal.id), (err: unknown) => {
        assert.ok(err instanceof SwitchError);
        assert.equal(err.rolledBack, true);
        return true;
      });
      assert.deepEqual(await readFiles(paths), before);
      assert.equal(store.getLastSwitch(), undefined);
    });
  }

  for (const step of ['read', 'sync-back', 'backup'] as const) {
    test(`changes nothing when ${step} fails`, async () => {
      const before = await readFiles(paths);
      failAt = step;
      await assert.rejects(engine.switchTo(personal.id), /simulated failure/);
      assert.deepEqual(await readFiles(paths), before);
    });
  }

  test('rolls back when another process overwrites the files mid-switch', async () => {
    const before = await readFiles(paths);
    onStep = async (step) => {
      if (step === 'validate') {
        await fs.writeFile(paths.credentialsFile, fakeLogin('Intruder').credentialsRaw);
      }
    };
    await assert.rejects(engine.switchTo(personal.id), SwitchError);
    assert.deepEqual(await readFiles(paths), before);
  });

  test('rolls back to signed-out by deleting the credentials it wrote', async () => {
    await writeLive(paths, null);
    failAt = 'validate';
    await assert.rejects(engine.switchTo(personal.id), SwitchError);
    assert.deepEqual(await readSnapshot(paths), { credentialsRaw: null, account: null });
  });

  test('refuses to switch when .claude.json has an unexpected shape', async () => {
    await fs.writeFile(paths.globalConfigFile, JSON.stringify({ oauthAccount: ['unexpected'] }));
    const before = await readFiles(paths);
    await assert.rejects(engine.switchTo(personal.id), /unexpected format/);
    assert.deepEqual(await readFiles(paths), before);
    assert.equal((await engine.detect()).kind, 'error');
  });

  test('refuses to switch when .claude.json is missing', async () => {
    await fs.rm(paths.globalConfigFile);
    await assert.rejects(engine.switchTo(personal.id), /was not found/);
    assert.equal((await readSnapshot(paths)).credentialsRaw, loginA.credentialsRaw);
  });

  test('backs up an unsaved login so Restore Last Backup brings it back', async () => {
    const stranger = fakeLogin('Stranger');
    await writeLive(paths, stranger);
    assert.equal((await engine.detect()).kind, 'unknown');

    await engine.switchTo(personal.id);
    assert.equal((await readSnapshot(paths)).credentialsRaw, loginB.credentialsRaw);

    await engine.restoreBackup();
    const live = await readSnapshot(paths);
    assert.equal(live.credentialsRaw, stranger.credentialsRaw);
    assert.deepEqual(live.account, stranger.account);
  });

  test('restore puts the previous profile back and keeps the current one synced', async () => {
    await engine.switchTo(personal.id);
    const refreshedB = fakeLogin('B', { version: 3 });
    await writeLive(paths, refreshedB);

    const { profile } = await engine.restoreBackup();

    assert.equal(profile?.id, work.id);
    assert.equal((await readSnapshot(paths)).credentialsRaw, loginA.credentialsRaw);
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, refreshedB.credentialsRaw);
  });

  test('does not save tokens whose organization disagrees with the account', async () => {
    await writeLive(paths, { credentialsRaw: loginB.credentialsRaw, account: loginA.account });
    const live = await engine.refresh();
    assert.equal(live.kind, 'error');
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, loginA.credentialsRaw);
  });

  test('marks a profile whose refresh token expired as needs-relogin', async () => {
    await store.updateLogin(personal.id, fakeLogin('B', { refreshTokenExpiresAt: now - 1000 }));
    await engine.refresh();
    assert.equal(store.get(personal.id)?.status, 'needs-relogin');
    assert.equal(store.get(work.id)?.status, 'ok');
  });

  test("keeps the plan and Claude Code's cached usage with the live account", async () => {
    await writeLive(paths, loginA, { ...OTHER_CONFIG, cachedUsageUtilization: fakeUsageCache(loginA.account, Date.now(), 42, 61) });
    await engine.refresh();
    const saved = store.get(work.id);
    assert.equal(saved?.plan?.label, 'Pro');
    assert.equal(saved?.usage?.session?.percent, 42);
    assert.equal(saved?.usage?.weekly?.percent, 61);
    assert.equal(store.get(personal.id)?.usage, undefined, 'only the live account gets usage');
  });

  test('a refresh with nothing new does not need the lock', async () => {
    const release = await acquireLock(path.join(home, 'storage', 'switch.lock'));
    try {
      await writeLive(paths, loginA, { ...OTHER_CONFIG, cachedUsageUtilization: fakeUsageCache(loginA.account, Date.now(), 12) });
      const live = await engine.refresh();
      assert.equal(live.kind, 'known');
      assert.equal(store.get(work.id)?.usage?.session?.percent, 12, 'usage still updates while another window holds the lock');
    } finally {
      await release();
    }
  });

  test('ignores usage cached for a different account', async () => {
    await writeLive(paths, loginA, { ...OTHER_CONFIG, cachedUsageUtilization: fakeUsageCache(loginB.account, Date.now()) });
    await engine.refresh();
    assert.equal(store.get(work.id)?.usage, undefined);
  });

  test('ignores usage cached before switching to the account', async () => {
    await engine.switchTo(personal.id);
    const live = { ...OTHER_CONFIG, oauthAccount: loginB.account };
    await writeLive(paths, loginB, { ...live, cachedUsageUtilization: fakeUsageCache(loginB.account, Date.now() - 60_000) });
    await engine.refresh();
    assert.equal(store.get(personal.id)?.usage, undefined, 'fetched before the switch');

    await writeLive(paths, loginB, { ...live, cachedUsageUtilization: fakeUsageCache(loginB.account, Date.now() + 1000, 7) });
    await engine.refresh();
    assert.equal(store.get(personal.id)?.usage?.session?.percent, 7);
  });

  test('repairs oauthAccount when an exiting Claude process writes the old one back', async () => {
    await engine.switchTo(personal.id);
    await writeLive(paths, { credentialsRaw: loginB.credentialsRaw, account: loginA.account });

    assert.deepEqual(await engine.verifyLastSwitch(), { outcome: 'repaired' });
    assert.deepEqual((await readSnapshot(paths)).account, loginB.account);
    assert.equal(store.getLastSwitch(), undefined);
  });

  test('reports a switch that did not stick', async () => {
    await engine.switchTo(personal.id);
    await writeLive(paths, loginA);
    const check = await engine.verifyLastSwitch();
    assert.equal(check.outcome, 'mismatch');
  });

  test('only one switch runs at a time', async () => {
    const release = await acquireLock(path.join(home, 'storage', 'switch.lock'));
    await assert.rejects(engine.switchTo(personal.id), LockBusyError);
    await release();
    await engine.switchTo(personal.id);
  });

  test('takes over an abandoned lock', async () => {
    const lockFile = path.join(home, 'storage', 'switch.lock');
    await fs.writeFile(lockFile, 'old');
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(lockFile, old, old);
    await engine.switchTo(personal.id);
    await assert.rejects(fs.access(lockFile), 'lock released after the switch');
  });
});
