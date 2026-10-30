# Contributing to ClickUp DevTimer

Thanks for your interest in improving ClickUp DevTimer! Issues and pull requests are welcome.

## Requirements

- Node.js 20+
- VS Code 1.93+

## Getting started

```bash
npm install
```

Press `F5` in VS Code to build and launch an Extension Development Host (use **Run Extension (pt-BR)** to test the Portuguese UI). After changing code, restart the debug session (`Ctrl+Shift+F5`) to rebuild and reload. To rebuild on every save instead, run **Tasks: Run Task → watch**.

## Scripts

| Script                     | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `npm run build`            | Bundle the extension with esbuild into `dist/`   |
| `npm run check`            | Lint, format check, typecheck and unit tests     |
| `npm run test:unit`        | Unit tests (Vitest)                              |
| `npm run test:coverage`    | Unit tests with coverage report                  |
| `npm run test:integration` | Integration tests inside a real VS Code instance |
| `npm run package`          | Build the `.vsix` package                        |

Run `npm run check` before opening a pull request; CI runs the same checks plus the integration tests.

## Project layout

- `src/core/` — pure logic (state machine, rounding, idle policy, parsing). No `vscode` imports, fully unit-tested.
- `src/services/` — ClickUp API client, sync queue, persistence, multi-window coordination.
- `src/ui/` — status bar and QuickPick flows.
- `l10n/` and `package.nls*.json` — translations. Every user-facing string needs a pt-BR entry (`test/unit/l10n.test.ts` checks it).

The technical specification lives in [spec.md](spec.md).

## Releasing

1. Move the `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under a new version heading.
2. Bump `version` in `package.json` (`npm version <patch|minor|major> --no-git-tag-version`).
3. Merge to `main`, then push a `vX.Y.Z` tag. The [release workflow](.github/workflows/release.yml) verifies the tag, runs the tests, publishes to the VS Code Marketplace (and Open VSX when `OVSX_PAT` is set) and creates the GitHub Release.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:` …).
