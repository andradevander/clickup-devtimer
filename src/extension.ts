import * as vscode from 'vscode';
import { Controller } from './controller';
import { defaultStorageDirectory } from './services/storageService';

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('ClickUp DevTimer', { log: true });
  context.subscriptions.push(log);

  controller = new Controller(context, defaultStorageDirectory(), log);
  context.subscriptions.push(controller);
  try {
    await controller.activate();
  } catch (error) {
    log.error('Activation failed', error);
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  await controller?.shutdown();
  controller = undefined;
}
