import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeLogin, ClaudeLoginOptions, createLoginDir, findOnPath, isValidEmail, removeLoginDir, waitForLogin } from '../../src/addAccount';
import { resolvePaths } from '../../src/claudeFiles';
import { fakeLogin, writeLive } from '../fixtures';

const FAKE_CLAUDE = path.join(__dirname, '..', 'fakeClaude.js');

/** Runs the fake CLI through node, so the tests never start the real Claude. */
function startFake(dir: string, mode: string, extra: Partial<ClaudeLoginOptions> = {}): ClaudeLogin {
  return new ClaudeLogin({
    command: process.execPath,
    commandArgs: [FAKE_CLAUDE],
    dir,
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, ANTHROPIC_API_KEY: 'should-be-removed' },
    ...extra,
  });
}

function nextUrl(cli: ClaudeLogin): Promise<string> {
  return cli.url ? Promise.resolve(cli.url) : new Promise((resolve) => cli.onUrl(resolve));
}

suite('ClaudeLogin', () => {
  let dir: string;

  setup(async () => {
    dir = await createLoginDir();
  });

  teardown(async () => {
    await removeLoginDir(dir);
  });

  test('signs in when Claude finishes on its own, and reports the sign-in link', async () => {
    const cli = startFake(dir, 'auto');
    assert.equal(await nextUrl(cli), 'https://claude.example.test/oauth/authorize?code=true&state=fake');
    const login = await waitForLogin(dir, { intervalMs: 20, timeoutMs: 5000 });
    assert.equal(login.account.emailAddress, 'new@example.test');
    assert.equal((await cli.exited).code, 0);
  });

  test('passes a pasted code to Claude', async () => {
    const cli = startFake(dir, 'paste');
    await nextUrl(cli);
    cli.sendCode('  good-code \n');
    const login = await waitForLogin(dir, { intervalMs: 20, timeoutMs: 5000 });
    assert.equal(login.account.emailAddress, 'new@example.test');
  });

  test('pre-fills the email and removes API key variables', async () => {
    const cli = startFake(dir, 'auto', { email: 'pick@example.test' });
    const login = await waitForLogin(dir, { intervalMs: 20, timeoutMs: 5000 });
    assert.equal(login.account.emailAddress, 'pick@example.test');
    assert.equal((await cli.exited).code, 0);
  });

  test('reports why Claude stopped, without links', async () => {
    const cli = startFake(dir, 'fail');
    const exit = await cli.exited;
    assert.equal(exit.code, 1);
    assert.match(exit.lastLine, /unknown command 'auth'/);
    assert.ok(!cli.running);
  });

  test('cancel stops Claude', async () => {
    const cli = startFake(dir, 'hang');
    await nextUrl(cli);
    cli.cancel();
    const exit = await cli.exited;
    assert.notEqual(exit.code, 0);
    assert.throws(() => cli.sendCode('late'), /already ended/);
  });

  test('reports a missing CLI', async () => {
    const cli = new ClaudeLogin({ command: path.join(dir, 'no-such-claude.exe'), dir });
    const exit = await cli.exited;
    assert.equal(exit.code, null);
    assert.match(exit.lastLine, /Could not find the Claude Code CLI/);
  });

  test('accepts only plain email addresses', () => {
    assert.ok(isValidEmail('first.last+tag@example.co.th'));
    for (const bad of ['', 'no-at-sign', 'a@b', 'a@example.com & calc', 'a"b@example.com', '%USERNAME%@example.com']) {
      assert.equal(isValidEmail(bad), false, bad);
    }
    assert.throws(() => startFake(dir, 'auto', { email: 'x@example.com & calc' }), /not valid/);
  });
});

suite('addAccount', () => {
  test('captures a login once both files exist and stop changing', async () => {
    const dir = await createLoginDir();
    try {
      const login = fakeLogin('New');
      setTimeout(() => void writeLive(resolvePaths({ CLAUDE_CONFIG_DIR: dir }), login), 50);
      const captured = await waitForLogin(dir, { intervalMs: 20, timeoutMs: 5000 });
      assert.deepEqual(captured, login);
    } finally {
      await removeLoginDir(dir);
    }
  });

  test('times out when nobody signs in', async () => {
    const dir = await createLoginDir();
    try {
      await assert.rejects(waitForLogin(dir, { intervalMs: 10, timeoutMs: 50 }), /Timed out/);
    } finally {
      await removeLoginDir(dir);
    }
  });

  test('stops when cancelled', async () => {
    const dir = await createLoginDir();
    try {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 30);
      await assert.rejects(waitForLogin(dir, { intervalMs: 10, signal: abort.signal }), /cancelled/);
    } finally {
      await removeLoginDir(dir);
    }
  });

  test('deletes its own sign-in folder', async () => {
    const dir = await createLoginDir();
    await fs.writeFile(path.join(dir, '.credentials.json'), '{}');
    await removeLoginDir(dir);
    await assert.rejects(fs.access(dir));
  });

  test('refuses to delete anything that is not its own sign-in folder', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'not-roster-'));
    try {
      await assert.rejects(removeLoginDir(other), /Refusing/);
      await assert.rejects(removeLoginDir(os.homedir()), /Refusing/);
      await assert.rejects(removeLoginDir(path.join(other, 'claude-roster-login-x')), /Refusing/);
      await fs.access(other);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

suite('findOnPath', () => {
  test('finds an npm-installed claude.cmd on Windows, and only in absolute PATH folders', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-path-'));
    try {
      await fs.writeFile(path.join(dir, 'claude.cmd'), '@echo off');
      const env = { Path: ['relative-dir', dir].join(path.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
      assert.equal(findOnPath('claude', env, 'win32')?.toLowerCase(), path.join(dir, 'claude.cmd').toLowerCase());
      assert.equal(findOnPath('claude', { Path: 'relative-dir', PATHEXT: '.CMD' }, 'win32'), undefined);
      assert.equal(findOnPath('missing-tool', env, 'win32'), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
