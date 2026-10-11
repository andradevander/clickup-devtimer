import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'andradevander.clickup-devtimer';

suite('Extension', () => {
  test('activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test('registers every contributed command', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();

    const packageJson = extension.packageJSON as { contributes: { commands: { command: string }[] } };
    const contributed = packageJson.contributes.commands.map((c) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));

    const missing = contributed.filter((command) => !registered.has(command));
    assert.deepStrictEqual(missing, []);
  });
});
