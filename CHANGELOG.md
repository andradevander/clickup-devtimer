# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-30

### Added

- **Getting Started walkthrough** that takes you from install to your first tracked task: connect ClickUp, pick a Workspace, start tracking and fine-tune settings.
- **Weekly summary:** at the start of each week, a short note shows how much time you logged the week before and on how many tasks. Turn it off with `clickupDevTimer.weeklySummary`.
- A one-time, dismissible invitation to rate the extension after it has synced a number of entries for you.

### Fixed

- **Time entries no longer get stuck on the ClickUp Free Forever plan.** ClickUp counts time-entry descriptions towards a small lifetime "Advanced Time Tracking" allowance. Once it ran out, every entry was rejected with HTTP 403 and marked as failed. DevTimer now detects this limit, resends the entry without the description so the time is still logged, and stops sending descriptions to that Workspace. It also turns off the description prompt automatically and tells you once; turn `clickupDevTimer.askDescriptionOnFinish` back on in Settings (e.g. after upgrading your plan) and DevTimer tries descriptions again. Entries that had already failed for this reason are retried automatically after the update.
- When ClickUp's basic time tracking allowance is exhausted, DevTimer now shows a clear message explaining the plan limit instead of a generic error, keeps the entries safe in the queue and stops retrying them until you ask.
- The status prompt shown after finishing a session no longer changes the task status when you press Enter; Enter and Esc both keep the current status.

### Changed

- **Faster task picker:**
  - Tasks matching the current Git branch are listed first, in a "From current branch" section.
  - The task being timed is marked and moved to the end of its section, so **Switch Task → Enter** usually jumps back to the previous task.
  - The "In progress" section no longer repeats each task's status.
  - The folder › list line is only shown when your tasks come from more than one list, so more tasks fit on screen.
- **Clearer description prompt:**
  - The title shows the time being logged and the task name.
  - A readable suggestion is built from the branch name (e.g. `feature/CU-86bx123-fix-login` → "Fix login").
  - Duplicate suggestions are removed.
- The status bar tooltip explains what clicking does in each state.
- Plan-limit failures in **Show Pending Sync** are described in plain language.
- New Marketplace page: commands and settings reference, FAQ, and development docs moved to `CONTRIBUTING.md`.

## [0.1.1] - 2026-10-11

### Added

- Extension icon on the Marketplace.

### Changed

- The release workflow skips publishing to Open VSX when no Open VSX token is configured.

## [0.1.0] - 2026-10-11

### Added

- Status bar timer with a quick menu to pick, start, pause, resume, switch, finish and discard.
- Task picker with recent, in progress and assigned tasks, and lookup by task ID, custom ID or URL.
- Idle detection: the timer pauses when you step away, and idle time is never logged.
- Git branch detection that suggests the matching ClickUp task.
- Offline-first sync queue with automatic retries, duplicate protection and a "Show Pending Sync" view.
- One shared timer across all VS Code windows and VS Code-based editors, with crash-safe state on disk.
- Configurable rounding, minimum entry length, descriptions and status-change suggestions.
- English and Português (Brasil) translations.

[Unreleased]: https://github.com/andradevander/clickup-devtimer/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/andradevander/clickup-devtimer/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/andradevander/clickup-devtimer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/andradevander/clickup-devtimer/releases/tag/v0.1.0
