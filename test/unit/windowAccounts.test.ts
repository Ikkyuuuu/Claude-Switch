import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { identityOf } from '../../src/claudeFiles';
import { LoginFolders, startupLoginDir } from '../../src/windowAccounts';
import { fakeLogin, makeFakeHome, removeFakeHomes, writeLive } from '../fixtures';

suite('Window accounts', () => {
  teardown(removeFakeHomes);

  test('keeps one login folder per account, inside its own folder only', async () => {
    const { home } = await makeFakeHome();
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    assert.deepEqual(await folders.list(), []);

    const work = fakeLogin('Work');
    await folders.write('id-Work', work.credentialsRaw);
    assert.ok(folders.has('id-Work'));
    assert.equal(await folders.read('id-Work'), work.credentialsRaw);
    assert.equal(path.basename(folders.credentialsFile('id-Work')), '.credentials.json');
    assert.deepEqual(await folders.list(), ['id-Work']);

    await folders.remove('id-Work');
    assert.ok(!folders.has('id-Work'));
    assert.deepEqual(await folders.list(), []);

    for (const bad of ['../outside', 'a/b', '', '..']) {
      assert.throws(() => folders.dirOf(bad), /Not a valid account id/, bad);
    }
  });

  test("points a window at its account's folder at startup, but never at the default account's", async () => {
    const { home, paths } = await makeFakeHome();
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    const work = fakeLogin('Work');
    const personal = fakeLogin('Personal');
    await writeLive(paths, work);
    const identities = new Map([
      ['id-Work', identityOf(work.account)],
      ['id-Personal', identityOf(personal.account)],
    ]);
    const at = Date.now();

    // No choice, or the default account: ~/.claude.
    assert.equal(startupLoginDir({ choice: undefined, identities, paths, folders }), undefined);
    assert.equal(startupLoginDir({ choice: { profileId: 'id-Work', at }, identities, paths, folders }), undefined);
    // Another account whose folder is not there yet: ~/.claude until the controller creates it.
    assert.equal(startupLoginDir({ choice: { profileId: 'id-Personal', at }, identities, paths, folders }), undefined);

    await folders.write('id-Personal', personal.credentialsRaw);
    assert.equal(startupLoginDir({ choice: { profileId: 'id-Personal', at }, identities, paths, folders }), folders.dirOf('id-Personal'));
    // An account that was removed.
    assert.equal(startupLoginDir({ choice: { profileId: 'id-Gone', at }, identities, paths, folders }), undefined);

    // Once Personal becomes the default account, its window uses ~/.claude again.
    await writeLive(paths, personal);
    assert.equal(startupLoginDir({ choice: { profileId: 'id-Personal', at }, identities, paths, folders }), undefined);
  });

  test('treats an unreadable .claude.json as having no default account', async () => {
    const { home, paths } = await makeFakeHome();
    const folders = new LoginFolders(path.join(home, 'storage', 'logins'));
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.writeFile(paths.globalConfigFile, '{ not json');
    await folders.write('id-Personal', fakeLogin('Personal').credentialsRaw);
    const identities = new Map([['id-Personal', identityOf(fakeLogin('Personal').account)]]);
    const choice = { profileId: 'id-Personal', at: Date.now() };
    assert.equal(startupLoginDir({ choice, identities, paths, folders }), folders.dirOf('id-Personal'));
  });
});
