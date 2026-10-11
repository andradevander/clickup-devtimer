import * as vscode from 'vscode';
import { isUserDocumentChange, isUserSelectionChange } from '../core/activityFilter';

/**
 * Listens to the editor events that reflect real user activity (spec §2.2-B) and reports each one.
 * Window focus changes on their own are deliberately ignored: they cause false positives.
 */
export class ActivityWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(onActivity: (at: number) => void, clock: () => number = Date.now) {
    const focused = () => vscode.window.state.focused;
    const report = () => {
      onActivity(clock());
    };
    const whenFocused = () => {
      if (focused()) {
        report();
      }
    };

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const active = vscode.window.activeTextEditor?.document;
        if (
          isUserDocumentChange({
            windowFocused: focused(),
            scheme: event.document.uri.scheme,
            isActiveEditorDocument: active !== undefined && active === event.document,
            changeCount: event.contentChanges.length,
          })
        ) {
          report();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (isUserSelectionChange({ windowFocused: focused(), kind: event.kind })) {
          report();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(whenFocused),
      vscode.window.onDidChangeTextEditorVisibleRanges(whenFocused),
      vscode.workspace.onDidSaveTextDocument(whenFocused),
      vscode.window.onDidChangeNotebookEditorSelection(whenFocused),
      vscode.window.onDidOpenTerminal(whenFocused),
      vscode.window.onDidChangeActiveTerminal(whenFocused),
      vscode.window.onDidChangeTerminalState(whenFocused),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        if (event.terminal === vscode.window.activeTerminal) {
          whenFocused();
        }
      }),
      vscode.debug.onDidStartDebugSession(whenFocused),
      vscode.debug.onDidChangeActiveStackItem(whenFocused),
      vscode.debug.onDidChangeBreakpoints(whenFocused),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
