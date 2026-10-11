export type TaskReference = { kind: 'id'; id: string } | { kind: 'customId'; id: string };

const CLICKUP_APP_HOSTS = new Set(['app.clickup.com', 'sharing.clickup.com']);

/** `CU-86bx123ab`, the prefix used by ClickUp's Git integrations. */
const CU_PREFIXED_ID = /^CU-([a-z0-9]+)$/i;
/** `DEV-123`: a workspace custom task ID. */
const CUSTOM_ID = /^[A-Z][A-Z0-9]*-\d+$/i;
/** `86bx123ab`: lowercase alphanumeric with at least one digit, so plain words are not mistaken for IDs. */
const NATIVE_ID = /^(?=[a-z]*\d)[a-z0-9]{6,12}$/i;

/**
 * Parses what a user typed or pasted into a task reference: a task ID (`86bx123ab`, `#86bx123ab`,
 * `CU-86bx123ab`), a custom ID (`DEV-123`) or a ClickUp task URL. Returns `null` for anything else,
 * such as free search text.
 */
export function parseTaskReference(input: string): TaskReference | null {
  const value = input.trim();
  if (value === '') {
    return null;
  }
  const fromUrl = parseTaskUrl(value);
  if (fromUrl !== undefined) {
    return fromUrl;
  }
  return parseTaskId(value.replace(/^#/, ''));
}

function parseTaskId(value: string): TaskReference | null {
  const prefixed = CU_PREFIXED_ID.exec(value);
  if (prefixed?.[1] !== undefined) {
    const id = prefixed[1];
    return NATIVE_ID.test(id) ? { kind: 'id', id: id.toLowerCase() } : null;
  }
  if (CUSTOM_ID.test(value)) {
    return { kind: 'customId', id: value.toUpperCase() };
  }
  if (NATIVE_ID.test(value)) {
    return { kind: 'id', id: value.toLowerCase() };
  }
  return null;
}

/** Returns `undefined` when the value is not a ClickUp URL at all, `null` when it is but has no task. */
function parseTaskUrl(value: string): TaskReference | null | undefined {
  if (!/^https?:\/\//i.test(value)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!CLICKUP_APP_HOSTS.has(url.hostname.toLowerCase())) {
    return undefined;
  }
  // /t/{taskId} or /t/{teamId}/{customId}
  const match = /^\/t\/(?:\d+\/)?([^/]+)\/?$/.exec(url.pathname);
  const segment = match?.[1];
  return segment === undefined ? null : parseTaskId(decodeURIComponent(segment));
}

export interface BranchTaskIds {
  references: TaskReference[];
  /** Patterns that are not valid regular expressions or have no capture group. */
  invalidPatterns: string[];
}

/**
 * Extracts task references from a Git branch name using the configured patterns (capture group 1
 * holds the ID). References keep pattern order and are de-duplicated.
 */
export function extractTaskIdsFromBranch(branch: string, patterns: readonly string[]): BranchTaskIds {
  const references: TaskReference[] = [];
  const invalidPatterns: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch {
      invalidPatterns.push(pattern);
      continue;
    }
    for (const match of branch.matchAll(regex)) {
      const captured = match[1];
      if (captured === undefined) {
        invalidPatterns.push(pattern);
        break;
      }
      // A capture such as "CU-86" (from a custom-ID pattern) is rejected by the CU- rule, not read as a custom ID.
      const reference = parseTaskReference(captured);
      const key = reference === null ? '' : `${reference.kind}:${reference.id}`;
      if (reference !== null && !seen.has(key)) {
        seen.add(key);
        references.push(reference);
      }
    }
  }

  return { references, invalidPatterns };
}

export function buildTaskUrl(taskId: string): string {
  return `https://app.clickup.com/t/${encodeURIComponent(taskId)}`;
}
