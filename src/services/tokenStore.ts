import type * as vscode from 'vscode';

const SECRET_KEY = 'clickupDevTimer.personalToken';

/** The Personal Token, kept only in the editor's SecretStorage (OS keychain). */
export class TokenStore {
  /** Fires when the token changes, including from another window of the same editor. */
  readonly onDidChange: vscode.Event<void>;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.onDidChange = (listener, thisArgs, disposables) =>
      secrets.onDidChange(
        (event) => {
          if (event.key === SECRET_KEY) {
            listener.call(thisArgs, undefined);
          }
        },
        undefined,
        disposables,
      );
  }

  async get(): Promise<string | undefined> {
    const token = (await this.secrets.get(SECRET_KEY))?.trim();
    return token === '' ? undefined : token;
  }

  async set(token: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, token.trim());
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}
