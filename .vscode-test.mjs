import { defineConfig } from '@vscode/test-cli';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The oldest VS Code this extension supports; keep in step with engines.vscode.
const version = process.env.ROSTER_TEST_VSCODE ?? '1.100.0';

// Everything large or stateful lives in the temp folder, outside the (possibly
// OneDrive-synced) project folder.
const cache = join(tmpdir(), 'claude-roster-vscode-test');
mkdirSync(cache, { recursive: true });
const executable = await downloadAndUnzipVSCode({ version, cachePath: cache });

// Fresh, fake Claude config and VS Code profile for every run: tests never see a real login.
// Earlier runs' folders hold only fake data, so clear them first.
const RUN_PREFIX = 'claude-roster-it-';
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(RUN_PREFIX)) {
    rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 3 });
  }
}
const run = mkdtempSync(join(tmpdir(), RUN_PREFIX));
const fakeClaudeDir = join(run, 'claude-config');
mkdirSync(fakeClaudeDir);

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  useInstallation: { fromPath: executable },
  launchArgs: [
    '--disable-extensions',
    `--user-data-dir=${join(run, 'user-data')}`,
    `--extensions-dir=${join(cache, 'extensions')}`,
  ],
  env: { CLAUDE_CONFIG_DIR: fakeClaudeDir },
  mocha: { ui: 'tdd', timeout: 30000 },
});
