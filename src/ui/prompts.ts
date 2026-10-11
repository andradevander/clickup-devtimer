import * as vscode from 'vscode';
import { formatHoursMinutes, localDayKey } from '../core/timeMath';
import type { ClickUpStatus } from '../types/clickup';
import type { QueueItem } from '../types/session';

/**
 * Asks for the time entry description (spec §3.6). Suggestions: the current branch and the default
 * text; the user may also type their own. Escape keeps the pre-filled suggestion instead of cancelling.
 */
export function askDescription(branch: string | undefined, defaultDescription: string): Promise<string> {
  const suggestions: vscode.QuickPickItem[] = [
    ...(branch ? [{ label: branch, description: vscode.l10n.t('Current branch') }] : []),
    ...(defaultDescription && defaultDescription !== branch
      ? [{ label: defaultDescription, description: vscode.l10n.t('Default description') }]
      : []),
  ];
  const fallback = branch ?? defaultDescription;
  const picker = vscode.window.createQuickPick();
  picker.title = vscode.l10n.t('Time entry description');
  picker.placeholder = vscode.l10n.t('Type a description or pick a suggestion (Esc uses "{0}")', fallback);
  picker.items = suggestions;
  picker.ignoreFocusOut = true;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (!settled) {
        settled = true;
        resolve(value.trim() || fallback);
        picker.dispose();
      }
    };
    picker.onDidChangeValue((value) => {
      const typed = value.trim();
      picker.items =
        typed && !suggestions.some((item) => item.label === typed)
          ? [{ label: typed, description: vscode.l10n.t('Custom description') }, ...suggestions]
          : suggestions;
    });
    picker.onDidAccept(() => {
      finish(picker.selectedItems[0]?.label ?? picker.value);
    });
    picker.onDidHide(() => {
      finish(fallback);
    });
    picker.show();
  });
}

/** Lets the user choose one of the list's statuses. */
export async function pickStatus(
  statuses: readonly ClickUpStatus[],
  current: string | undefined,
  placeHolder: string,
): Promise<string | undefined> {
  const items = statuses.map((status): vscode.QuickPickItem =>
    status.status.toLowerCase() === current?.toLowerCase()
      ? { label: status.status, description: vscode.l10n.t('Current') }
      : { label: status.status },
  );
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.label;
}

export type PendingAction = { kind: 'retryAll' } | { kind: 'item'; item: QueueItem };

/** Lists the queued time entries (spec §2.2-F "Show Pending Sync"). */
export async function pickPendingItem(items: readonly QueueItem[]): Promise<PendingAction | undefined> {
  type Item = vscode.QuickPickItem & { action: PendingAction };
  const picks: Item[] = [
    { label: `$(sync) ${vscode.l10n.t('Retry all now')}`, action: { kind: 'retryAll' } },
    ...items.map((item): Item => ({
      label: `${item.status === 'failed' ? '$(error)' : '$(clock)'} ${item.taskName}`,
      description: `${formatHoursMinutes(item.duration)} · ${localDayKey(item.start)} · ${item.description}`,
      detail:
        item.lastError === null
          ? vscode.l10n.t('Waiting to be sent')
          : vscode.l10n.t('Attempts: {0} · {1}', item.attempts, item.lastError.message),
      action: { kind: 'item', item },
    })),
  ];
  return (
    await vscode.window.showQuickPick(picks, {
      title: vscode.l10n.t('ClickUp DevTimer: Pending Sync'),
      placeHolder: vscode.l10n.t('Pick an entry to retry, open or discard'),
      matchOnDescription: true,
    })
  )?.action;
}
