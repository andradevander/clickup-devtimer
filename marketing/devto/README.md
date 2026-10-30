# dev.to posts

Posts about ClickUp DevTimer for [dev.to](https://dev.to), published with `scripts/devto.mjs`.
Nothing in `marketing/` or `scripts/` ships in the VSIX.

## Setup

Put your dev.to API key (from https://dev.to/settings/extensions) in the gitignored `.env` at the repo root:

```
DEV_TO_API_KEY=...
```

Never paste, print or commit the key. Check it works with `npm run devto -- check` (prints only your username).

## Flow (two human gates)

1. Copy `_template.md` to `YYYY-MM-DD-<slug>.md` (or ask Claude: "write a dev.to post", which uses the `devto-post` skill). New posts always start with `approved: false`.
2. **Gate 1:** a human reviews and edits the file, then sets `approved: true`.
3. `npm run devto -- draft <file>` creates (or updates) an **unpublished** draft on dev.to and writes `devto_id` / `devto_url` back into the front matter. Re-run it after any local edit to update the draft.
4. **Gate 2:** a human opens `devto_url` and previews the draft on dev.to.
5. `npm run devto -- publish <file>` makes it public and prints the public URL.

Add `--dry-run` to `draft` or `publish` to print the request (method, URL, JSON body) without sending it.

## Front matter

| Key             | Sent to dev.to | Notes                                                    |
| --------------- | -------------- | -------------------------------------------------------- |
| `title`         | yes            | required                                                 |
| `description`   | yes            | preview / social card text                               |
| `tags`          | yes            | max 4, lowercase alphanumeric: `[a, b]` or `a, b`        |
| `canonical_url` | yes            | optional, if the post was first published elsewhere      |
| `cover_image`   | yes            | optional, public image URL (sent as `main_image`)        |
| `series`        | yes            | optional                                                 |
| `approved`      | no             | human gate; only a human sets it to `true`               |
| `devto_id`      | no             | written by `draft`; its presence makes `draft` an update |
| `devto_url`     | no             | written by `draft` / `publish`                           |

Only simple `key: value` lines are supported. The body (everything after the closing `---`) is sent as
`body_markdown` without the front matter.
