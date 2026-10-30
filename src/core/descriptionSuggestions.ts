/**
 * Turns a branch name into a readable time entry description: `feature/CU-86bx123-fix-login` becomes
 * `Fix login`. The task IDs matched by `patterns` (branch detection, spec §3.9) and the `type/` prefix
 * are dropped. Returns `undefined` when nothing readable is left or the result only differs in case.
 */
export function summarizeBranch(branch: string, patterns: readonly string[]): string | undefined {
  let text = branch.slice(branch.lastIndexOf('/') + 1);
  for (const pattern of patterns) {
    try {
      text = text.replace(new RegExp(pattern, 'g'), ' ');
    } catch {
      // Invalid patterns are reported by branch detection.
    }
  }
  const words = text
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (words === '' || words.toLowerCase() === branch.toLowerCase()) {
    return undefined;
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}
