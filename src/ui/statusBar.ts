import * as vscode from 'vscode';
import { Commands } from '../constants';
import { finalSegments } from '../core/stateMachine';
import { truncate } from '../core/taskSelection';
import {
  durationWithin,
  formatDuration,
  formatHoursMinutes,
  localDayKey,
  sessionElapsed,
  startOfLocalDay,
} from '../core/timeMath';
import type { PersistedState } from '../types/session';

export type AuthState = 'missing' | 'invalid' | 'unknown' | 'valid';

/** Value of the `clickupDevTimer.state` context key. */
export type TimerContextState =
  'notConfigured' | 'invalidToken' | 'idle' | 'running' | 'pausedManual' | 'pausedIdle';

export interface StatusBarInput {
  auth: AuthState;
  state: PersistedState;
  now: number;
  pending: number;
  failed: number;
  maxTaskNameLength: number;
}

export function contextState(auth: AuthState, state: PersistedState): TimerContextState {
  if (auth === 'missing') {
    return 'notConfigured';
  }
  if (auth === 'invalid') {
    return 'invalidToken';
  }
  return state.session?.status ?? 'idle';
}

/** Time finished today plus the part of the current session tracked today. */
export function todayTotal(state: PersistedState, now: number): number {
  const finished = state.dailyTotals[localDayKey(now)] ?? 0;
  const current = state.session
    ? durationWithin(finalSegments(state.session, now), startOfLocalDay(now), now)
    : 0;
  return finished + current;
}

/** The timer item in the status bar (spec §3.2). Clicking it always opens the context-aware menu. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'clickupDevTimer.timer',
    vscode.StatusBarAlignment.Left,
    50,
  );

  constructor() {
    this.item.name = 'ClickUp DevTimer';
    this.item.command = Commands.showMenu;
    this.item.show();
  }

  render(input: StatusBarInput): void {
    const { auth, state, now } = input;
    const session = state.session;
    let text: string;
    let background: vscode.ThemeColor | undefined;
    let color: vscode.ThemeColor | undefined;

    if (auth === 'missing') {
      text = `$(key) ${vscode.l10n.t('ClickUp: Set Token')}`;
      background = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (auth === 'invalid') {
      text = `$(error) ${vscode.l10n.t('ClickUp: Invalid Token')}`;
      background = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (session === null) {
      text = `$(list-selection) ${vscode.l10n.t('ClickUp: Select Task')}`;
    } else {
      const elapsed = formatDuration(sessionElapsed(session, now));
      const name = truncate(session.task.name, input.maxTaskNameLength);
      switch (session.status) {
        case 'running':
          text = `$(play-circle) ${elapsed}${name ? ` · ${name}` : ''}`;
          color = new vscode.ThemeColor('charts.green');
          break;
        case 'pausedManual':
          text = `$(debug-pause) ${elapsed} (${vscode.l10n.t('Paused')})`;
          background = new vscode.ThemeColor('statusBarItem.warningBackground');
          break;
        case 'pausedIdle':
          text = `$(history) ${elapsed} (${vscode.l10n.t('Idle')})`;
          color = new vscode.ThemeColor('charts.orange');
          break;
      }
    }

    if (input.failed > 0) {
      text += ` $(warning) ${String(input.pending)}`;
      background = new vscode.ThemeColor('statusBarItem.errorBackground');
      color = undefined;
    } else if (input.pending > 0) {
      text += ` $(cloud-upload) ${String(input.pending)}`;
    }

    this.item.text = text;
    this.item.backgroundColor = background;
    this.item.color = color;
    this.item.tooltip = this.tooltip(input);
  }

  dispose(): void {
    this.item.dispose();
  }

  private tooltip(input: StatusBarInput): vscode.MarkdownString {
    const { state, now } = input;
    const session = state.session;
    const lines: string[] = ['**ClickUp DevTimer**', ''];

    if (input.auth === 'missing') {
      lines.push(vscode.l10n.t('Click to set your ClickUp Personal Token.'));
    } else if (input.auth === 'invalid') {
      lines.push(vscode.l10n.t('ClickUp rejected the Personal Token. Click to set a new one.'));
    } else if (session === null) {
      lines.push(vscode.l10n.t('No active timer. Click to select a task.'));
    } else {
      const id = session.task.customId ?? session.task.id;
      lines.push(
        `[${escapeMarkdown(session.task.name)}](${session.task.url}) \`#${id}\``,
        '',
        `${vscode.l10n.t('This session')}: **${formatDuration(sessionElapsed(session, now))}**`,
      );
    }
    if (input.auth !== 'missing') {
      lines.push('', `${vscode.l10n.t('Today')}: **${formatHoursMinutes(todayTotal(state, now))}**`);
    }
    if (input.pending > 0) {
      lines.push(
        '',
        input.failed > 0
          ? vscode.l10n.t('{0} time entries waiting to sync ({1} failed).', input.pending, input.failed)
          : vscode.l10n.t('{0} time entries waiting to sync.', input.pending),
      );
    }

    const markdown = new vscode.MarkdownString(lines.join('\n\n'), true);
    markdown.isTrusted = false;
    return markdown;
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
