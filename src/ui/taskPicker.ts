import * as vscode from 'vscode';
import { parseTaskReference, type TaskReference } from '../core/taskIdParser';
import { groupTasks, spansSeveralLists, taskLocation, type BranchEntry } from '../core/taskSelection';
import type { ClickUpTask } from '../types/clickup';
import type { TaskRef } from '../types/session';

export interface TaskPickerOptions {
  loadTasks: (force: boolean) => Promise<ClickUpTask[]>;
  resolve: (reference: TaskReference) => Promise<ClickUpTask>;
  recentTasks: readonly TaskRef[];
  activeStatuses: readonly string[];
  recentCount: number;
  /** The task being timed: marked in the list and moved to the end of its section. */
  currentTaskId?: string | undefined;
  /** Task references parsed from the current Git branch; those tasks are listed first. */
  branchReferences?: readonly TaskReference[] | undefined;
  /** Reports a failed load or lookup; the picker stays open. */
  onError: (error: unknown) => void;
}

interface PickItem extends vscode.QuickPickItem {
  /** A task from the assigned list. */
  task?: ClickUpTask;
  /** A recent task not in the assigned list; fetched when picked. */
  ref?: TaskRef;
  /** The "look up" entry for a typed ID or URL. */
  lookup?: TaskReference;
}

function separator(label: string): PickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

interface ItemStyle {
  currentTaskId: string | undefined;
  /** Hidden in the "In progress" section, where the header already says it. */
  showStatus: boolean;
  /** Only when the tasks come from several lists; otherwise it is the same line repeated. */
  showLocation: boolean;
}

function idLabel(id: string, customId: string | null | undefined): string {
  return `#${customId ?? id}`;
}

function taskItem(task: ClickUpTask, style: ItemStyle): PickItem {
  const current = task.id === style.currentTaskId;
  const parts = [
    idLabel(task.id, task.custom_id),
    ...(style.showStatus ? [task.status.status] : []),
    ...(current ? [vscode.l10n.t('Current timer')] : []),
  ];
  return {
    label: current ? `$(play-circle) ${task.name}` : task.name,
    description: parts.join(' · '),
    ...(style.showLocation ? { detail: taskLocation(task) } : {}),
    task,
  };
}

function refItem(ref: TaskRef, style: ItemStyle): PickItem {
  const current = ref.id === style.currentTaskId;
  return {
    label: current ? `$(play-circle) ${ref.name}` : ref.name,
    description: [idLabel(ref.id, ref.customId), ...(current ? [vscode.l10n.t('Current timer')] : [])].join(
      ' · ',
    ),
    ref,
  };
}

function branchItem(entry: BranchEntry, style: ItemStyle): PickItem {
  return 'task' in entry ? taskItem(entry.task, style) : refItem(entry.ref, style);
}

function section(label: string, items: PickItem[]): PickItem[] {
  return items.length > 0 ? [separator(label), ...items] : [];
}

/**
 * Task picker (spec §3.4): tasks named by the current branch, recent tasks, tasks in progress, other
 * assigned tasks, plus lookup of any task by pasting its ID, custom ID or URL. The task being timed is
 * moved to the end of its section, so Enter usually switches to another task; it can still be first
 * when it is alone in the first section shown (e.g. no branch section and Recent holds only it).
 * Resolves with the chosen task, or `undefined` if cancelled.
 */
export function pickTask(options: TaskPickerOptions): Promise<ClickUpTask | undefined> {
  const picker = vscode.window.createQuickPick<PickItem>();
  picker.title = vscode.l10n.t('ClickUp DevTimer: Select Task');
  picker.placeholder = vscode.l10n.t('Search your tasks, or paste a task ID, custom ID or URL');
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  const refreshButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('refresh'),
    tooltip: vscode.l10n.t('Refresh task list'),
  };
  picker.buttons = [refreshButton];

  let listItems: PickItem[] = [];

  const render = () => {
    const reference = parseTaskReference(picker.value);
    const lookup: PickItem[] =
      reference === null
        ? []
        : [
            {
              label: `$(search) ${vscode.l10n.t('Look up task "{0}"', picker.value.trim())}`,
              alwaysShow: true,
              lookup: reference,
            },
          ];
    picker.items = [...lookup, ...listItems];
  };

  const load = async (force: boolean) => {
    picker.busy = true;
    try {
      const assigned = await options.loadTasks(force);
      const groups = groupTasks(assigned, options.recentTasks, options.activeStatuses, options.recentCount, {
        currentTaskId: options.currentTaskId,
        branchReferences: options.branchReferences,
      });
      const style: ItemStyle = {
        currentTaskId: options.currentTaskId,
        showStatus: true,
        showLocation: spansSeveralLists(assigned),
      };
      listItems = [
        ...section(
          vscode.l10n.t('From current branch'),
          groups.branch.map((entry) => branchItem(entry, style)),
        ),
        ...section(
          vscode.l10n.t('Recent'),
          groups.recent.map((entry) =>
            entry.task ? taskItem(entry.task, style) : refItem(entry.ref, style),
          ),
        ),
        ...section(
          vscode.l10n.t('In progress'),
          groups.active.map((task) => taskItem(task, { ...style, showStatus: false })),
        ),
        ...section(
          vscode.l10n.t('Other assigned tasks'),
          groups.others.map((task) => taskItem(task, style)),
        ),
      ];
      if (listItems.length === 0) {
        picker.placeholder = vscode.l10n.t(
          'No open tasks assigned to you. Paste a task ID, custom ID or URL',
        );
      }
      render();
    } catch (error) {
      options.onError(error);
    } finally {
      picker.busy = false;
    }
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (task: ClickUpTask | undefined) => {
      if (!settled) {
        settled = true;
        resolve(task);
        picker.dispose();
      }
    };

    picker.onDidChangeValue(render);
    picker.onDidTriggerButton((button) => {
      if (button === refreshButton) {
        void load(true);
      }
    });
    picker.onDidAccept(async () => {
      const [item] = picker.selectedItems;
      if (item?.task !== undefined) {
        finish(item.task);
        return;
      }
      const reference: TaskReference | undefined = item?.ref ? { kind: 'id', id: item.ref.id } : item?.lookup;
      if (reference === undefined) {
        return;
      }
      picker.busy = true;
      picker.enabled = false;
      try {
        finish(await options.resolve(reference));
      } catch (error) {
        options.onError(error);
        picker.busy = false;
        picker.enabled = true;
      }
    });
    picker.onDidHide(() => {
      finish(undefined);
    });

    picker.show();
    void load(false);
  });
}
