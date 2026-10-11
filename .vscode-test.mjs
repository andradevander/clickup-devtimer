import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version: process.env.VSCODE_TEST_VERSION ?? 'stable',
  env: {
    // Keep the tests away from the real ~/.clickup-devtimer.
    CLICKUP_DEVTIMER_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'clickup-devtimer-it-')),
  },
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
