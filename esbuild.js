const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Prints build errors in the format VS Code's esbuild problem matcher expects. */
const problemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

// Never minified, so reviewers and Marketplace scanners can read the shipped code.
const shared = {
  bundle: true,
  minify: false,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

async function main() {
  const contexts = await Promise.all([
    // The extension, running in VS Code's extension host.
    esbuild.context({
      ...shared,
      entryPoints: ['src/extension.ts'],
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      outfile: 'dist/extension.js',
      external: ['vscode'],
    }),
    // The Accounts view, running in a webview.
    esbuild.context({
      ...shared,
      entryPoints: ['src/webview/main.ts'],
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      outfile: 'dist/webview.js',
    }),
  ]);
  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
