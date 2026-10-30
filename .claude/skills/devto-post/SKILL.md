---
name: devto-post
description: Write and (only with human approval) publish a dev.to article about ClickUp DevTimer. Use when the user asks to "write a dev.to post", "post on dev.to", "announce the release on dev.to", "divulgar no dev.to", "escrever um post", "post de lançamento", or to draft/publish anything in marketing/devto/.
---

# dev.to post (human-approved)

Drafts a dev.to article from repo facts, then pushes it to dev.to through `scripts/devto.mjs` with two
human gates. Read `marketing/devto/README.md` for the file format.

## Hard rules

- **Never print, echo, log, cat or copy the dev.to API key** (`DEV_TO_API_KEY` in `.env`). Do not open `.env`.
  The script loads it itself; run only `npm run devto -- check|draft|publish`.
- **Never set `approved: true` yourself**, and never edit `approved` in any way other than writing `approved: false` in a new file.
- **Never run `publish`** unless the human explicitly says to publish this specific file in their latest message.
- Facts come **only** from the repo. No invented features, numbers, users, benchmarks or quotes.

## Steps

1. **Gather facts** from `README.md`, `CHANGELOG.md` (latest released section), `package.json` (`version`,
   `displayName`, `description`) and `spec.md`. Note the exact version.
2. **Ask the angle and language** if the user didn't give them: e.g. launch / release-notes for vX.Y.Z /
   "why I built it" / a single feature deep-dive. Language: English by default, PT-BR on request. Stop and wait for the answer.
3. **Draft the copy** by delegating to the `devto-writer` subagent (it has no shell, so it cannot call the API).
   Give it: the angle, language, version, the target path and the facts list. Target path:
   `marketing/devto/YYYY-MM-DD-<slug>.md` (today's date, short kebab-case slug). The post must:
   - start from `marketing/devto/_template.md` front matter, with `approved: false`;
   - have ≤ 4 tags, lowercase alphanumeric only (e.g. `vscode`, `productivity`, `clickup`, `opensource`);
   - follow: hook → problem → how it works → install → CTA;
   - link the Marketplace (https://marketplace.visualstudio.com/items?itemName=andradevander.clickup-devtimer),
     Open VSX (https://open-vsx.org/extension/andradevander/clickup-devtimer) and GitHub
     (https://github.com/andradevander/clickup-devtimer);
   - `canonical_url` only if the human says it was published elsewhere first.
4. **Validate** with `npm run devto -- draft <file> --dry-run`. It must refuse because `approved: false`
   (that is expected). Re-read the file to check tags and links.
5. **STOP (gate 1).** Tell the human the file path, summarise the post in 2–3 lines, and ask them to review/edit
   it and set `approved: true` themselves. Do not continue until they confirm.
6. **Create the draft:** after the human confirms, check the file really has `approved: true`, then run
   `npm run devto -- draft <file>` (Claude Code will ask permission). Give the human the `devto_url` printed
   (the private preview). If they edit the local file later, re-run `draft` to update the same article.
7. **STOP (gate 2).** Ask the human to preview the draft on dev.to and say "publish" when happy.
8. **Publish** only on an explicit "publish": run `npm run devto -- publish <file>` and report the public URL.

## Errors

- `401`: key invalid or revoked; ask the human to update `.env` (don't ask them to paste the key in chat).
- `422`: dev.to rejected the content (often tags); fix the file, then show the human the change.
- `429`: rate limited; wait and retry later, don't loop.
