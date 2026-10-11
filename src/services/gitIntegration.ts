import * as vscode from 'vscode';
import type { GitAPI, GitExtension, Repository } from '../types/git';

export interface BranchChange {
  repositoryRoot: string;
  branch: string;
}

/** Tracks the current branch of each open repository through the built-in Git extension. */
export class GitIntegration implements vscode.Disposable {
  private api: GitAPI | undefined;
  private readonly branches = new Map<string, string | undefined>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly branchEmitter = new vscode.EventEmitter<BranchChange>();

  /** Fires when a repository switches to another (named) branch. */
  readonly onDidChangeBranch = this.branchEmitter.event;

  /** Connects to the Git extension; does nothing when Git is unavailable or disabled. */
  async initialize(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (extension === undefined) {
      return;
    }
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      if (!exports.enabled) {
        return;
      }
      this.api = exports.getAPI(1);
    } catch {
      return;
    }
    for (const repository of this.api.repositories) {
      this.watch(repository);
    }
    this.disposables.push(
      this.api.onDidOpenRepository((repository) => {
        this.watch(repository);
      }),
      this.api.onDidCloseRepository((repository) => {
        const key = repository.rootUri.toString();
        this.watchers.get(key)?.dispose();
        this.watchers.delete(key);
        this.branches.delete(key);
      }),
    );
  }

  /** Branch of the repository containing the active file, or of the first repository. */
  currentBranch(): string | undefined {
    const repositories = this.api?.repositories ?? [];
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    const containing = repositories
      .filter((repository) => activePath?.startsWith(repository.rootUri.fsPath) ?? false)
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    return (containing ?? repositories[0])?.state.HEAD?.name;
  }

  dispose(): void {
    for (const disposable of [...this.disposables, ...this.watchers.values()]) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.watchers.clear();
    this.branchEmitter.dispose();
  }

  private watch(repository: Repository): void {
    const key = repository.rootUri.toString();
    if (this.watchers.has(key)) {
      return;
    }
    this.branches.set(key, repository.state.HEAD?.name);
    this.watchers.set(
      key,
      repository.state.onDidChange(() => {
        const branch = repository.state.HEAD?.name;
        if (branch !== this.branches.get(key)) {
          this.branches.set(key, branch);
          if (branch !== undefined) {
            this.branchEmitter.fire({ repositoryRoot: repository.rootUri.fsPath, branch });
          }
        }
      }),
    );
  }
}
