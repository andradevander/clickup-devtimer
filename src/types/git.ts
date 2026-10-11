import type * as vscode from 'vscode';

/*
 * Minimal subset of the built-in Git extension API (`vscode.git`, API version 1).
 * See https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
}

export interface RepositoryState {
  readonly HEAD: { readonly name?: string } | undefined;
  readonly onDidChange: vscode.Event<void>;
}
