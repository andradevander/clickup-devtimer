import { describe, expect, it } from 'vitest';
import { buildTaskUrl, extractTaskIdsFromBranch, parseTaskReference } from '../../../src/core/taskIdParser';

const DEFAULT_PATTERNS = ['CU-([a-z0-9]+)', '([A-Z][A-Z0-9]+-\\d+)'];

describe('parseTaskReference', () => {
  it.each([
    ['86bx123ab', { kind: 'id', id: '86bx123ab' }],
    ['  86bx123ab  ', { kind: 'id', id: '86bx123ab' }],
    ['#86bx123ab', { kind: 'id', id: '86bx123ab' }],
    ['86BX123AB', { kind: 'id', id: '86bx123ab' }],
    ['CU-86bx123ab', { kind: 'id', id: '86bx123ab' }],
    ['cu-86bx123ab', { kind: 'id', id: '86bx123ab' }],
    ['DEV-123', { kind: 'customId', id: 'DEV-123' }],
    ['dev-123', { kind: 'customId', id: 'DEV-123' }],
    ['A1-9', { kind: 'customId', id: 'A1-9' }],
  ])('parses %j', (input, expected) => {
    expect(parseTaskReference(input)).toEqual(expected);
  });

  it.each([
    ['https://app.clickup.com/t/86bx123ab', { kind: 'id', id: '86bx123ab' }],
    ['https://app.clickup.com/t/86bx123ab/', { kind: 'id', id: '86bx123ab' }],
    ['https://app.clickup.com/t/86bx123ab?comment=1#x', { kind: 'id', id: '86bx123ab' }],
    ['https://app.clickup.com/t/9000/DEV-123', { kind: 'customId', id: 'DEV-123' }],
    ['https://sharing.clickup.com/t/86bx123ab', { kind: 'id', id: '86bx123ab' }],
    ['HTTPS://APP.CLICKUP.COM/t/86bx123ab', { kind: 'id', id: '86bx123ab' }],
  ])('parses URL %s', (input, expected) => {
    expect(parseTaskReference(input)).toEqual(expected);
  });

  it.each([
    '',
    '   ',
    'refactor', // plain word, no digit
    'login', // too short
    'fix login bug', // free text
    '123', // too short
    'abcdefghijklm1', // too long
    'CU-86', // CU- prefix with an invalid ID
    'https://app.clickup.com/home', // ClickUp URL without a task
    'https://app.clickup.com/t/', // empty task
    'https://example.com/t/86bx123ab', // other host
    'http://[invalid', // malformed URL
  ])('rejects %j', (input) => {
    expect(parseTaskReference(input)).toBeNull();
  });
});

describe('extractTaskIdsFromBranch', () => {
  it('extracts a CU- prefixed ID', () => {
    expect(extractTaskIdsFromBranch('feature/CU-86bx123ab-fix-login', DEFAULT_PATTERNS)).toEqual({
      references: [{ kind: 'id', id: '86bx123ab' }],
      invalidPatterns: [],
    });
  });

  it('extracts a custom ID', () => {
    expect(extractTaskIdsFromBranch('feature/DEV-123-fix-login', DEFAULT_PATTERNS).references).toEqual([
      { kind: 'customId', id: 'DEV-123' },
    ]);
  });

  it('keeps pattern order and removes duplicates', () => {
    const branch = 'CU-86bx123ab/DEV-1/CU-86bx123ab';
    expect(extractTaskIdsFromBranch(branch, DEFAULT_PATTERNS).references).toEqual([
      { kind: 'id', id: '86bx123ab' },
      { kind: 'customId', id: 'DEV-1' },
    ]);
  });

  it('returns nothing for branches without IDs', () => {
    expect(extractTaskIdsFromBranch('main', DEFAULT_PATTERNS).references).toEqual([]);
    expect(extractTaskIdsFromBranch('feature/login-page', DEFAULT_PATTERNS).references).toEqual([]);
  });

  it('supports custom patterns', () => {
    expect(extractTaskIdsFromBranch('task_86bx123ab_login', ['task_([a-z0-9]+)_']).references).toEqual([
      { kind: 'id', id: '86bx123ab' },
    ]);
  });

  it('reports invalid patterns and patterns without a capture group', () => {
    expect(
      extractTaskIdsFromBranch('CU-86bx123ab', ['(unclosed', 'CU-[a-z0-9]+', ...DEFAULT_PATTERNS]),
    ).toEqual({
      references: [{ kind: 'id', id: '86bx123ab' }],
      invalidPatterns: ['(unclosed', 'CU-[a-z0-9]+'],
    });
  });
});

describe('buildTaskUrl', () => {
  it('builds the task URL', () => {
    expect(buildTaskUrl('86bx123ab')).toBe('https://app.clickup.com/t/86bx123ab');
  });
});
