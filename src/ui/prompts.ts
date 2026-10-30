import * as vscode from 'vscode';
import { truncate } from '../core/taskSelection';
import { formatHoursMinutes, localDayKey } from '../core/timeMath';
import { isAdvancedTimeTrackingLimitMessage, isPlanLimitMessage } from '../services/clickupService';
import type { ClickUpStatus } from '../types/clickup';
import type { QueueItem } from '../types/session';

export interface DescriptionOptions {
  /** The task and time being logged, shown in the title so the user knows what they describe. */
  taskName: string;
  durationMs: number;
  branch: string | undefined;
  /** The branch as readable text, such as "Fix login". */
  branchSummary: string | undefined;
  defaultDescription: string;
}

function suggestion(label: string, description: string, icon: string): vscode.QuickPickItem {
  return { label, description, iconPath: new vscode.ThemeIcon(icon) };
}

/**
 * Asks for the time entry description (spec §3.6). Suggestions: the current branch (selected, so Enter
 * accepts it), the branch as readable text and the default text; the user may also type their own.
 * Escape keeps the first suggestion instead of cancelling.
 */
export function askDescription(options: DescriptionOptions): Promise<string> {
  const { branch, branchSummary, defaultDescription } = options;
  const candidates = [
    ...(branch ? [suggestion(branch, vscode.l10n.t('Current branch'), 'git-branch')] : []),
    ...(branchSummary ? [suggestion(branchSummary, vscode.l10n.t('From branch name'), 'lightbulb')] : []),
    ...(defaultDescription
      ? [suggestion(defaultDescription, vscode.l10n.t('Default description'), 'note')]
      : []),
  ];
  const suggestions = candidates.filter(
    (item, index) => candidates.findIndex((other) => other.label === item.label) === index,
  );
  const fallback = branch ?? defaultDescription;
  const picker = vscode.window.createQuickPick();
  picker.title = vscode.l10n.t(
    'Describe {0} on "{1}"',
    formatHoursMinutes(options.durationMs),
    truncate(options.taskName, 60),
  );
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
          ? [suggestion(typed, vscode.l10n.t('Custom description'), 'edit'), ...suggestions]
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

/**
 * Lets the user choose one of the list's statuses. The current status is selected, so Enter keeps it
 * and changing the status always takes a deliberate choice.
 */
export function pickStatus(
  statuses: readonly ClickUpStatus[],
  current: string | undefined,
  placeHolder: string,
): Promise<string | undefined> {
  const items = statuses.map((status): vscode.QuickPickItem =>
    status.status.toLowerCase() === current?.toLowerCase()
      ? { label: status.status, description: vscode.l10n.t('Current') }
      : { label: status.status },
  );
  const picker = vscode.window.createQuickPick();
  picker.placeholder = placeHolder;
  picker.items = items;
  picker.activeItems = items.filter((item) => item.description !== undefined);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (!settled) {
        settled = true;
        resolve(value);
        picker.dispose();
      }
    };
    picker.onDidAccept(() => {
      finish(picker.selectedItems[0]?.label);
    });
    picker.onDidHide(() => {
      finish(undefined);
    });
    picker.show();
  });
}

/** Human-readable reason for a queued entry's last failure. */
function pendingErrorDetail(message: string): string {
  if (isAdvancedTimeTrackingLimitMessage(message)) {
    return vscode.l10n.t('ClickUp plan limit for descriptions reached; it will be sent without one');
  }
  if (isPlanLimitMessage(message)) {
    return vscode.l10n.t('ClickUp plan time tracking limit reached');
  }
  return message;
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
          : vscode.l10n.t('Attempts: {0} · {1}', item.attempts, pendingErrorDetail(item.lastError.message)),
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
