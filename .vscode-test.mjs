import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version: process.env.VSCODE_TEST_VERSION ?? 'stable',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
