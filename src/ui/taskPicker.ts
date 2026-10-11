import * as vscode from 'vscode';
import { parseTaskReference, type TaskReference } from '../core/taskIdParser';
import { groupTasks } from '../core/taskSelection';
import type { ClickUpTask } from '../types/clickup';
import type { TaskRef } from '../types/session';

export interface TaskPickerOptions {
  loadTasks: (force: boolean) => Promise<ClickUpTask[]>;
  resolve: (reference: TaskReference) => Promise<ClickUpTask>;
  recentTasks: readonly TaskRef[];
  activeStatuses: readonly string[];
  recentCount: number;
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

function taskItem(task: ClickUpTask): PickItem {
  const location = task.folder.hidden === true ? task.list.name : `${task.folder.name} › ${task.list.name}`;
  return {
    label: task.name,
    description: `#${task.custom_id ?? task.id} · ${task.status.status}`,
    detail: location,
    task,
  };
}

function refItem(ref: TaskRef): PickItem {
  return { label: ref.name, description: `#${ref.customId ?? ref.id}`, ref };
}

/**
 * Task picker (spec §3.4): recent tasks, tasks in progress, other assigned tasks, plus lookup of any
 * task by pasting its ID, custom ID or URL. Resolves with the chosen task, or `undefined` if cancelled.
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
      const groups = groupTasks(assigned, options.recentTasks, options.activeStatuses, options.recentCount);
      listItems = [
        ...(groups.recent.length > 0 ? [separator(vscode.l10n.t('Recent'))] : []),
        ...groups.recent.map((entry) => (entry.task ? taskItem(entry.task) : refItem(entry.ref))),
        ...(groups.active.length > 0 ? [separator(vscode.l10n.t('In progress'))] : []),
        ...groups.active.map(taskItem),
        ...(groups.others.length > 0 ? [separator(vscode.l10n.t('Other assigned tasks'))] : []),
        ...groups.others.map(taskItem),
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
