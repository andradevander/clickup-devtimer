import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'andradevander.clickup-devtimer';

async function activeExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} not found`);
  await extension.activate();
  return extension;
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('Extension', () => {
  test('activates', async () => {
    const extension = await activeExtension();
    assert.strictEqual(extension.isActive, true);
  });

  test('registers every contributed command', async () => {
    const extension = await activeExtension();
    const packageJson = extension.packageJSON as { contributes: { commands: { command: string }[] } };
    const contributed = packageJson.contributes.commands.map((c) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));

    const missing = contributed.filter((command) => !registered.has(command));
    assert.deepStrictEqual(missing, []);
  });

  test('declares itself a UI extension so state stays on the local machine', async () => {
    const extension = await activeExtension();
    assert.deepStrictEqual((extension.packageJSON as { extensionKind: string[] }).extensionKind, ['ui']);
  });

  test('keeps its state in the configured storage directory', async () => {
    await activeExtension();
    const directory = process.env.CLICKUP_DEVTIMER_STORAGE_DIR;
    assert.ok(directory, 'the test runner must set CLICKUP_DEVTIMER_STORAGE_DIR');
    const lockPath = join(directory, 'lock.json');
    await waitFor(() => existsSync(lockPath));
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { schemaVersion: number; pid: number };
    assert.strictEqual(lock.schemaVersion, 1);
    assert.strictEqual(lock.pid, process.pid);
  });

  test('session commands are harmless without an active session', async () => {
    await activeExtension();
    await vscode.commands.executeCommand('clickupDevTimer.pauseTimer');
    await vscode.commands.executeCommand('clickupDevTimer.resumeTimer');
    await vscode.commands.executeCommand('clickupDevTimer.openInBrowser');
    await vscode.commands.executeCommand('clickupDevTimer.discardTime');
  });
});
