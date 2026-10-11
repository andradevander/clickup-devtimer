import * as vscode from 'vscode';
import { readConfig, updateGlobalSetting, type TimerConfig } from './config';
import { Commands } from './constants';
import {
  MANUAL_PAUSE_SNOOZE_MS,
  hasDayRolledOver,
  isLongSessionWarningDue,
  isRepeatingWarningDue,
  shouldPromptManualPauseResume,
  updateActivityStreak,
  type ActivityStreak,
} from './core/idlePolicy';
import type { PreparedEntries } from './core/rounding';
import { extractTaskIdsFromBranch } from './core/taskIdParser';
import { isActiveStatus, pickTargetStatus } from './core/taskSelection';
import { formatHoursMinutes, sessionElapsed, totalDuration } from './core/timeMath';
import { ActivityWatcher } from './services/activityWatcher';
import {
  ClickUpApiError,
  ClickUpService,
  looksLikePersonalToken,
  toTaskRef,
} from './services/clickupService';
import { GitIntegration } from './services/gitIntegration';
import { SessionActiveError, StateManager } from './services/stateManager';
import { SyncQueue } from './services/syncQueue';
import { TaskRepository } from './services/taskRepository';
import { TokenStore } from './services/tokenStore';
import { WindowCoordinator } from './services/windowCoordinator';
import type { ClickUpTask, ClickUpTeam } from './types/clickup';
import type { Session, TaskRef } from './types/session';
import { askDescription, pickPendingItem, pickStatus } from './ui/prompts';
import { StatusBar, contextState, type AuthState, type TimerContextState } from './ui/statusBar';
import { pickTask } from './ui/taskPicker';

const t = vscode.l10n.t;

/** The background loop runs every second; slower work runs every N seconds. */
const REFRESH_EVERY_SECONDS = 2;
const BACKGROUND_EVERY_SECONDS = 10;

interface SessionWarnings {
  sessionId: string;
  longPauseWarnedAt: number | null;
  longSessionWarnings: number;
  dayRolloverAsked: boolean;
}

/** Wires the services to the VS Code UI and runs the background work (spec §2–§6). */
export class Controller implements vscode.Disposable {
  private readonly tokens: TokenStore;
  private readonly client: ClickUpService;
  private readonly repository: TaskRepository;
  private readonly coordinator: WindowCoordinator;
  private readonly queue: SyncQueue;
  private readonly stateManager: StateManager;
  private readonly git = new GitIntegration();
  private readonly statusBar = new StatusBar();
  private readonly disposables: vscode.Disposable[] = [];

  private auth: AuthState = 'unknown';
  private pending = 0;
  private failed = 0;
  private lastContext: { state: TimerContextState; hasSession: boolean; hasPending: boolean } | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  private seconds = 0;
  private readonly running = new Set<string>();
  private lastAutosave = Date.now();
  private lastQueueRun = 0;

  private warnings: SessionWarnings | undefined;
  private activityStreak: ActivityStreak | null = null;
  private manualPauseSnoozedUntil: number | null = null;
  private readonly openPrompts = new Set<string>();
  private readonly promptedBranches = new Set<string>();

  constructor(
    context: vscode.ExtensionContext,
    storageDirectory: string,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.tokens = new TokenStore(context.secrets);
    this.client = new ClickUpService({ getToken: () => this.tokens.get() });
    this.repository = new TaskRepository(this.client, () => readConfig().taskCacheTtlMs);
    this.coordinator = new WindowCoordinator({
      directory: storageDirectory,
      onError: (error) => {
        this.log.warn('Heartbeat failed', error);
      },
    });
    this.queue = new SyncQueue({ directory: storageDirectory, client: this.client });
    this.stateManager = new StateManager({ directory: storageDirectory, queue: this.queue });
    this.disposables.push(this.statusBar, this.git, this.queue, this.stateManager, this.coordinator);
  }

  async activate(): Promise<void> {
    this.registerCommands();
    this.auth = (await this.tokens.get()) ? 'unknown' : 'missing';

    this.disposables.push(
      new ActivityWatcher((at) => {
        this.onLocalActivity(at);
      }),
      this.stateManager.onDidChange(() => {
        this.render();
      }),
      this.queue.onDidChange(() => {
        void this.guard('pending', () => this.refreshPending());
      }),
      this.tokens.onDidChange(() => {
        void this.guard('token', () => this.onTokenChanged());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('clickupDevTimer')) {
          this.repository.invalidate();
          this.render();
        }
      }),
      this.git.onDidChangeBranch(({ branch }) => {
        void this.guard(`branch:${branch}`, () => this.checkBranch(branch));
      }),
    );

