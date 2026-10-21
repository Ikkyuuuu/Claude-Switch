import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeActivity, isConversationFile } from '../../src/claudeActivity';
import { ACTIVITY_MAX_WAIT_MS, ACTIVITY_MIN_GAP_MS, ACTIVITY_QUIET_MS, usageCheckDue } from '../../src/usageCheck';

suite('Claude activity', () => {
  test('counts only conversation files under projects', () => {
    assert.ok(isConversationFile(path.join('projects', 'c--work-my-app', 'a1b2.jsonl')));
    assert.ok(isConversationFile('projects/c--work-my-app/a1b2/subagents/agent-1.jsonl'));
    for (const other of ['projects/a1b2.jsonl', 'projects/c--work-my-app/notes.txt', 'todos/a1b2.jsonl', '.credentials.json', 'settings.json']) {
      assert.equal(isConversationFile(other), false, other);
    }
  });

  test("notices Claude writing a conversation, and nothing else", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-activity-'));
    const project = path.join(dir, 'projects', 'c--work-my-app');
    await fs.mkdir(project, { recursive: true });
    let seen = 0;
    const activity = new ClaudeActivity(dir, () => seen++);
    activity.start();
    try {
      await fs.writeFile(path.join(dir, 'settings.json'), '{}');
      await fs.writeFile(path.join(project, 'notes.txt'), 'x');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(seen, 0, 'other files are ignored');

      await fs.appendFile(path.join(project, 'a1b2.jsonl'), '{"type":"assistant"}\n');
      const deadline = Date.now() + 5000;
      while (seen === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(seen > 0, 'a conversation file changed');
    } finally {
      activity.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('waits for a folder that does not exist yet', () => {
    const activity = new ClaudeActivity(path.join(os.tmpdir(), 'roster-no-such-folder-xyz'), () => undefined, 10_000);
    activity.start();
    activity.dispose();
  });
});

suite('usageCheckDue', () => {
  const minute = 60_000;
  const base = { lastCheck: 0, intervalMs: minute, activitySince: 0, lastActivity: 0 };

  test('checks every interval while Claude is idle', () => {
    assert.equal(usageCheckDue({ ...base, now: minute - 1 }), false);
    assert.equal(usageCheckDue({ ...base, now: minute }), true);
  });

  test('checks shortly after a reply finishes', () => {
    const replied = { ...base, activitySince: 20_000, lastActivity: 21_000 };
    assert.equal(usageCheckDue({ ...replied, now: 21_000 + ACTIVITY_QUIET_MS - 1 }), false, 'still replying');
    assert.equal(usageCheckDue({ ...replied, now: 21_000 + ACTIVITY_QUIET_MS }), true);
  });

  test('checks during a long reply, but never too often', () => {
    // Claude keeps writing: a check every ACTIVITY_MAX_WAIT_MS.
    const busy = { ...base, lastCheck: 10_000, activitySince: 10_000 };
    assert.equal(usageCheckDue({ ...busy, lastActivity: 10_000 + ACTIVITY_MAX_WAIT_MS - 100, now: 10_000 + ACTIVITY_MAX_WAIT_MS - 1 }), false);
    assert.equal(usageCheckDue({ ...busy, lastActivity: 10_000 + ACTIVITY_MAX_WAIT_MS, now: 10_000 + ACTIVITY_MAX_WAIT_MS }), true);
    // A reply that finished right after a check waits for the gap.
    const justChecked = { ...base, lastCheck: 30_000, activitySince: 30_500, lastActivity: 30_500 };
    assert.equal(usageCheckDue({ ...justChecked, now: 30_000 + ACTIVITY_MIN_GAP_MS - 1 }), false);
    assert.equal(usageCheckDue({ ...justChecked, now: 30_000 + ACTIVITY_MIN_GAP_MS }), true);
  });
});
