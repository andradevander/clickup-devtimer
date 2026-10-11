export const EXTENSION_ID = 'andradevander.clickup-devtimer';
export const CONFIG_SECTION = 'clickupDevTimer';

export const STORAGE_DIRECTORY_NAME = '.clickup-devtimer';

export const CLICKUP_API_BASE_URL = 'https://api.clickup.com/api/v2';

export const Commands = {
  setToken: 'clickupDevTimer.setToken',
  clearToken: 'clickupDevTimer.clearToken',
  selectWorkspace: 'clickupDevTimer.selectWorkspace',
  selectTask: 'clickupDevTimer.selectTask',
  showMenu: 'clickupDevTimer.showMenu',
  pauseTimer: 'clickupDevTimer.pauseTimer',
  resumeTimer: 'clickupDevTimer.resumeTimer',
  syncTime: 'clickupDevTimer.syncTime',
  switchTask: 'clickupDevTimer.switchTask',
  discardTime: 'clickupDevTimer.discardTime',
  openInBrowser: 'clickupDevTimer.openInBrowser',
  showPendingSync: 'clickupDevTimer.showPendingSync',
  refreshTasks: 'clickupDevTimer.refreshTasks',
} as const;

export type CommandId = (typeof Commands)[keyof typeof Commands];