    await this.stateManager.refresh();
    await this.refreshPending();
    this.render();

    await this.recoverSession();
    this.coordinator.start();
    this.timer = setInterval(() => {
      this.onSecond();
    }, 1000);

    if (this.auth !== 'missing') {
      void this.guard('validateToken', () => this.validateStoredToken());
    }
    void this.guard('git', async () => {
      await this.git.initialize();
      const branch = this.git.currentBranch();
      if (branch !== undefined) {
        await this.checkBranch(branch);
      }
    });
  }

  /** Saves the latest activity and releases the lock; VS Code awaits this on shutdown. */
  async shutdown(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      if (this.coordinator.isOwner) {
        await this.stateManager.autosave(await this.coordinator.latestActivity());
      }
      await this.coordinator.shutdown();
    } catch (error) {
      this.log.warn('Shutdown cleanup failed', error);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------

  private registerCommands(): void {
    const register = (command: string, handler: () => Promise<unknown>) => {
      this.disposables.push(
        vscode.commands.registerCommand(command, () => this.runCommand(command, handler)),
      );
    };
    register(Commands.setToken, () => this.setToken());
    register(Commands.clearToken, () => this.clearToken());
    register(Commands.selectWorkspace, () => this.selectWorkspace());
    register(Commands.selectTask, () => this.selectTask());
    register(Commands.showMenu, () => this.showMenu());
    register(Commands.pauseTimer, () => this.pause());
    register(Commands.resumeTimer, () => this.resume());
    register(Commands.syncTime, () => this.finish());
    register(Commands.switchTask, () => this.selectTask());
    register(Commands.discardTime, () => this.discard());
    register(Commands.openInBrowser, () => this.openInBrowser());
    register(Commands.showPendingSync, () => this.showPendingSync());
    register(Commands.refreshTasks, () => this.refreshTasks());
  }

  private async runCommand(command: string, handler: () => Promise<unknown>): Promise<void> {
    try {
      await handler();
    } catch (error) {
      this.handleError(error, command);
    }
  }

  private async setToken(): Promise<boolean> {
    const token = await vscode.window.showInputBox({
      title: t('ClickUp DevTimer: Set Personal Token'),
      prompt: t('Paste your ClickUp Personal Token (Settings › Apps › API Token).'),
      placeHolder: 'pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXX',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        looksLikePersonalToken(value) ? undefined : t('ClickUp Personal Tokens start with "pk_".'),
    });
    if (token === undefined) {
      return false;
    }

    const probe = new ClickUpService({ getToken: () => Promise.resolve(token) });
    let username: string;
    let teams: ClickUpTeam[];
    try {
      ({ username, teams } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('Validating token with ClickUp…') },
        async () => ({ username: (await probe.getUser()).username, teams: await probe.getTeams() }),
      ));
    } catch (error) {
      if (error instanceof ClickUpApiError && error.kind === 'unauthorized') {
        void vscode.window.showErrorMessage(t('ClickUp rejected this token. Check it and try again.'));
        return false;
      }
      throw error;
    }

    await this.tokens.set(token);
    this.auth = 'valid';
    this.repository.invalidate(true);
    this.render();

    const teamId = readConfig().teamId;
    if (!teams.some((team) => team.id === teamId)) {
      await this.chooseTeam(teams);
    }
    void vscode.window.showInformationMessage(t('Connected to ClickUp as {0}.', username));
    void this.guard('queue', () => this.processQueue());
    return true;
  }

  private async clearToken(): Promise<void> {
    const confirm = t('Sign Out');
    const choice = await vscode.window.showWarningMessage(
      t('Remove the ClickUp Personal Token from this editor?'),
      { modal: true },
      confirm,
    );
    if (choice !== confirm) {
      return;
    }
    await this.tokens.clear();
    this.auth = 'missing';
    this.repository.invalidate(true);
    this.render();
  }

  private async selectWorkspace(): Promise<boolean> {
    if (!(await this.ensureToken())) {
      return false;
    }
    return this.chooseTeam(await this.client.getTeams());
  }

  private async chooseTeam(teams: readonly ClickUpTeam[]): Promise<boolean> {
    let team: ClickUpTeam | undefined;
    if (teams.length === 1) {
      team = teams[0];
    } else if (teams.length > 1) {
      const current = readConfig().teamId;
      const picked = await vscode.window.showQuickPick(
        teams.map((item) => ({
          label: item.name,
          description: item.id === current ? t('Current') : item.id,
          team: item,
        })),
        {
          title: t('ClickUp DevTimer: Select Workspace'),
          placeHolder: t('Which ClickUp Workspace do you track time in?'),
        },
      );
      team = picked?.team;
    } else {
      void vscode.window.showWarningMessage(t('This ClickUp account has no Workspaces.'));
    }
    if (team === undefined) {
      return false;
    }
    await updateGlobalSetting('teamId', team.id);
    this.repository.invalidate();
    return true;
  }

  /** Makes sure a token and a Workspace are configured, asking for them if needed. */
  private async ensureReady(): Promise<string | undefined> {
    if (!(await this.ensureToken())) {
      return undefined;
    }
    let teamId = readConfig().teamId;
    if (!teamId) {
      if (!(await this.selectWorkspace())) {
        return undefined;
      }
      teamId = readConfig().teamId;
    }
    return teamId || undefined;
  }

  private async ensureToken(): Promise<boolean> {
    if (this.auth === 'missing' || this.auth === 'invalid' || !(await this.tokens.get())) {
      return this.setToken();
    }
    return true;
  }

  private async selectTask(): Promise<void> {
    const teamId = await this.ensureReady();
    if (teamId === undefined) {
      return;
    }
    const config = readConfig();
    const task = await pickTask({
      loadTasks: async (force) => {
        const tasks = await this.repository.assignedTasks(teamId, force);
        this.onApiSuccess();
        return tasks;
      },
      resolve: (reference) => this.repository.resolve(reference, teamId),
      recentTasks: this.stateManager.state.recentTasks,
      activeStatuses: config.activeStatuses,
      recentCount: config.recentTasksCount,
      onError: (error) => {
        this.handleError(error, 'selectTask');
      },
    });
    if (task !== undefined) {
      await this.startOrSwitch(task);
    }
  }

  private async startOrSwitch(task: ClickUpTask): Promise<void> {
    const ref = toTaskRef(task);
    const current = (await this.stateManager.refresh()).session;

    if (current?.task.id === ref.id) {
      if (current.status !== 'running') {
        await this.stateManager.resume();
      }
      return;
    }

    if (current === null) {
      try {
        await this.stateManager.start(ref);
      } catch (error) {
        // Another window started a session in the meantime: switch instead.
        if (!(error instanceof SessionActiveError)) {
          throw error;
        }
        await this.switchTo(ref, (await this.stateManager.refresh()).session);
      }
    } else {
      await this.switchTo(ref, current);
    }

    void this.guard('statusOnStart', () => this.suggestStatusOnStart(task));
  }

  private async switchTo(ref: TaskRef, current: Session | null): Promise<void> {
    const config = readConfig();
    const description = current ? await this.describe(config) : '';
    const { finished } = await this.stateManager.switchTask(ref, description, config.entryPolicy);
    if (current !== null) {
      this.reportFinished(finished, current.task);
      void this.guard('queue', () => this.processQueue());
    }
  }

  private async pause(): Promise<void> {
    await this.stateManager.pause();
  }

  private async resume(): Promise<void> {
    this.activityStreak = null;
    await this.stateManager.resume();
  }

  private async finish(): Promise<void> {
    const session = (await this.stateManager.refresh()).session;
    if (session === null) {
      void vscode.window.showInformationMessage(t('There is no active timer.'));
      return;
    }
    const config = readConfig();
    const description = await this.describe(config);
    const prepared = await this.stateManager.finish(description, config.entryPolicy);
    this.reportFinished(prepared, session.task);
    void this.guard('queue', () => this.processQueue());
    if (prepared?.kind === 'entries') {
      void this.guard('statusOnFinish', () => this.suggestStatusOnFinish(session.task));
    }
  }

  private async discard(): Promise<void> {
    const session = (await this.stateManager.refresh()).session;
    if (session === null) {
      return;
    }
    const confirm = t('Discard');
    const choice = await vscode.window.showWarningMessage(
      t(
        'Discard {0} tracked on "{1}"? This cannot be undone.',
        formatHoursMinutes(sessionElapsed(session, Date.now())),
        session.task.name,
      ),
      { modal: true },
      confirm,
    );
    if (choice === confirm) {
      await this.stateManager.discard();
    }
  }

  private async openInBrowser(): Promise<void> {
    const session = (await this.stateManager.refresh()).session;
    if (session !== null) {
      await vscode.env.openExternal(vscode.Uri.parse(session.task.url));
    }
  }

  private async showMenu(): Promise<void> {
    if (this.auth === 'missing' || this.auth === 'invalid') {
      await this.setToken();
      return;
    }
    const session = (await this.stateManager.refresh()).session;
    if (session === null) {
      await this.selectTask();
      return;
    }

    type MenuItem = vscode.QuickPickItem & { run: () => Promise<void> };
    const items: MenuItem[] = [
      session.status === 'running'
        ? { label: `$(debug-pause) ${t('Pause Timer')}`, run: () => this.pause() }
        : { label: `$(play) ${t('Resume Timer')}`, run: () => this.resume() },
      { label: `$(cloud-upload) ${t('Stop & Sync Time to ClickUp')}`, run: () => this.finish() },
      { label: `$(arrow-swap) ${t('Switch Task')}`, run: () => this.selectTask() },
      { label: `$(link-external) ${t('Open Task in Browser')}`, run: () => this.openInBrowser() },
      { label: `$(trash) ${t('Discard Current Time')}`, run: () => this.discard() },
      ...(this.pending > 0
        ? [
            {
              label: `$(cloud) ${t('Show Pending Sync')}`,
              description: String(this.pending),
              run: () => this.showPendingSync(),
            },
          ]
        : []),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `${session.task.name} · ${formatHoursMinutes(sessionElapsed(session, Date.now()))}`,
      placeHolder: t('What do you want to do?'),
    });
    await picked?.run();
  }

  private async showPendingSync(): Promise<void> {
    const items = await this.queue.items();
    if (items.length === 0) {
      void vscode.window.showInformationMessage(t('All time entries are synced.'));
      return;
    }
    const action = await pickPendingItem(items);
    if (action === undefined) {
      return;
    }
    if (action.kind === 'retryAll') {
      await this.queue.retryAll();
      await this.processQueue(true);
      return;
    }

    const { item } = action;
    const retry = t('Retry now');
    const open = t('Open task in browser');
    const discard = t('Discard entry');
    const choice = await vscode.window.showQuickPick([retry, open, discard], {
      placeHolder: `${item.taskName} · ${formatHoursMinutes(item.duration)}`,
    });
    if (choice === retry) {
      await this.queue.retry(item.id);
      await this.processQueue(true);
    } else if (choice === open) {
      await vscode.env.openExternal(
        vscode.Uri.parse(`https://app.clickup.com/t/${encodeURIComponent(item.taskId)}`),
      );
    } else if (choice === discard) {
      const confirm = t('Discard');
      const sure = await vscode.window.showWarningMessage(
        t(
          'Discard {0} of time for "{1}" without syncing it?',
          formatHoursMinutes(item.duration),
          item.taskName,
        ),
        { modal: true },
        confirm,
      );
      if (sure === confirm) {
        await this.queue.discard(item.id);
      }
    }
  }

  private async refreshTasks(): Promise<void> {
    const teamId = await this.ensureReady();
    if (teamId === undefined) {
      return;
    }
    this.repository.invalidate();
    const tasks = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t('Loading ClickUp tasks…') },
      () => this.repository.assignedTasks(teamId, true),
    );
    this.onApiSuccess();
    vscode.window.setStatusBarMessage(`$(check) ${t('{0} tasks loaded from ClickUp.', tasks.length)}`, 4000);
  }

  // ---------------------------------------------------------------------------------------------
  // Finishing and status suggestions
  // ---------------------------------------------------------------------------------------------

  private async describe(config: TimerConfig): Promise<string> {
    const branch = this.git.currentBranch();
    return config.askDescriptionOnFinish
      ? askDescription(branch, config.defaultDescription)
      : (branch ?? config.defaultDescription);
  }

  private reportFinished(prepared: PreparedEntries | undefined, task: TaskRef): void {
    if (prepared === undefined) {
      return;
    }
    if (prepared.kind === 'entries') {
      vscode.window.setStatusBarMessage(
        `$(cloud-upload) ${t('{0} queued for "{1}".', formatHoursMinutes(prepared.roundedMs), task.name)}`,
        5000,
      );
    } else if (prepared.reason === 'belowMinimum') {
      void vscode.window.showInformationMessage(
        t('The session on "{0}" was shorter than the minimum duration and was discarded.', task.name),
      );
    } else {
      void vscode.window.showInformationMessage(
        t(
          'The session on "{0}" ({1}) rounded down to zero and was discarded.',
          task.name,
          formatHoursMinutes(prepared.trackedMs),
        ),
      );
    }
  }

  private async suggestStatusOnStart(task: ClickUpTask): Promise<void> {
    const config = readConfig();
    if (!config.suggestStatusChange || isActiveStatus(task.status.status, config.activeStatuses)) {
      return;
    }
    const list = await this.repository.list(task.list.id);
    const target = pickTargetStatus(list.statuses, config.activeStatuses);
    const move = target ? t('Move to "{0}"', target) : undefined;
    const choose = t('Choose status…');
    const neverAsk = t("Don't ask again");
    const choice = await vscode.window.showInformationMessage(
      t('"{0}" is in "{1}". Move it to an in-progress status?', task.name, task.status.status),
      ...[move, choose, neverAsk].filter((item): item is string => item !== undefined),
    );
    let status: string | undefined;
    if (choice !== undefined && choice === move) {
      status = target;
    } else if (choice === choose) {
      status = await pickStatus(list.statuses, task.status.status, t('New status for "{0}"', task.name));
    } else if (choice === neverAsk) {
      await updateGlobalSetting('suggestStatusChange', false);
    }
    if (status !== undefined && status !== task.status.status) {
      await this.client.updateTaskStatus(task.id, status);
      this.repository.invalidate();
      vscode.window.setStatusBarMessage(`$(check) ${t('Status changed to "{0}".', status)}`, 4000);
    }
  }

  private async suggestStatusOnFinish(ref: TaskRef): Promise<void> {
    const config = readConfig();
    if (!config.suggestStatusChange) {
      return;
    }
    const task = await this.repository.resolve({ kind: 'id', id: ref.id }, ref.teamId);
    if (!isActiveStatus(task.status.status, config.activeStatuses)) {
      return;
    }
    const list = await this.repository.list(task.list.id);
    const status = await pickStatus(
      list.statuses,
      task.status.status,
      t('Update the status of "{0}"? (Esc keeps "{1}")', task.name, task.status.status),
    );
    if (status !== undefined && status.toLowerCase() !== task.status.status.toLowerCase()) {
      await this.client.updateTaskStatus(task.id, status);
      this.repository.invalidate();
      vscode.window.setStatusBarMessage(`$(check) ${t('Status changed to "{0}".', status)}`, 4000);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Background work
  // ---------------------------------------------------------------------------------------------

  private onSecond(): void {
    this.seconds++;
    this.render();
    if (this.seconds % REFRESH_EVERY_SECONDS === 0) {
      void this.guard('refresh', async () => {
        await this.stateManager.refresh();
        await this.refreshPending();
      });
    }
    if (this.seconds % BACKGROUND_EVERY_SECONDS === 0 && this.coordinator.isOwner) {
      void this.guard('background', () => this.backgroundWork());
    }
  }

  /** Work done only by the owner window (spec §2.2-E). */
  private async backgroundWork(): Promise<void> {
    const config = readConfig();
    const now = Date.now();
    const latest = await this.coordinator.latestActivity();

    const event = await this.stateManager.tick(latest, config.inactivityThresholdMs);
    if (event?.kind === 'idlePaused') {
      vscode.window.setStatusBarMessage(`$(history) ${t('Timer paused due to inactivity.')}`, 8000);
    } else if (event?.kind === 'idleResumed') {
      vscode.window.setStatusBarMessage(
        `$(play-circle) ${t('Timer resumed after {0} of inactivity.', formatHoursMinutes(event.awayMs))}`,
        8000,
      );
    }

    if (now - this.lastAutosave >= config.autoSaveIntervalMs) {
      this.lastAutosave = now;
      await this.stateManager.autosave(latest);
    }
    if (now - this.lastQueueRun >= config.syncRetryIntervalMs) {
      await this.processQueue();
    }
    this.checkWarnings(config, now);
  }

  private checkWarnings(config: TimerConfig, now: number): void {
    const session = this.stateManager.session;
    if (session === null) {
      this.warnings = undefined;
      return;
    }
    if (this.warnings?.sessionId !== session.id) {
      this.warnings = {
        sessionId: session.id,
        longPauseWarnedAt: null,
        longSessionWarnings: 0,
        dayRolloverAsked: false,
      };
    }
    const warnings = this.warnings;
    const name = session.task.name;

    if (session.pausedAt !== null && !warnings.dayRolloverAsked && hasDayRolledOver(session.pausedAt, now)) {
      warnings.dayRolloverAsked = true;
      void this.prompt('dayRollover', async () => {
        const finish = t('Finish & sync');
        const choice = await vscode.window.showInformationMessage(
          t('The timer on "{0}" has been paused since yesterday. Finish and sync it?', name),
          finish,
          t('Keep'),
        );
        if (choice === finish) {
          await this.finish();
        }
      });
      return;
    }

    if (
      session.status === 'pausedManual' &&
      session.pausedAt !== null &&
      isRepeatingWarningDue(session.pausedAt, now, warnings.longPauseWarnedAt, config.longPauseWarningMs)
    ) {
      warnings.longPauseWarnedAt = now;
      void this.prompt('longPause', async () => {
        const resume = t('Resume');
        const finish = t('Finish & sync');
        const discard = t('Discard');
        const choice = await vscode.window.showInformationMessage(
          t(
            'The timer on "{0}" has been paused for {1}. What do you want to do?',
            name,
            formatHoursMinutes(now - (session.pausedAt ?? now)),
          ),
          resume,
          finish,
          discard,
        );
        if (choice === resume) {
          await this.resume();
        } else if (choice === finish) {
          await this.finish();
        } else if (choice === discard) {
          await this.discard();
        }
      });
    }

    if (
      session.status === 'running' &&
      isLongSessionWarningDue(
        sessionElapsed(session, now),
        config.longSessionWarningMs,
        warnings.longSessionWarnings,
      )
    ) {
      warnings.longSessionWarnings++;
      void this.prompt('longSession', async () => {
        const finish = t('Finish & sync');
        const choice = await vscode.window.showInformationMessage(
          t(
            'You have been tracking "{0}" for {1}.',
            name,
            formatHoursMinutes(sessionElapsed(session, Date.now())),
          ),
          t('OK'),
          finish,
        );
        if (choice === finish) {
          await this.finish();
        }
      });
    }
  }

  /** Activity in this window: shared with the other windows, and used for the "still on a break?" prompt. */
  private onLocalActivity(at: number): void {
    void this.guard('activity', () => this.coordinator.reportActivity(at));

    const session = this.stateManager.session;
    if (session?.status !== 'pausedManual') {
      this.activityStreak = null;
      return;
    }
    this.activityStreak = updateActivityStreak(this.activityStreak, at);
    if (shouldPromptManualPauseResume(this.activityStreak, at, this.manualPauseSnoozedUntil)) {
      this.activityStreak = null;
      void this.prompt('manualPause', async () => {
        const resume = t('Resume');
        const keep = t('Keep paused');
        const choice = await vscode.window.showInformationMessage(
          t('We noticed activity in the editor. Are you still on a break?'),
          resume,
          keep,
        );
        if (choice === resume) {
          await this.resume();
        } else {
          this.manualPauseSnoozedUntil = Date.now() + MANUAL_PAUSE_SNOOZE_MS;
        }
      });
    }
  }

  private async processQueue(reportFailures = false): Promise<void> {
    this.lastQueueRun = Date.now();
    if ((await this.queue.items()).length === 0) {
      return;
    }
    const result = await this.queue.process();
    if (result.authError) {
      this.auth = (await this.tokens.get()) ? 'invalid' : 'missing';
      this.render();
      return;
    }
    if (result.synced > 0) {
      this.onApiSuccess(false);
      vscode.window.setStatusBarMessage(
        `$(check) ${t('{0} time entries synced to ClickUp.', result.synced)}`,
        5000,
      );
    }
    if (result.failed > 0 || (reportFailures && result.remaining > 0)) {
      void this.prompt('syncFailed', async () => {
        const show = t('Show Pending Sync');
        const choice = await vscode.window.showWarningMessage(
          t('{0} time entries could not be synced to ClickUp yet.', result.remaining),
          show,
        );
        if (choice === show) {
          await this.showPendingSync();
        }
      });
    }
    await this.refreshPending();
  }

  /** A successful API call means the token works and the network is up: flush the queue. */
  private onApiSuccess(processQueue = true): void {
    if (this.auth !== 'valid') {
      this.auth = 'valid';
      this.render();
    }
    if (processQueue && this.pending > 0) {
      void this.guard('queue', () => this.processQueue());
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Startup: recovery, token validation, branch detection
  // ---------------------------------------------------------------------------------------------

  private async recoverSession(): Promise<void> {
    if (await this.coordinator.isLockedByAnotherWindow()) {
      // Another window is tracking the session right now.
      return;
    }
    const result = await this.stateManager.recover();
    if (result.kind === 'alreadyQueued') {
      this.log.info('Cleared a session that had already been queued before the editor stopped.');
      return;
    }
    if (result.kind !== 'recovered') {
      return;
    }
    const { session } = result;
    const gap = Date.now() - (session.pausedAt ?? Date.now());
    if (gap <= readConfig().inactivityThresholdMs) {
      // A window reload or a quick restart: keep counting without bothering the user.
      await this.stateManager.resume();
      return;
    }
    void this.prompt('recovery', async () => {
      const send = t('Send');
      const keep = t('Keep counting');
      const discard = t('Discard');
      const choice = await vscode.window.showWarningMessage(
        t(
          'Found {0} not yet synced on "{1}". What do you want to do?',
          formatHoursMinutes(totalDuration(session.segments)),
          session.task.name,
        ),
        send,
        keep,
        discard,
      );
      if (choice === send) {
        await this.finish();
      } else if (choice === keep) {
        await this.resume();
      } else if (choice === discard) {
        await this.stateManager.discard();
      }
    });
  }

  private async validateStoredToken(): Promise<void> {
    try {
      await this.repository.currentUser();
      this.onApiSuccess();
    } catch (error) {
      if (error instanceof ClickUpApiError && (error.kind === 'unauthorized' || error.kind === 'noToken')) {
        this.auth = error.kind === 'noToken' ? 'missing' : 'invalid';
        this.render();
      } else {
        this.log.warn('Could not validate the token at startup', error);
      }
    }
  }

  private async onTokenChanged(): Promise<void> {
    this.repository.invalidate(true);
    this.auth = (await this.tokens.get()) ? 'unknown' : 'missing';
    this.render();
    if (this.auth === 'unknown') {
      await this.validateStoredToken();
    }
  }

  /** Suggests starting or switching the timer when the branch names a ClickUp task (spec §3.9). */
  private async checkBranch(branch: string): Promise<void> {
    const config = readConfig();
    if (
      !config.branchDetectionEnabled ||
      !config.teamId ||
      this.auth === 'missing' ||
      this.auth === 'invalid' ||
      this.promptedBranches.has(branch) ||
      this.stateManager.state.ignoredBranches.includes(branch)
    ) {
      return;
    }
    this.promptedBranches.add(branch);

    const { references, invalidPatterns } = extractTaskIdsFromBranch(branch, config.branchPatterns);
    for (const pattern of invalidPatterns) {
      this.log.warn(`Ignoring invalid branch pattern: ${pattern}`);
    }
    let task: ClickUpTask | undefined;
    for (const reference of references) {
      try {
        task = await this.repository.resolve(reference, config.teamId);
        break;
      } catch (error) {
        if (!(
          error instanceof ClickUpApiError &&
          (error.kind === 'notFound' || error.kind === 'forbidden')
        )) {
          throw error;
        }
      }
    }
    if (task === undefined) {
      return;
    }
    const found = task;
    const session = this.stateManager.session;
    if (session?.task.id === found.id) {
      return;
    }

    if (session === null) {
      const start = t('Start timer');
      const neverAsk = t("Don't ask for this branch");
      const choice = await vscode.window.showInformationMessage(
        t('Branch "{0}" refers to "{1}". Start the timer?', branch, found.name),
        start,
        t('Ignore'),
        neverAsk,
      );
      if (choice === start) {
        await this.startOrSwitch(found);
      } else if (choice === neverAsk) {
        await this.stateManager.ignoreBranch(branch);
      }
    } else {
      const switchTask = t('Switch');
      const choice = await vscode.window.showInformationMessage(
        t('Branch "{0}" refers to "{1}". Switch the timer to this task?', branch, found.name),
        switchTask,
        t('Keep current'),
      );
      if (choice === switchTask) {
        await this.startOrSwitch(found);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private render(): void {
    const config = readConfig();
    const state = this.stateManager.state;
    this.statusBar.render({
      auth: this.auth,
      state,
      now: Date.now(),
      pending: this.pending,
      failed: this.failed,
      maxTaskNameLength: config.maxTaskNameLength,
    });
    const next = {
      state: contextState(this.auth, state),
      hasSession: state.session !== null,
      hasPending: this.pending > 0,
    };
    if (
      this.lastContext?.state !== next.state ||
      this.lastContext.hasSession !== next.hasSession ||
      this.lastContext.hasPending !== next.hasPending
    ) {
      this.lastContext = next;
      void vscode.commands.executeCommand('setContext', 'clickupDevTimer.state', next.state);
      void vscode.commands.executeCommand('setContext', 'clickupDevTimer.hasSession', next.hasSession);
      void vscode.commands.executeCommand('setContext', 'clickupDevTimer.hasPending', next.hasPending);
    }
  }

  private async refreshPending(): Promise<void> {
    const items = await this.queue.items();
    const pending = items.length;
    const failed = items.filter((item) => item.status === 'failed').length;
    if (pending !== this.pending || failed !== this.failed) {
      this.pending = pending;
      this.failed = failed;
      this.render();
    }
  }

  /** Runs background work, skipping it while the previous run with the same key is still going. */
  private async guard(key: string, work: () => Promise<unknown>): Promise<void> {
    if (this.running.has(key)) {
      return;
    }
    this.running.add(key);
    try {
      await work();
    } catch (error) {
      this.log.error(`Background task "${key}" failed`, error);
      if (error instanceof ClickUpApiError && error.kind === 'unauthorized') {
        this.auth = 'invalid';
        this.render();
      }
    } finally {
      this.running.delete(key);
    }
  }

  /** Shows at most one prompt of each kind at a time. */
  private async prompt(key: string, show: () => Promise<void>): Promise<void> {
    if (this.openPrompts.has(key)) {
      return;
    }
    this.openPrompts.add(key);
    try {
      await show();
    } catch (error) {
      this.handleError(error, key);
    } finally {
      this.openPrompts.delete(key);
    }
  }

  private handleError(error: unknown, context: string): void {
    this.log.error(`${context} failed`, error);
    if (!(error instanceof ClickUpApiError)) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(t('ClickUp DevTimer: unexpected error: {0}', detail));
      return;
    }
    switch (error.kind) {
      case 'noToken':
      case 'unauthorized': {
        this.auth = error.kind === 'noToken' ? 'missing' : 'invalid';
        this.render();
        const setToken = t('Set Token');
        void vscode.window
          .showErrorMessage(t('ClickUp rejected the Personal Token. Set a new token to continue.'), setToken)
          .then((choice) =>
            choice === setToken ? vscode.commands.executeCommand(Commands.setToken) : undefined,
          );
        break;
      }
      case 'network':
      case 'timeout':
        void vscode.window.showWarningMessage(
          t('Could not reach ClickUp. Check your connection and try again.'),
        );
        break;
      case 'rateLimited':
        void vscode.window.showWarningMessage(t('ClickUp rate limit reached. Try again in a minute.'));
        break;
      case 'notFound':
        void vscode.window.showWarningMessage(
          t('Task not found in ClickUp, or you do not have access to it.'),
        );
        break;
      case 'forbidden':
        void vscode.window.showWarningMessage(t('You do not have permission for this in ClickUp.'));
        break;
      case 'server':
        void vscode.window.showWarningMessage(
          t('ClickUp is having problems right now ({0}). Try again later.', error.status ?? '?'),
        );
        break;
      case 'client':
        void vscode.window.showErrorMessage(t('ClickUp request failed: {0}', error.message));
        break;
    }
  }
}
