import { describe, expect, it } from 'vitest';
import { summarizeBranch } from '../../../src/core/descriptionSuggestions';

const PATTERNS = ['CU-([a-z0-9]+)', '([A-Z][A-Z0-9]+-\\d+)'];

describe('summarizeBranch', () => {
  it.each([
    ['feature/CU-86bx123-fix-login', 'Fix login'],
    ['fix/DEV-42_export_csv', 'Export csv'],
    ['DEV-42-add-export', 'Add export'],
    ['chore/update.deps', 'Update deps'],
    ['user/team/CU-abc123-new-api', 'New api'],
  ])('summarizeBranch(%j) = %j', (branch, expected) => {
    expect(summarizeBranch(branch, PATTERNS)).toBe(expected);
  });

  it('returns undefined when nothing readable is left or only the case would change', () => {
    expect(summarizeBranch('feature/CU-86bx123', PATTERNS)).toBeUndefined();
    expect(summarizeBranch('DEV-42', PATTERNS)).toBeUndefined();
    expect(summarizeBranch('main', PATTERNS)).toBeUndefined();
  });

  it('ignores invalid patterns', () => {
    expect(summarizeBranch('feature/fix-login', ['([a-z'])).toBe('Fix login');
  });
});
