import { resolvePaths } from '../src/claudeFiles';
import { fakeLogin, writeLive } from './fixtures';

/**
 * Stands in for `claude auth login` in unit tests: prints what the real CLI
 * prints, then behaves according to FAKE_CLAUDE_MODE:
 *   auto  - signs in by itself shortly after starting (the browser callback worked)
 *   paste - signs in once "good-code" arrives on stdin
 *   fail  - exits with an error, like a CLI without the auth command
 *   hang  - waits until it is killed
 */
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'auto';

if (mode === 'fail' || args[0] !== 'auth' || args[1] !== 'login') {
  process.stderr.write("error: unknown command 'auth'\n");
  process.exit(1);
}
if (process.env.ANTHROPIC_API_KEY) {
  process.stderr.write('error: ANTHROPIC_API_KEY should have been removed\n');
  process.exit(3);
}

const emailIndex = args.indexOf('--email');
const name = emailIndex >= 0 ? args[emailIndex + 1].split('@')[0] : 'New';

process.stdout.write(
  'Opening browser to sign in…\n' +
    "If the browser didn't open, visit: https://claude.example.test/oauth/authorize?code=true&state=fake\n" +
    'Paste code here if prompted > ',
);

async function finish(): Promise<void> {
  await writeLive(resolvePaths({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }), fakeLogin(name));
  process.stdout.write('\nLogin successful.\n');
  process.exit(0);
}

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
