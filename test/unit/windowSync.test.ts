import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SwitchSignal, WindowSync } from '../../src/windowSync';

suite('WindowSync', () => {
  test('tells other windows about a switch, but not the window that made it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-sync-'));
    const seenByA: SwitchSignal[] = [];
    const a = new WindowSync(dir, 'window-a', (s) => seenByA.push(s), 20);
    let resolveB: (signal: SwitchSignal) => void = () => {};
    const receivedByB = new Promise<SwitchSignal>((resolve) => (resolveB = resolve));
    const b = new WindowSync(dir, 'window-b', (s) => resolveB(s), 20);
    try {
      await a.start();
      await b.start();
      await a.publish('Personal');
      const signal = await Promise.race([
        receivedByB,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no signal')), 3000)),
      ]);
      assert.equal(signal.alias, 'Personal');
      assert.equal(signal.source, 'window-a');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(seenByA.length, 0);
    } finally {
      a.dispose();
      b.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('ignores signals from before the window started', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-sync-'));
    const old = new WindowSync(dir, 'old-window', () => {}, 20);
    await old.publish('Work');
    const seen: SwitchSignal[] = [];
    const fresh = new WindowSync(dir, 'new-window', (s) => seen.push(s), 20);
    try {
      await fresh.start();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(seen.length, 0);
    } finally {
      fresh.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
