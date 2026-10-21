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

  /** Resolves once activity is reported, or after a few seconds. */
  async function settle(seen: () => number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (seen() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Windows and macOS watch the projects folder as a tree; Linux watches each project folder.
  for (const recursive of [true, false]) {
    test(`notices Claude writing a conversation, and nothing else (${recursive ? 'one watch for the tree' : 'a watch per project folder'})`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-switch-activity-'));
      const project = path.join(dir, 'projects', 'c--work-my-app');
      await fs.mkdir(project, { recursive: true });
      let seen = 0;
      const projects = new Set<string>();
      const activity = new ClaudeActivity(
        dir,
        (project) => {
          seen++;
          projects.add(project);
        },
        60_000,
        recursive,
      );
      activity.start();
      try {
        await fs.writeFile(path.join(dir, 'settings.json'), '{}');
        await fs.writeFile(path.join(project, 'notes.txt'), 'x');
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(seen, 0, 'other files are ignored');

        await fs.appendFile(path.join(project, 'a1b2.jsonl'), '{"type":"assistant"}\n');
        await settle(() => seen);
        assert.ok(seen > 0, 'a conversation file changed');
        assert.deepEqual([...projects], ['c--work-my-app'], 'with its project folder');

        // A project opened for the first time.
        projects.clear();
        seen = 0;
        const added = path.join(dir, 'projects', 'c--work-new-app');
        await fs.mkdir(added);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await fs.appendFile(path.join(added, 'c3d4.jsonl'), '{"type":"assistant"}\n');
        await settle(() => seen);
        assert.deepEqual([...projects], ['c--work-new-app']);
      } finally {
        activity.dispose();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  test('starts watching as soon as Claude makes its projects folder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-switch-activity-'));
    let seen = 0;
    // The retry is far off: the watch must not depend on it.
    const activity = new ClaudeActivity(dir, () => seen++, 10 * 60_000);
    activity.start();
    try {
      const project = path.join(dir, 'projects', 'c--work-my-app');
      await fs.mkdir(project, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.appendFile(path.join(project, 'a1b2.jsonl'), '{"type":"assistant"}\n');
      await settle(() => seen);
      assert.ok(seen > 0);
    } finally {
      activity.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('waits for a folder that does not exist yet', () => {
    const activity = new ClaudeActivity(path.join(os.tmpdir(), 'claude-switch-no-such-folder-xyz'), () => undefined, 10_000);
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
