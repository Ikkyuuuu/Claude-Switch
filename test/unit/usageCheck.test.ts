import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { usageFromUtilization } from '../../src/accountDetails';
import { askClaudeForUsage, forgetSavedUsage, UsageCheckOptions } from '../../src/usageCheck';

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

  test('fails when Claude cannot get the usage', async () => {
    await assert.rejects(askClaudeForUsage(options('usage-error')), /did not return the usage/);
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
