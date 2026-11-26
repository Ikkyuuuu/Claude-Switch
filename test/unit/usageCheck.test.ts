import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { usageFromUtilization } from '../../src/accountDetails';
import { askClaudeForUsage, checkedAccount, clearInterruptedSaves, forgetSavedUsage, UsageCheckOptions } from '../../src/usageCheck';
import { fakeAccount } from '../fixtures';

const FAKE_CLAUDE = path.join(__dirname, '..', 'fakeClaude.js');
const RATE_LIMITS = {
  five_hour: { utilization: 87, resets_at: '2026-10-20T16:29:59.978011+00:00' },
  seven_day: { utilization: 31, resets_at: '2026-10-24T05:00:00+00:00' },
  seven_day_opus: null,
};

function options(mode: string, extra: Partial<UsageCheckOptions> = {}): UsageCheckOptions {
  return {
    command: process.execPath,
    commandArgs: [FAKE_CLAUDE],
    cwd: os.tmpdir(),
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_USAGE: JSON.stringify(RATE_LIMITS), ANTHROPIC_API_KEY: 'should-be-removed' },
    ...extra,
  };
}

suite('askClaudeForUsage', () => {
  test("returns Claude's current usage, in the shape the usage cache uses", async () => {
    const utilization = await askClaudeForUsage(options('usage'));
    assert.deepEqual(utilization, RATE_LIMITS);
    const usage = usageFromUtilization(utilization, 1000);
    assert.equal(usage?.session?.percent, 87);
    assert.equal(usage?.weekly?.percent, 31);
    assert.equal(usage?.weeklyOpus, undefined);
  });

  test("fails with Claude's own reason when it cannot get the usage, and lets it save its settings first", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-switch-usage-'));
    try {
      const saved = path.join(dir, 'saved');
      const ask = askClaudeForUsage(options('usage-error', { env: { ...options('usage-error').env, FAKE_SAVED: saved } }));
      await assert.rejects(ask, { message: 'Claude did not return the usage: get_usage failed: Rate limited.' });
      // Stopped before then, it would have left its temporary files behind.
      assert.equal(await fs.readFile(saved, 'utf8'), 'saved', 'Claude finished and exited by itself');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('gives up and stops Claude when it does not answer', async () => {
    const started = Date.now();
    await assert.rejects(askClaudeForUsage(options('usage-hang', { timeoutMs: 800 })), /did not answer in time/);
    assert.ok(Date.now() - started < 5000);
  });

  test('reports a missing CLI', async () => {
    await assert.rejects(askClaudeForUsage({ command: path.join(os.tmpdir(), 'no-such-claude.exe'), cwd: os.tmpdir() }), /Could not find the Claude Code CLI/);
  });
});

suite('clearInterruptedSaves', () => {
  test('deletes the temporary files and settings lock an interrupted Claude left, and nothing else', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-switch-usage-'));
    try {
      const keep = ['.claude.json', 'policy-limits.json', 'backups'];
      const leftovers = ['.claude.json.tmp.10124.16310f30a238', 'policy-limits.json.stamp.json.tmp.83c289be', '.claude.json.lock'];
      for (const name of [...keep, ...leftovers]) {
        await (name === 'backups' || name.endsWith('.lock') ? fs.mkdir(path.join(dir, name)) : fs.writeFile(path.join(dir, name), '{}'));
      }
      assert.equal(await clearInterruptedSaves(dir), leftovers.length);
      assert.deepEqual((await fs.readdir(dir)).sort(), [...keep].sort());
      assert.equal(await clearInterruptedSaves(dir), 0);
      assert.equal(await clearInterruptedSaves(path.join(dir, 'missing')), 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

suite('checkedAccount', () => {
  test('tells whose login Claude found, looked up afresh at each check', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-switch-usage-'));
    try {
      const file = path.join(dir, '.claude.json');
      await fs.writeFile(file, JSON.stringify({ numStartups: 3, oauthAccount: fakeAccount('Earlier') }));
      await forgetSavedUsage(dir);
      assert.equal(await checkedAccount(dir), undefined, "the last check's answer is gone before the next");
      // Claude looks its account up as it starts, and saves it.
      await fs.writeFile(file, JSON.stringify({ numStartups: 4, oauthAccount: fakeAccount('Now') }));
      assert.equal((await checkedAccount(dir))?.emailAddress, 'now@example.test');
      await fs.writeFile(file, JSON.stringify({ oauthAccount: { emailAddress: 1 } }));
      assert.equal(await checkedAccount(dir), undefined, 'not an account');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

suite('forgetSavedUsage', () => {
  test("clears only the saved usage in a usage check's own settings folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-switch-usage-'));
    try {
      const file = path.join(dir, '.claude.json');
      // Nothing saved yet: nothing to do.
      await forgetSavedUsage(dir);
      await fs.writeFile(file, JSON.stringify({ numStartups: 3, cachedUsageUtilization: { fetchedAtMs: 1, utilization: RATE_LIMITS } }));
      await forgetSavedUsage(dir);
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { numStartups: 3 });
      // Unreadable: removed, so the CLI starts the folder afresh.
      await fs.writeFile(file, '{ not json');
      await forgetSavedUsage(dir);
      await assert.rejects(fs.access(file));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
