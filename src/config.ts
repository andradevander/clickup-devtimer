import * as vscode from 'vscode';
import { CONFIG_SECTION } from './constants';
import type { EntryPolicy, RoundingMode } from './core/rounding';
import { minutesToMs, secondsToMs } from './core/timeMath';

export interface TimerConfig {
  teamId: string;
  activeStatuses: string[];
  inactivityThresholdMs: number;
  autoSaveIntervalMs: number;
  entryPolicy: EntryPolicy;
  askDescriptionOnFinish: boolean;
  defaultDescription: string;
  longPauseWarningMs: number;
  longSessionWarningMs: number;
  suggestStatusChange: boolean;
  branchDetectionEnabled: boolean;
  branchPatterns: string[];
  recentTasksCount: number;
  taskCacheTtlMs: number;
  syncRetryIntervalMs: number;
  maxTaskNameLength: number;
}

/** Reads the settings, clamping values to the minimums declared in package.json. */
export function readConfig(): TimerConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const num = (key: string, fallback: number, min: number) => {
    const value = config.get<number>(key, fallback);
    return Number.isFinite(value) ? Math.max(min, value) : fallback;
  };
  const strings = (key: string, fallback: string[]) => {
    const value = config.get<unknown>(key, fallback);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback;
  };
  const inactivityThresholdSeconds = num('inactivityThresholdSeconds', 120, 30);
  const roundingMode = config.get<RoundingMode>('roundingMode', 'nearest');

  return {
    teamId: config.get<string>('teamId', '').trim(),
    activeStatuses: strings('activeStatuses', ['in progress', 'doing', 'in dev']),
    inactivityThresholdMs: secondsToMs(inactivityThresholdSeconds),
    autoSaveIntervalMs: secondsToMs(num('autoSaveIntervalSeconds', 60, 10)),
    entryPolicy: {
      minimumEntrySeconds: num('minimumEntrySeconds', 60, 0),
      roundingMinutes: num('roundingMinutes', 5, 0),
      roundingMode: ['nearest', 'up', 'down'].includes(roundingMode) ? roundingMode : 'nearest',
      inactivityThresholdSeconds,
    },
    askDescriptionOnFinish: config.get<boolean>('askDescriptionOnFinish', true),
    defaultDescription: config.get<string>('defaultDescription', 'Logged via ClickUp DevTimer (VS Code)'),
    longPauseWarningMs: minutesToMs(num('longPauseWarningMinutes', 60, 0)),
    longSessionWarningMs: minutesToMs(num('longSessionWarningMinutes', 240, 0)),
    suggestStatusChange: config.get<boolean>('suggestStatusChange', true),
    branchDetectionEnabled: config.get<boolean>('branchDetection.enabled', true),
    branchPatterns: strings('branchDetection.patterns', ['CU-([a-z0-9]+)', '([A-Z][A-Z0-9]+-\\d+)']),
    recentTasksCount: num('recentTasksCount', 5, 0),
    taskCacheTtlMs: minutesToMs(num('taskCacheTtlMinutes', 5, 0)),
    syncRetryIntervalMs: minutesToMs(num('syncRetryIntervalMinutes', 5, 1)),
    maxTaskNameLength: num('statusBar.maxTaskNameLength', 30, 0),
  };
}

export async function updateGlobalSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(key, value, vscode.ConfigurationTarget.Global);
}
