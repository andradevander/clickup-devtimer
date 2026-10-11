/*
 * Rules deciding which editor events count as user activity (spec §2.2-B). Kept free of the VS Code
 * API so they can be unit-tested; the watcher maps VS Code events onto these inputs.
 */

/**
 * Document schemes whose changes are produced by the editor or extensions, not by typing. Note that
 * `vscode-remote` (SSH/WSL/containers) and `vscode-notebook-cell` are real user documents.
 */
const IGNORED_SCHEMES = new Set(['output', 'debug', 'git', 'gitfs', 'log']);

export function isIgnoredScheme(scheme: string): boolean {
  return IGNORED_SCHEMES.has(scheme);
}

export interface DocumentChangeInput {
  windowFocused: boolean;
  scheme: string;
  /** Whether the changed document is the one in the active editor. */
  isActiveEditorDocument: boolean;
  changeCount: number;
}

/**
 * Only edits to the active editor's document, while the window is focused, count. This ignores
 * formatters, AI agents or other tools editing files while the user is away.
 */
export function isUserDocumentChange(input: DocumentChangeInput): boolean {
  return (
    input.windowFocused &&
    input.isActiveEditorDocument &&
    input.changeCount > 0 &&
    !isIgnoredScheme(input.scheme)
  );
}

export interface SelectionChangeInput {
  windowFocused: boolean;
  /** `TextEditorSelectionChangeKind`; `undefined` when the selection was changed through the API. */
  kind: number | undefined;
}

export function isUserSelectionChange(input: SelectionChangeInput): boolean {
  return input.windowFocused && input.kind !== undefined;
}
