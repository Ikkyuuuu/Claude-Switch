import * as assert from 'node:assert/strict';
import { Logger } from '../../src/log';
import { RosterLog } from '../../src/rosterLog';

suite('RosterLog', () => {
  test('keeps entries in order and forwards them to the output channel', () => {
    const forwarded: string[] = [];
    const sink: Logger = {
      info: (m) => forwarded.push(`info ${m}`),
      warn: (m) => forwarded.push(`warn ${m}`),
      error: (m) => forwarded.push(`error ${m}`),
    };
    let clock = 1000;
    const log = new RosterLog(sink, 10, () => clock++);
    log.info('one');
    log.warn('two');
    log.error('three');
    assert.deepEqual(log.entries, [
      { at: 1000, level: 'info', message: 'one' },
      { at: 1001, level: 'warn', message: 'two' },
      { at: 1002, level: 'error', message: 'three' },
    ]);
    assert.deepEqual(forwarded, ['info one', 'warn two', 'error three']);
  });

  test('keeps only the most recent entries', () => {
    const log = new RosterLog(undefined, 3);
    for (let i = 1; i <= 5; i++) {
      log.info(`entry ${i}`);
    }
    assert.deepEqual(
      log.entries.map((e) => e.message),
      ['entry 3', 'entry 4', 'entry 5'],
    );
  });

  test('redacts anything token-shaped, in the tab and in the output channel', () => {
    const forwarded: string[] = [];
    const log = new RosterLog({ info: (m) => forwarded.push(m), warn() {}, error() {} });
    log.info('oops sk-ant-oat01-SECRETSECRET leaked');
    assert.ok(!log.entries[0].message.includes('SECRET'));
    assert.ok(!forwarded[0].includes('SECRET'));
    assert.ok(!log.toText().includes('SECRET'));
  });

  test('notifies listeners, clears, and stops notifying when unsubscribed', () => {
    const log = new RosterLog();
    let changes = 0;
    const stop = log.onDidChange(() => changes++);
    log.info('a');
    log.clear();
    assert.equal(changes, 2);
    assert.deepEqual(log.entries, []);
    stop();
    log.info('b');
    assert.equal(changes, 2);
  });

  test('formats the log as text for copying', () => {
    const log = new RosterLog(undefined, 10, () => Date.UTC(2026, 9, 20, 7, 30));
    log.warn('careful');
    assert.equal(log.toText(), '2026-10-20T07:30:00.000Z [warn] careful');
  });
});
