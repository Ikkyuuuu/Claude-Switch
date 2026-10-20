import * as assert from 'node:assert/strict';
import { checkInput, MAX_ALIAS_LENGTH } from '../../src/webview/rules';

suite('input rules', () => {
  test('aliases: required, short, and not already used', () => {
    assert.match(checkInput('alias', '  ') ?? '', /Enter a name/);
    assert.match(checkInput('alias', 'x'.repeat(MAX_ALIAS_LENGTH + 1)) ?? '', /at most/);
    assert.match(checkInput('alias', 'work', { taken: ['Work'] }) ?? '', /already uses/);
    assert.equal(checkInput('alias', ' Personal ', { taken: ['Work'] }), undefined);
  });

  test('emails: optional when allowed, otherwise a plain address', () => {
    assert.equal(checkInput('email', '', { optional: true }), undefined);
    assert.match(checkInput('email', 'not an email', { optional: true }) ?? '', /valid email/);
    assert.match(checkInput('email', 'a@b.test & calc') ?? '', /valid email/);
    assert.equal(checkInput('email', 'first.last@example.co.th'), undefined);
  });

  test('dates: real calendar dates only', () => {
    assert.equal(checkInput('date', '', { optional: true }), undefined);
    assert.match(checkInput('date', '2026-02-30') ?? '', /real date/);
    assert.equal(checkInput('date', '2028-02-29'), undefined);
  });

  test('sign-in codes: one line, not too long', () => {
    assert.match(checkInput('code', '') ?? '', /Paste the code/);
    assert.match(checkInput('code', 'abc\ndef') ?? '', /exactly/);
    assert.equal(checkInput('code', 'abc#123'), undefined);
  });
});
