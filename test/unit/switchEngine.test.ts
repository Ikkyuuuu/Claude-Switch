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
  fakeAccount,
  fakeIdentify,
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

/** Credentials as newer Claude Code versions write them: without the organization. */
function withoutOrganization(credentialsRaw: string): string {
  return JSON.stringify({ ...JSON.parse(credentialsRaw), organizationUuid: undefined });
}

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
      identify: fakeIdentify,
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
    // A usage check: Claude says whose login ~/.claude holds.
    const confirm = () => engine.checkUsage(async () => ({ utilization: undefined, owner: fakeAccount('A') }));
    // Add Account for the account Claude is already signed in to: a fresh login, newer than the live one.
    const newer = fakeLogin('A', { version: 5 });
    await store.updateLogin(work.id, newer);
    await confirm();

    // Auto-refresh runs every few seconds.
    for (let i = 0; i < 3; i++) {
      await engine.refresh();
    }
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, newer.credentialsRaw);
    assert.equal(messages.filter((m) => m.startsWith('Kept the saved login')).length, 1, messages.join('\n'));

    // Once Claude refreshes the live login past the saved one, it is saved, as soon as a usage check confirms whose it is.
    const refreshed = fakeLogin('A', { version: 9 });
    await writeLive(paths, refreshed);
    await engine.refresh();
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, newer.credentialsRaw, 'not before then');
    assert.ok(engine.unconfirmed.has(work.id), 'the controller checks it soon');
    await confirm();
    await engine.refresh();
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, refreshed.credentialsRaw);
    assert.ok(!engine.unconfirmed.has(work.id));
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
    // Asked again, now that it is put right: nothing to do.
    assert.equal(await engine.keepSwitch(personal.id), 'ok');

    // Only the old tokens came back, next to the right account details: still a mix-up.
    const oldTokens = { credentialsRaw: loginA.credentialsRaw, account: loginB.account };
    await writeLive(paths, oldTokens);
    assert.equal(await engine.keepSwitch(personal.id), 'mismatch');
    assert.deepEqual(await readSnapshot(paths), oldTokens, 'leaves the files alone');

    // The old tokens came back too: only the user can fix that, by closing the old conversation.
    await writeLive(paths, loginA);
    assert.equal(await engine.keepSwitch(personal.id), 'mismatch');
    assert.equal((await readSnapshot(paths)).credentialsRaw, loginA.credentialsRaw, 'leaves the files alone');
  });

  test("keeps Claude's current usage with the live account", async () => {
    const utilization = { five_hour: { utilization: 88, resets_at: new Date(now + 3_600_000).toISOString() }, seven_day: { utilization: 32 } };
    assert.equal((await engine.checkUsage(async () => ({ utilization }))).updated, true);
    assert.equal(store.get(work.id)?.usage?.session?.percent, 88);
    assert.equal(store.get(work.id)?.usage?.weekly?.percent, 32);
    assert.equal(store.get(personal.id)?.usage, undefined);
  });

  test('drops usage when the login changed while Claude was asked', async () => {
    const utilization = { five_hour: { utilization: 50 } };
    const changed = await engine.checkUsage(async () => {
      await writeLive(paths, loginB);
      return { utilization };
    });
    assert.equal(changed.updated, false);
    assert.equal(store.get(work.id)?.usage, undefined);
    assert.equal(store.get(personal.id)?.usage, undefined);
  });

  test('a usage check holds the switch lock, and a switch waits for it', async () => {
    let finishCheck: () => void = () => undefined;
    const check = engine.checkUsage(() => new Promise((resolve) => (finishCheck = () => resolve({ utilization: { five_hour: { utilization: 1 } } }))));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Another background check skips its turn rather than queueing.
    await assert.rejects(engine.checkUsage(async () => ({ utilization: {} })), LockBusyError);
    const switching = engine.switchTo(personal.id);
    setTimeout(() => finishCheck(), 200);
    assert.equal((await check).updated, true);
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

  test("puts back the default account's details that a window with its own account wrote into .claude.json", async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    // A window uses Personal through its own login folder; Work is the default account.
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    // Claude in that window wrote Personal's details into the shared .claude.json, next to Work's tokens.
    await writeLive(paths, { credentialsRaw: loginA.credentialsRaw, account: loginB.account });
    assert.equal((await engine.detect()).kind, 'error');

    const live = await engine.refresh(folders);
    assert.equal(live.kind === 'known' && live.profile.id, work.id);
    assert.deepEqual(await readSnapshot(paths), loginA, "Work's details are back, and its tokens untouched");
    const config = JSON.parse((await readFiles(paths)).config);
    assert.deepEqual({ ...config, oauthAccount: undefined }, { ...OTHER_CONFIG, oauthAccount: undefined }, 'every other key is kept');

    // Also once Claude has refreshed Work's tokens: they are still the only saved ones of Work's organization.
    const refreshed = fakeLogin('A', { version: 3 });
    await writeLive(paths, { credentialsRaw: refreshed.credentialsRaw, account: loginB.account });
    assert.equal((await engine.refresh(folders)).kind, 'known');
    assert.deepEqual((await readSnapshot(paths)).account, loginA.account);
  });

  test("puts back the default account's tokens that a Claude on another account saved into ~/.claude", async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    // Work is the default account; Personal lives in a login folder of its own.
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    // A Claude still running on Personal outside its folder refreshed its login into ~/.claude.
    const stray = { credentialsRaw: fakeLogin('B', { version: 4 }).credentialsRaw, account: loginA.account };
    await writeLive(paths, stray);

    const live = await engine.refresh(folders);
    assert.equal(live.kind === 'known' && live.profile.id, work.id);
    assert.deepEqual(await readSnapshot(paths), loginA, "Work's own login is back");
    assert.deepEqual(await store.getBackup(store.listBackups()[0].slot), stray, 'the stray tokens are kept in a backup');
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, loginB.credentialsRaw, "and not saved into Personal's account");
    assert.equal(await folders.read(personal.id), loginB.credentialsRaw, "Personal's folder is left alone");
  });

  test('leaves a mix-up of the login files it cannot explain for the user to see', async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    // No window uses Personal, so its details did not come from one: an old login was written back.
    const writtenBack = { credentialsRaw: loginA.credentialsRaw, account: loginB.account };
    await writeLive(paths, writtenBack);
    assert.equal((await engine.refresh(folders)).kind, 'error');
    assert.deepEqual(await readSnapshot(paths), writtenBack);

    // A window uses Personal, but the tokens next to its details are no saved account's.
    await writeLive(paths, loginA);
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    const stranger = { credentialsRaw: fakeLogin('Stranger').credentialsRaw, account: loginB.account };
    await writeLive(paths, stranger);
    assert.equal((await engine.refresh(folders)).kind, 'error');
    assert.deepEqual(await readSnapshot(paths), stranger);

    // Both halves belong to accounts with a login folder: neither can be told to be the stray one.
    await folders.write(work.id, loginA.credentialsRaw);
    const both = { credentialsRaw: fakeLogin('B', { version: 4 }).credentialsRaw, account: loginA.account };
    await writeLive(paths, both);
    assert.equal((await engine.refresh(folders)).kind, 'error');
    assert.deepEqual(await readSnapshot(paths), both);
  });

  test("saves tokens refreshed in a login folder only once confirmed the account's own, and newer", async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    const dir = folders.dirOf(personal.id);
    // Not known yet to be Personal's: they wait for a usage check, or a switch, to ask Claude whose they are.
    const newer = fakeLogin('B', { version: 3 }).credentialsRaw;
    await folders.write(personal.id, newer);
    await engine.syncFolder(personal.id, newer);
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, loginB.credentialsRaw);
    assert.ok(engine.unconfirmed.has(personal.id));
    await engine.syncFolder(personal.id, newer, dir);
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, newer);
    assert.ok(!engine.unconfirmed.has(personal.id));
    // Older than what is saved, another organization's tokens, not JSON.
    for (const rejected of [fakeLogin('B', { version: 1 }).credentialsRaw, fakeLogin('Z', { version: 9 }).credentialsRaw, 'garbage']) {
      await folders.write(personal.id, rejected);
      await engine.syncFolder(personal.id, rejected, dir);
      assert.equal((await store.getLogin(personal.id))?.credentialsRaw, newer);
    }
  });

  test("never takes another account's login, signed in to from a window, for the account's own", async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    // In the window that uses Personal, Claude was signed in to another account, in the newer format that
    // no longer names the organization: nothing in the tokens says they aren't Personal's.
    const other = withoutOrganization(fakeLogin('Other', { version: 9 }).credentialsRaw);
    await folders.write(personal.id, other);
    await engine.syncFolder(personal.id, other);
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, loginB.credentialsRaw, 'not taken unconfirmed');

    // Its usage check: Claude says whose login it was given. The numbers are kept with no account, and Personal says whose its login is.
    const result = await engine.checkUsage(async () => ({ utilization: { five_hour: { utilization: 70 } }, owner: fakeAccount('Other') }), personal.id, { folders });
    assert.deepEqual(result, { updated: false, signedInAs: 'other@example.test' });
    assert.equal(store.get(personal.id)?.signedInAs, 'other@example.test');
    assert.equal(store.get(personal.id)?.usage, undefined, "its numbers are not Personal's");
    // Not even a switch, which confirms tokens at once, takes them.
    await engine.syncFolder(personal.id, other, folders.dirOf(personal.id));
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, loginB.credentialsRaw);

    // Signing in to Personal again puts it right.
    await store.updateLogin(personal.id, fakeLogin('B', { version: 12 }));
    assert.equal(store.get(personal.id)?.signedInAs, undefined);
  });

  test('makes an account the one its login turned out to be, keeping its name and colour', async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    await store.edit(personal.id, { alias: 'Personal', color: 7 });
    await store.setRenewal(personal.id, { date: '2026-12-20', cycle: 'monthly' });
    // The sign-in in the window that uses Personal picked another account in the browser.
    const other = withoutOrganization(fakeLogin('Other', { version: 3 }).credentialsRaw);
    await folders.write(personal.id, other);
    await engine.checkUsage(async () => ({ utilization: undefined, owner: fakeAccount('Other') }), personal.id, { folders });
    assert.equal(store.get(personal.id)?.signedInAs, 'other@example.test');

    // Keep it as that account: Claude is asked whose the login is, in the window's login folder.
    const kept = await engine.keepAsSignedIn(personal.id, folders, path.join(home, 'storage', 'usage', personal.id));
    assert.equal(kept.alias, 'Personal');
    assert.equal(kept.color, 7);
    assert.equal(kept.email, 'other@example.test');
    assert.equal(kept.signedInAs, undefined);
    assert.equal(kept.renewal, undefined, "Personal's renewal date was its own");
    assert.deepEqual(await store.getLogin(personal.id), { credentialsRaw: other, account: fakeAccount('Other') });
    assert.equal(store.findByAccount(fakeAccount('Other'))?.id, personal.id);
  });

  test("keeps an account no window uses as the one its saved login is, asking Claude with the login lent", async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    const dir = path.join(home, 'storage', 'usage', personal.id);
    // Saved before Claude Switch could tell whose it was: Personal's saved login is another account's.
    const other = withoutOrganization(fakeLogin('Other', { version: 3 }).credentialsRaw);
    await store.updateLogin(personal.id, { credentialsRaw: other, account: loginB.account });
    const kept = await engine.keepAsSignedIn(personal.id, folders, dir);
    assert.equal(kept.email, 'other@example.test');
    await assert.rejects(fs.access(path.join(dir, '.credentials.json')), 'lent for the question only');

    // An account already saved under another name stays where it is.
    await store.updateLogin(work.id, { credentialsRaw: withoutOrganization(fakeLogin('Other', { version: 4 }).credentialsRaw), account: loginA.account });
    await assert.rejects(engine.adoptLogin(work.id, fakeLogin('Other', { version: 5 })), /already saved as "Personal"/);
    await assert.rejects(engine.keepAsSignedIn(work.id, folders, dir), /default account/);
  });

  test('makes an account the one a new sign-in picked instead, and gives windows that use it the login', async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    const signedIn = fakeLogin('Other', { version: 2 });
    const adopted = await engine.adoptLogin(personal.id, signedIn, folders);
    assert.equal(adopted.alias, 'Personal');
    assert.equal(adopted.email, 'other@example.test');
    assert.deepEqual(await store.getLogin(personal.id), signedIn);
    assert.equal(await folders.read(personal.id), signedIn.credentialsRaw);
  });

  test("keeps usage with the account Claude says the login is, and sees ~/.claude's mix-up by it", async () => {
    // ~/.claude: Personal's tokens, in the newer format, next to Work's details.
    await writeLive(paths, { credentialsRaw: withoutOrganization(fakeLogin('B', { version: 6 }).credentialsRaw), account: loginA.account });
    assert.equal((await engine.detect()).kind, 'known', 'nothing in the files tells');
    const utilization = { five_hour: { utilization: 100 }, seven_day: { utilization: 24 } };
    assert.equal((await engine.checkUsage(async () => ({ utilization, owner: fakeAccount('B') }))).updated, true);
    assert.equal(store.get(work.id)?.usage, undefined, "not Work's numbers");
    assert.equal(store.get(personal.id)?.usage?.session?.percent, 100, "Personal's");
    assert.equal(store.get(work.id)?.signedInAs, undefined, "a mix-up in ~/.claude, not Work's own login");
    // Now known: ~/.claude is mixed up, so Personal's tokens are never saved as Work's.
    assert.equal((await engine.detect()).kind, 'error');
    await engine.refresh();
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, loginA.credentialsRaw);
  });

  test("puts back the default account's details that Claude on an account Claude Switch doesn't know wrote into .claude.json", async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    // Work's own login, in the newer format, next to the details of an account that isn't saved.
    const workLogin = { credentialsRaw: withoutOrganization(loginA.credentialsRaw), account: loginA.account };
    await store.updateLogin(work.id, workLogin);
    await writeLive(paths, { credentialsRaw: workLogin.credentialsRaw, account: fakeAccount('Stranger') });
    assert.equal((await engine.detect()).kind, 'error', 'the tokens are known to be Work’s');

    const live = await engine.refresh(folders);
    assert.equal(live.kind === 'known' && live.profile.id, work.id);
    assert.deepEqual(await readSnapshot(paths), workLogin);
  });

  test("a switch confirms whose the live login is before saving it, and never saves another account's as its own", async () => {
    const stray = withoutOrganization(fakeLogin('B', { version: 6 }).credentialsRaw);
    await writeLive(paths, { credentialsRaw: stray, account: loginA.account });
    await engine.switchTo(personal.id);
    assert.equal((await store.getLogin(work.id))?.credentialsRaw, loginA.credentialsRaw, "Work's saved login stays its own");
    assert.equal((await store.getBackup(store.listBackups()[0].slot))?.credentialsRaw, stray, 'a backup keeps it');
  });

  test("keeps a usage check's numbers with the account whose login folder Claude used", async () => {
    const utilization = { five_hour: { utilization: 66 }, seven_day: { utilization: 12 } };
    assert.equal((await engine.checkUsage(async () => ({ utilization }), personal.id)).updated, true);
    assert.equal(store.get(personal.id)?.usage?.session?.percent, 66);
    assert.equal(store.get(work.id)?.usage, undefined, 'not the default account');
  });

  test('lends the saved login of an account no window uses to its usage check, and keeps what Claude refreshed', async () => {
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    const dir = path.join(home, 'storage', 'usage', personal.id);
    const lent = path.join(dir, '.credentials.json');
    const refreshed = fakeLogin('B', { version: 5 }).credentialsRaw;
    const changed = await engine.checkUsage(
      async () => {
        // Claude finds Personal's saved login there, and refreshes it.
        assert.equal(await fs.readFile(lent, 'utf8'), loginB.credentialsRaw);
        await fs.writeFile(lent, refreshed);
        return { utilization: { five_hour: { utilization: 21 }, seven_day: { utilization: 4 } } };
      },
      personal.id,
      { folders, lendTo: dir },
    );
    assert.equal(changed.updated, true);
    assert.equal(store.get(personal.id)?.usage?.session?.percent, 21);
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, refreshed, 'the refreshed login is saved');
    await assert.rejects(fs.access(lent), 'and kept in one place only');

    // A check that VS Code closed during left newer tokens behind: they are saved before the next.
    const newer = fakeLogin('B', { version: 7 }).credentialsRaw;
    await fs.writeFile(lent, newer);
    const sawNewer = async () => {
      assert.equal(await fs.readFile(lent, 'utf8'), newer);
      return { utilization: undefined };
    };
    await engine.checkUsage(sawNewer, personal.id, { folders, lendTo: dir });
    assert.equal((await store.getLogin(personal.id))?.credentialsRaw, newer);

    // Once a window uses it, or while it is the default account, its login is in use: never lent.
    await engine.reconcileFolders(folders, work.id, new Set([personal.id]));
    assert.equal((await engine.checkUsage(async () => assert.fail('no check'), personal.id, { folders, lendTo: dir })).updated, false);
    assert.equal((await engine.checkUsage(async () => assert.fail('no check'), work.id, { folders, lendTo: dir })).updated, false);
    await assert.rejects(fs.access(lent));
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
