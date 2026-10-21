import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  atomicWrite,
  ClaudeFileError,
  credentialsMatchAccount,
  readSnapshot,
  refreshTokenExpiry,
  resolvePaths,
  writeCredentials,
  writeOauthAccount,
} from '../../src/claudeFiles';
import { redact } from '../../src/log';
import { fakeAccount, fakeCredentials, fakeLogin, makeFakeHome, removeFakeHomes, writeLive } from '../fixtures';

suite('claudeFiles', () => {
  teardown(removeFakeHomes);

  test('resolves default paths under the home folder', () => {
    const paths = resolvePaths({}, path.join('C:', 'Users', 'me'));
    assert.equal(paths.credentialsFile, path.join('C:', 'Users', 'me', '.claude', '.credentials.json'));
    assert.equal(paths.globalConfigFile, path.join('C:', 'Users', 'me', '.claude.json'));
    assert.equal(paths.fromEnv, false);
  });

  test('resolves both files inside CLAUDE_CONFIG_DIR when it is set', () => {
    const dir = path.resolve('custom-claude');
    const paths = resolvePaths({ CLAUDE_CONFIG_DIR: dir }, path.join('C:', 'Users', 'me'));
    assert.equal(paths.credentialsFile, path.join(dir, '.credentials.json'));
    assert.equal(paths.globalConfigFile, path.join(dir, '.claude.json'));
    assert.equal(paths.fromEnv, true);
  });

  test('finds the login in CLAUDE_SECURESTORAGE_CONFIG_DIR when the user set it, as Claude does', () => {
    const home = path.join('C:', 'Users', 'me');
    const loginDir = path.resolve('my-logins');
    const paths = resolvePaths({ CLAUDE_SECURESTORAGE_CONFIG_DIR: loginDir }, home);
    assert.equal(paths.credentialsFile, path.join(loginDir, '.credentials.json'));
    assert.equal(paths.globalConfigFile, path.join(home, '.claude.json'), 'only the login moves');
    // Empty means ~/.claude, even with CLAUDE_CONFIG_DIR elsewhere.
    const custom = resolvePaths({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '', CLAUDE_CONFIG_DIR: path.resolve('custom-claude') }, home);
    assert.equal(custom.credentialsFile, path.join(home, '.claude', '.credentials.json'));
  });

  test('reads a missing login as nulls', async () => {
    const { paths } = await makeFakeHome();
    assert.deepEqual(await readSnapshot(paths), { credentialsRaw: null, account: null });
  });

  test('patches only oauthAccount and keeps key order and formatting', async () => {
    const { paths } = await makeFakeHome();
    await writeLive(paths, fakeLogin('A'));
    const before = JSON.parse(await fs.readFile(paths.globalConfigFile, 'utf8'));

    await writeOauthAccount(paths, fakeAccount('B'));

    const raw = await fs.readFile(paths.globalConfigFile, 'utf8');
    const after = JSON.parse(raw);
    assert.deepEqual(Object.keys(after), Object.keys(before));
    assert.deepEqual(after.oauthAccount, fakeAccount('B'));
    assert.deepEqual({ ...after, oauthAccount: undefined }, { ...before, oauthAccount: undefined });
    assert.ok(raw.startsWith('{\n  "'), 'keeps two-space indent');
    assert.ok(!raw.endsWith('\n'), 'keeps the missing trailing newline');
  });

  test('keeps CRLF line endings and a trailing newline', async () => {
    const { paths } = await makeFakeHome();
    await fs.writeFile(
      paths.globalConfigFile,
      JSON.stringify({ theme: 'x', oauthAccount: fakeAccount('A') }, null, 4).replace(/\n/g, '\r\n') + '\r\n',
    );
    await writeOauthAccount(paths, fakeAccount('B'));
    const raw = await fs.readFile(paths.globalConfigFile, 'utf8');
    assert.ok(raw.startsWith('{\r\n    "theme"'));
    assert.ok(raw.endsWith('}\r\n'));
    assert.ok(!/[^\r]\n/.test(raw), 'no bare LF');
  });

  test('removes oauthAccount when writing null', async () => {
    const { paths } = await makeFakeHome();
    await writeLive(paths, fakeLogin('A'));
    await writeOauthAccount(paths, null);
    assert.equal('oauthAccount' in JSON.parse(await fs.readFile(paths.globalConfigFile, 'utf8')), false);
  });

  for (const [label, content] of [
    ['an array root', '[]'],
    ['a string oauthAccount', JSON.stringify({ oauthAccount: 'someone@example.test' })],
    ['an oauthAccount without accountUuid', JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } })],
  ]) {
    test(`fails closed on ${label}`, async () => {
      const { paths } = await makeFakeHome();
      await fs.writeFile(paths.globalConfigFile, content);
      await assert.rejects(writeOauthAccount(paths, fakeAccount('B')), ClaudeFileError);
      assert.equal(await fs.readFile(paths.globalConfigFile, 'utf8'), content, 'file untouched');
    });
  }

  test('never echoes file content in parse errors', async () => {
    const { paths } = await makeFakeHome();
    const secret = 'sk-ant-oat01-SECRETSECRETSECRET';
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.writeFile(paths.credentialsFile, `{"claudeAiOauth": {"accessToken": "${secret}" oops`);
    await fs.writeFile(paths.globalConfigFile, '{}');
    await assert.rejects(readSnapshot(paths), (err: Error) => {
      assert.ok(err instanceof ClaudeFileError);
      assert.ok(!err.message.includes('SECRET'), err.message);
      return true;
    });
  });

  test('redacts token-shaped text', () => {
    assert.equal(redact('token sk-ant-oat01-abc_DEF-123 here'), 'token sk-ant-[redacted] here');
    assert.ok(!redact(`x ${'A'.repeat(60)} y`).includes('AAAA'));
    assert.ok(redact('C:\\Users\\me\\.claude\\.credentials.json').includes('.credentials.json'));
  });

  test('atomicWrite retries a locked rename, then succeeds', async () => {
    const { home } = await makeFakeHome();
    const file = path.join(home, 'target.json');
    await fs.writeFile(file, 'old');
    let calls = 0;
    await atomicWrite(file, 'new', {
      rename: async (from, to) => {
        calls++;
        if (calls < 3) {
          throw Object.assign(new Error('locked'), { code: 'EPERM' });
        }
        await fs.rename(from, to);
      },
    });
    assert.equal(calls, 3);
    assert.equal(await fs.readFile(file, 'utf8'), 'new');
    assert.deepEqual(await fs.readdir(home), ['target.json'], 'no temp files left');
  });

  test('atomicWrite gives up on a lasting lock and cleans up its temp file', async () => {
    const { home } = await makeFakeHome();
    const file = path.join(home, 'target.json');
    await fs.writeFile(file, 'old');
    await assert.rejects(
      atomicWrite(file, 'new', {
        rename: async () => {
          throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        },
      }),
      /locked/,
    );
    assert.equal(await fs.readFile(file, 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(home), ['target.json']);
  });

  test('writeCredentials(null) deletes only the credentials file', async () => {
    const { paths } = await makeFakeHome();
    await writeLive(paths, fakeLogin('A'));
    await writeCredentials(paths, null);
    assert.equal((await readSnapshot(paths)).credentialsRaw, null);
    await fs.access(paths.globalConfigFile);
  });

  test('detects tokens and identity from different organizations', () => {
    assert.equal(credentialsMatchAccount(fakeCredentials('A'), fakeAccount('A')), true);
    assert.equal(credentialsMatchAccount(fakeCredentials('A'), fakeAccount('B')), false);
  });

  test('reads refresh expiry in milliseconds or seconds', () => {
    assert.equal(refreshTokenExpiry(fakeCredentials('A', { refreshTokenExpiresAt: 1_900_000_000_000 })), 1_900_000_000_000);
    assert.equal(refreshTokenExpiry(fakeCredentials('A', { refreshTokenExpiresAt: 1_900_000_000 })), 1_900_000_000_000);
  });
});
