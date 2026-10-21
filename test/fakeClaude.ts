import { resolvePaths } from '../src/claudeFiles';
import { fakeLogin, writeLive } from './fixtures';

/**
 * Stands in for the Claude CLI in unit tests.
 *
 * As `claude auth login`, prints what the real CLI prints, then behaves
 * according to FAKE_CLAUDE_MODE:
 *   auto  - signs in by itself shortly after starting (the browser callback worked)
 *   paste - signs in once "good-code" arrives on stdin
 *   fail  - exits with an error, like a CLI without the auth command
 *   hang  - waits until it is killed
 *
 * With --input-format stream-json, answers control requests the way the real
 * CLI does, with FAKE_USAGE (JSON) as get_usage's rate_limits, then exits when
 * its input closes. FAKE_CLAUDE_MODE:
 *   usage       - answers
 *   usage-error - fails get_usage
 *   usage-hang  - never answers get_usage
 */
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'auto';

if (args.includes('--input-format')) {
  answerControlRequests();
} else {
  signIn();
}

function answerControlRequests(): void {
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
    if (!args.includes(flag)) {
      process.stderr.write(`error: expected ${flag}\n`);
      process.exit(2);
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    process.exit(3);
  }
  const respond = (requestId: string, response: object) =>
    process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { request_id: requestId, ...response } })}\n`);
  let buffer = '';
  process.stdin.on('data', (data) => {
    buffer += data.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as { request_id: string; request: { subtype: string } };
      buffer = buffer.slice(newline + 1);
      if (message.request.subtype === 'initialize') {
        process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'ui_status' })}\n`);
        respond(message.request_id, { subtype: 'success', response: {} });
      } else if (message.request.subtype === 'get_usage' && mode === 'usage') {
        respond(message.request_id, {
          subtype: 'success',
          response: { subscription_type: 'pro', rate_limits_available: true, rate_limits: JSON.parse(process.env.FAKE_USAGE ?? '{}') },
        });
      } else if (message.request.subtype === 'get_usage' && mode === 'usage-error') {
        respond(message.request_id, { subtype: 'error', error: 'not available' });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function signIn(): void {
  if (mode === 'fail' || args[0] !== 'auth' || args[1] !== 'login') {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('error: ANTHROPIC_API_KEY should have been removed\n');
    process.exit(3);
  }
  if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) {
    process.stderr.write('error: CLAUDE_SECURESTORAGE_CONFIG_DIR should have been removed\n');
    process.exit(4);
  }

  const emailIndex = args.indexOf('--email');
  const name = emailIndex >= 0 ? args[emailIndex + 1].split('@')[0] : 'New';

  process.stdout.write(
    'Opening browser to sign in…\n' +
      "If the browser didn't open, visit: https://claude.example.test/oauth/authorize?code=true&state=fake\n" +
      'Paste code here if prompted > ',
  );

  const finish = async (): Promise<void> => {
    await writeLive(resolvePaths({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }), fakeLogin(name));
    process.stdout.write('\nLogin successful.\n');
    process.exit(0);
  };

  if (mode === 'auto') {
    setTimeout(() => void finish(), 100);
  } else if (mode === 'paste') {
    process.stdin.on('data', (data) => {
      if (data.toString().trim() === 'good-code') {
        void finish();
      } else {
        process.stderr.write('Invalid code\n');
        process.exit(1);
      }
    });
  } else if (mode === 'hang') {
    setInterval(() => undefined, 1000);
  }
}
