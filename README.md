# ClickUp DevTimer

> Smart, active-time tracking for ClickUp tasks, right from the VS Code status bar.

[![CI](https://github.com/andradevander/clickup-devtimer/actions/workflows/ci.yml/badge.svg)](https://github.com/andradevander/clickup-devtimer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 🚧 **Work in progress.** The extension is under active development and not yet published.

## Features

- **Status bar first:** pick a task, start, pause and sync without leaving the editor.
- **Idle detection:** the timer pauses when you step away and resumes when you're back. Idle time is never logged.
- **Git branch detection:** a branch like `feature/CU-86bx123-fix-login` suggests starting the timer on that task.
- **Crash-safe & offline-ready:** state is saved to disk and time entries are queued and retried automatically.
- **Multi-window aware:** one timer shared across all VS Code windows; activity in any window counts.
- Available in **English** and **Português (Brasil)**.

## Getting started

### 🔑 Get your ClickUp Personal Token

1. Log in to ClickUp in your browser.
2. Click your **profile avatar** (bottom-left or top-right, depending on your layout).
3. Select **Settings**.
4. In the sidebar, open **Apps**.
5. Under **API Token**, click **Generate** (or copy the existing token).
6. The token looks like `pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXX`.
7. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run **ClickUp DevTimer: Set Personal Token** and paste it.
8. If you belong to more than one Workspace, pick the one to use. You can change it later with **ClickUp DevTimer: Select Workspace**.

Your token is stored only in the VS Code SecretStorage (your OS keychain) and is sent only to `api.clickup.com`.

## Development

Requirements: Node.js 20+ and VS Code 1.93+.

```bash
npm install
npm run watch          # rebuild on change
```

Press `F5` in VS Code to launch an Extension Development Host (use **Run Extension (pt-BR)** to test the Portuguese UI).

| Script                     | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `npm run build`            | Bundle the extension with esbuild into `dist/`   |
| `npm run check`            | Lint, format check, typecheck and unit tests     |
| `npm run test:unit`        | Unit tests (Vitest)                              |
| `npm run test:coverage`    | Unit tests with coverage report                  |
| `npm run test:integration` | Integration tests inside a real VS Code instance |
| `npm run package`          | Build the `.vsix` package                        |

The technical specification lives in [spec.md](spec.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

[MIT](LICENSE) © andradevander
