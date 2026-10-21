import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { identityOf } from '../../src/claudeFiles';
import { accountForProject, LoginFolders, projectFolderName, startupLoginDir } from '../../src/windowAccounts';
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

suite('Which account a conversation used', () => {
  test("names a project's conversation folder as Claude Code does", () => {
    assert.equal(projectFolderName('c:\\Users\\watta\\OneDrive\\เอกสาร\\Project\\Claude Switch'), 'c--Users-watta-OneDrive--------Project-Claude-Switch');
    assert.equal(projectFolderName('C:\\work\\my-app'), 'C--work-my-app');
    assert.equal(projectFolderName('/home/dev/side_project'), '-home-dev-side-project');
  });

  test("goes by the window's choice for that project, else the default account", () => {
    const choices = [
      { profileId: 'id-Personal', at: 1, projects: ['c--work-side-project'] },
      { profileId: 'id-Other', at: 1, projects: ['C--work-other', 'C--work-shared'] },
    ];
    assert.equal(accountForProject('c--work-side-project', choices, 'id-Work'), 'id-Personal');
    assert.equal(accountForProject('c--work-shared', choices, 'id-Work'), 'id-Other', 'any folder of the window, any case');
    assert.equal(accountForProject('c--work-my-app', choices, 'id-Work'), 'id-Work');
    assert.equal(accountForProject('c--work-my-app', choices, undefined), undefined);
    // Very long names may be shortened by Claude Code.
    const long = 'c--' + 'x'.repeat(240);
    assert.equal(accountForProject(long.slice(0, 200) + '-1a2b3c', [{ profileId: 'id-Long', at: 1, projects: [long] }], 'id-Work'), 'id-Long');
  });
});
