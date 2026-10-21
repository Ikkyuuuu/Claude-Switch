import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ClaudePaths, readSnapshot, SavedLogin } from '../../src/claudeFiles';
import { silentLogger } from '../../src/log';
import { ProfileMeta, ProfileStore } from '../../src/profileStore';
import { acquireLock, LockBusyError, Step, SwitchEngine, SwitchError } from '../../src/switchEngine';
import { LoginFolders } from '../../src/windowAccounts';
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
      lockWaitMs: 600,
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

  test('keeps a saved login that is newer than the live one, and says so once', async () => {
    const messages: string[] = [];
    const lockFile = path.join(home, 'storage', 'switch.lock');
    engine = new SwitchEngine(paths, store, { ...silentLogger, info: (m) => messages.push(m) }, { lockFile, settleMs: 1, now: () => now });
    // Add Account for the account Claude is already signed in to: a fresh login, newer than the live one.
    const newer = fakeLogin('A', { version: 5 });
    await store.updateLogin(work.id, newer);

    // Auto-refresh runs every few seconds.
    for (let i = 0; i < 3; i++) {
      await engine.refresh();
    }
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, newer.credentialsRaw);
    assert.equal(messages.filter((m) => m.startsWith('Kept the saved login')).length, 1, messages.join('\n'));

    // Once Claude refreshes the live login past the saved one, it is saved as usual.
    const refreshed = fakeLogin('A', { version: 9 });
    await writeLive(paths, refreshed);
    await engine.refresh();
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, refreshed.credentialsRaw);
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

  test('keeps an instant switch when an open conversation rewrites oauthAccount', async () => {
    await engine.switchTo(personal.id);
    assert.equal(await engine.keepSwitch(personal.id), 'ok');

    await writeLive(paths, { credentialsRaw: loginB.credentialsRaw, account: loginA.account });
    assert.equal(await engine.keepSwitch(personal.id), 'repaired');
    assert.deepEqual((await readSnapshot(paths)).account, loginB.account);

    // The old tokens came back too: only the user can fix that, by closing the old conversation.
    await writeLive(paths, loginA);
    assert.equal(await engine.keepSwitch(personal.id), 'mismatch');
    assert.equal((await readSnapshot(paths)).credentialsRaw, loginA.credentialsRaw, 'leaves the files alone');
  });

  test("keeps Claude's current usage with the live account", async () => {
    const utilization = { five_hour: { utilization: 88, resets_at: new Date(now + 3_600_000).toISOString() }, seven_day: { utilization: 32 } };
    assert.equal(await engine.checkUsage(async () => utilization), true);
    assert.equal(store.get(work.id)?.usage?.session?.percent, 88);
    assert.equal(store.get(work.id)?.usage?.weekly?.percent, 32);
    assert.equal(store.get(personal.id)?.usage, undefined);
  });

  test('drops usage when the login changed while Claude was asked', async () => {
    const utilization = { five_hour: { utilization: 50 } };
    const changed = await engine.checkUsage(async () => {
      await writeLive(paths, loginB);
      return utilization;
    });
    assert.equal(changed, false);
    assert.equal(store.get(work.id)?.usage, undefined);
    assert.equal(store.get(personal.id)?.usage, undefined);
  });

  test('a usage check holds the switch lock, and a switch waits for it', async () => {
    let finishCheck: () => void = () => undefined;
    const check = engine.checkUsage(() => new Promise((resolve) => (finishCheck = () => resolve({ five_hour: { utilization: 1 } }))));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Another background check skips its turn rather than queueing.
    await assert.rejects(engine.checkUsage(async () => ({})), LockBusyError);
    const switching = engine.switchTo(personal.id);
    setTimeout(() => finishCheck(), 200);
    assert.equal(await check, true);
    assert.equal((await switching).outcome, 'switched');
  });

  test('gives each chosen account other than the default its own login folder, and nothing else', async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    // Work is the default account (in ~/.claude); windows chose Work and Personal.
    await engine.reconcileFolders(folders, work.id, new Set([work.id, personal.id]));
    assert.deepEqual(await folders.list(), [personal.id]);
    assert.equal(await folders.read(personal.id), loginB.credentialsRaw);
    assert.equal((await readSnapshot(paths)).credentialsRaw, loginA.credentialsRaw, 'the default login is untouched');

    // Claude refreshed Personal's tokens in its folder; then no window uses Personal any more.
    const refreshed = fakeLogin('B', { version: 4 });
    await folders.write(personal.id, refreshed.credentialsRaw);
    await engine.reconcileFolders(folders, work.id, new Set([work.id]));
    // Conversations still open on it may refresh their login into it, so it stays a day.
    assert.deepEqual(await folders.list(), [personal.id]);
    now += 25 * 60 * 60_000;
    await engine.reconcileFolders(folders, work.id, new Set([work.id]));
    assert.deepEqual(await folders.list(), []);
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, refreshed.credentialsRaw, 'saved before the folder went');
  });

  test('restores the newest tokens of a backed-up account that was used since', async () => {
    await engine.switchTo(personal.id);
    // Work, in the backup, was then used in a window and its refresh token replaced: the saved login is newer.
    const refreshedWork = fakeLogin('A', { version: 6 });
    await store.updateLogin(work.id, refreshedWork);
    await engine.restoreBackup();
    assert.equal((await readSnapshot(paths)).credentialsRaw, refreshedWork.credentialsRaw);
  });

  test("removes the default account's folder, so its login is never in two places", async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    assert.deepEqual(await folders.list(), [personal.id]);
    // Personal became the default account (Switch All Windows, or /login).
    await writeLive(paths, loginB);
    await engine.reconcileFolders(folders, personal.id, new Set([personal.id]));
    assert.deepEqual(await folders.list(), []);
  });

  test('goes by the login in ~/.claude, not by what the caller last saw, to tell the default account', async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    // The caller still thinks Personal is the default, but Work is: Work gets no folder of its own.
    await engine.reconcileFolders(folders, personal.id, new Set([work.id, personal.id]));
    assert.deepEqual(await folders.list(), [personal.id]);

    // While the default login can't be read, nothing changes.
    await writeLive(paths, { credentialsRaw: loginB.credentialsRaw, account: loginA.account });
    await assert.rejects(engine.reconcileFolders(folders, undefined, new Set([work.id, personal.id])), /don't match/);
    assert.deepEqual(await folders.list(), [personal.id]);
  });

  test('Switch All Windows takes the newest tokens from the login folder, which goes with the switch', async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    // Claude refreshed Personal's login in its folder.
    const refreshed = fakeLogin('B', { version: 7 });
    await folders.write(personal.id, refreshed.credentialsRaw);

    await engine.switchTo(personal.id, { folders });
    assert.equal((await readSnapshot(paths)).credentialsRaw, refreshed.credentialsRaw, 'the refreshed login, not the saved one');
    assert.deepEqual(await folders.list(), [], 'one place only');
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, refreshed.credentialsRaw);
  });

  test('restores a backup with the newest tokens from its login folder, which goes too', async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    await engine.switchTo(personal.id);
    // Since then, a window used Work, the account in the backup, and Claude refreshed it there.
    await engine.reconcileFolders(folders, personal.id, new Set([work.id]));
    const refreshed = fakeLogin('A', { version: 8 });
    await folders.write(work.id, refreshed.credentialsRaw);

    await engine.restoreBackup(undefined, folders);
    assert.equal((await readSnapshot(paths)).credentialsRaw, refreshed.credentialsRaw);
    assert.deepEqual(await folders.list(), []);
  });

  test('backs up an unsaved login before restoring over it', async () => {
    await engine.switchTo(personal.id);
    // Claude was then signed in to an account that isn't saved, say with /login.
    const stranger = fakeLogin('Stranger');
    await writeLive(paths, stranger);

    await engine.restoreBackup();
    assert.equal((await readSnapshot(paths)).credentialsRaw, loginA.credentialsRaw);
    // Restoring again brings the unsaved login back.
    await engine.restoreBackup();
    const live = await readSnapshot(paths);
    assert.equal(live.credentialsRaw, stranger.credentialsRaw);
    assert.deepEqual(live.account, stranger.account);
  });

  test('saves tokens refreshed in a login folder only when they are newer and the right organization', async () => {
    const newer = fakeLogin('B', { version: 3 }).credentialsRaw;
    await engine.syncFolder(personal.id, newer);
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, newer);
    // Older than what is saved, another organization's tokens, not JSON.
    for (const rejected of [fakeLogin('B', { version: 1 }).credentialsRaw, fakeLogin('Z', { version: 9 }).credentialsRaw, 'garbage']) {
      await engine.syncFolder(personal.id, rejected);
      assert.equal((await store.getLogin(personal.id))?.credentialsRaw, newer);
    }
  });

  test("keeps a usage check's numbers with the account whose login folder Claude used", async () => {
    const utilization = { five_hour: { utilization: 66 }, seven_day: { utilization: 12 } };
    assert.equal(await engine.checkUsage(async () => utilization, personal.id), true);
    assert.equal(store.get(personal.id)?.usage?.session?.percent, 66);
    assert.equal(store.get(work.id)?.usage, undefined, 'not the default account');
  });

  test("ignores Claude Code's usage cache while windows use other accounts", async () => {
    engine.usageCacheTrusted = false;
    await writeLive(paths, loginA, { ...OTHER_CONFIG, cachedUsageUtilization: fakeUsageCache(loginA.account, Date.now(), 99) });
    await engine.refresh();
    assert.equal(store.get(work.id)?.usage, undefined);
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

  test('takes over a fresh lock at once when the window that held it is gone', async () => {
    // A process that has already exited stands in for a window that reloaded mid-switch.
    const gone = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => gone.once('exit', resolve));
    const lockFile = path.join(home, 'storage', 'switch.lock');
    await fs.writeFile(lockFile, `${gone.pid} ${new Date().toISOString()}`);
    const started = Date.now();
    await engine.switchTo(personal.id);
    assert.ok(Date.now() - started < 500, 'did not wait for the lock');
  });

  test("never releases a lock that another window took over", async () => {
    const lockFile = path.join(home, 'storage', 'switch.lock');
    const release = await acquireLock(lockFile);
    // This window held it too long, so another one took it over as abandoned.
    const theirs = `${process.ppid} ${new Date().toISOString()} theirs`;
    await fs.writeFile(lockFile, theirs);
    await release();
    assert.equal(await fs.readFile(lockFile, 'utf8'), theirs);
  });

  test('waits for a lock held by a running window', async () => {
    const lockFile = path.join(home, 'storage', 'switch.lock');
    await fs.writeFile(lockFile, `${process.ppid} ${new Date().toISOString()}`);
    await assert.rejects(engine.switchTo(personal.id), LockBusyError);
  });

  test('never lets two windows hold the lock, however often it changes hands', async () => {
    const lockFile = path.join(home, 'storage', 'switch.lock');
    let holders = 0;
    let overlaps = 0;
    // Any error fails the test too, such as the EPERM Windows reports while another window deletes the lock.
    const window = async () => {
      for (let i = 0; i < 25; i++) {
        const release = await acquireLock(lockFile, 60_000, 8_000);
        overlaps += ++holders > 1 ? 1 : 0;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
        holders--;
        await release();
      }
    };
    await Promise.all(Array.from({ length: 8 }, window));
    assert.equal(overlaps, 0, 'two windows held the lock at once');
  });
});
