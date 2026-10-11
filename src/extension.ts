import * as vscode from 'vscode';
import { Commands } from './constants';

export function activate(context: vscode.ExtensionContext): void {
  // Placeholder handlers so every contributed command resolves; each one is replaced as its module lands.
  for (const command of Object.values(Commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        void vscode.window.showInformationMessage(vscode.l10n.t('"{0}" is not implemented yet.', command));
      }),
    );
  }
}

export function deactivate(): void {
  // Nothing to clean up yet: disposables are released through context.subscriptions.
}
