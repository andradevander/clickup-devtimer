# ClickUp DevTimer

> Smart, active-time tracking for ClickUp tasks, right from the VS Code status bar.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/andradevander.clickup-devtimer?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=andradevander.clickup-devtimer)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/andradevander.clickup-devtimer)](https://marketplace.visualstudio.com/items?itemName=andradevander.clickup-devtimer)
[![CI](https://github.com/andradevander/clickup-devtimer/actions/workflows/ci.yml/badge.svg)](https://github.com/andradevander/clickup-devtimer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Stop switching to the browser to start and stop timers. ClickUp DevTimer tracks only the time you are **actually working** in the editor and logs it to the right ClickUp task, even when you forget about it.

## Features

- **Status bar first:** pick a task, start, pause and sync without leaving the editor.
- **Counts real work only:** the timer pauses when you step away and resumes when you're back. Idle time is never logged.
- **Git branch detection:** a branch like `feature/CU-86bx123-fix-login` suggests starting the timer on that task.
- **Never lose time:** state is saved to disk and time entries are queued offline and retried automatically.
- **Multi-window aware:** one timer shared across all VS Code windows; activity in any window counts.
- **Clean timesheets:** configurable rounding and minimum entry length, with an optional description per entry.
- **Status suggestions:** offers to move the task to "in progress" when you start working on it.
- Available in **English** and **Português (Brasil)**.

## Getting started

1. Install the extension. The **Get Started with ClickUp DevTimer** walkthrough opens and guides you through the steps below (reopen it any time with **Help › Welcome**).
2. Get your ClickUp Personal Token (see below).
3. Run **ClickUp DevTimer: Set Personal Token** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and paste it.
4. Click the timer in the status bar, pick a task and start coding.

### 🔑 Get your ClickUp Personal Token

1. Log in to ClickUp in your browser.
2. Click your **profile avatar** (bottom-left or top-right, depending on your layout).
3. Select **Settings**.
4. In the sidebar, open **Apps**.
5. Under **API Token**, click **Generate** (or copy the existing token).
6. The token looks like `pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXX`.
7. In VS Code, run **ClickUp DevTimer: Set Personal Token** and paste it.
8. If you belong to more than one Workspace, pick the one to use. You can change it later with **ClickUp DevTimer: Select Workspace**.

Your token is stored only in the VS Code SecretStorage (your OS keychain) and is sent only to `api.clickup.com`.

## Commands

All commands are available from the Command Palette under **ClickUp DevTimer**, and the most common ones from the status bar menu.

| Command                     | What it does                                                   |
| --------------------------- | -------------------------------------------------------------- |
| Select / Start Task         | Search your assigned tasks, or paste a task ID, custom ID, URL |
| Show Timer Menu             | Quick actions for the current timer                            |
| Pause Timer / Resume Timer  | Pause or resume manually                                       |
| Stop & Sync Time to ClickUp | Finish the session and log the time entry                      |
| Switch Task                 | Log the current time and start on another task                 |
| Discard Current Time        | Throw away the current session without logging                 |
| Open Task in Browser        | Open the current task in ClickUp                               |
| Show Pending Sync           | See, retry or discard entries waiting to be sent               |

## Settings

The most useful settings (search for `clickupDevTimer` in the Settings UI for the full list):

| Setting                                      | Default                            | Description                                         |
| -------------------------------------------- | ---------------------------------- | --------------------------------------------------- |
| `clickupDevTimer.inactivityThresholdSeconds` | `120`                              | Seconds without activity before the timer pauses    |
| `clickupDevTimer.roundingMinutes`            | `5`                                | Round entries to this many minutes (`0` disables)   |
| `clickupDevTimer.roundingMode`               | `nearest`                          | `nearest`, `up` or `down`                           |
| `clickupDevTimer.minimumEntrySeconds`        | `60`                               | Shorter sessions are not logged                     |
| `clickupDevTimer.askDescriptionOnFinish`     | `true`                             | Ask for a description when logging time             |
| `clickupDevTimer.activeStatuses`             | `["in progress","doing","in dev"]` | Statuses treated as "in progress"                   |
| `clickupDevTimer.branchDetection.patterns`   | `["CU-([a-z0-9]+)", …]`            | Regexes that extract a task ID from the branch name |
| `clickupDevTimer.weeklySummary`              | `true`                             | Show a short summary of last week's logged time     |

## FAQ

**My entries are not syncing and I'm on the ClickUp Free Forever plan.**
ClickUp limits time tracking on the Free Forever plan: adding a **description** to a time entry counts towards a small lifetime "Advanced Time Tracking" allowance, and creating entries counts towards a basic allowance. When the description allowance runs out, DevTimer sends the entry without a description so your time is still logged, and turns off `clickupDevTimer.askDescriptionOnFinish` automatically. After upgrading your plan, turn that setting back on and descriptions are sent again. If the basic allowance runs out, ClickUp rejects new entries until the plan is upgraded; they stay safe in **Show Pending Sync**.

**Does it work offline?**
Yes. Entries are queued locally and sent when ClickUp is reachable again.

**Does it track time in other editors?**
The timer state is shared by VS Code, VS Code Insiders, Cursor and other VS Code-based editors on the same machine.

## Uninstalling

The timer state is kept in `~/.clickup-devtimer` (`%USERPROFILE%\.clickup-devtimer` on Windows). It is not removed when you uninstall the extension; delete that folder to remove all local data. Your token is stored separately in the editor's SecretStorage; run **ClickUp DevTimer: Sign Out (Clear Token)** before uninstalling to remove it.

## Feedback & contributing

Found a bug or have an idea? [Open an issue](https://github.com/andradevander/clickup-devtimer/issues). If DevTimer saves you time, a ⭐ on [GitHub](https://github.com/andradevander/clickup-devtimer) or a review on the [Marketplace](https://marketplace.visualstudio.com/items?itemName=andradevander.clickup-devtimer&ssr=false#review-details) helps other developers find it.

Want to hack on it? See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © andradevander
