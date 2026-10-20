import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', '.vscode-test/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      curly: 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-throw-literal': 'warn',
      // Secrets must never reach the console; use the Logger, which redacts.
      'no-console': 'error',
    },
  },
);
