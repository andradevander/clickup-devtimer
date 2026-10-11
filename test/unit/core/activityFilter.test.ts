import { describe, expect, it } from 'vitest';
import {
  isIgnoredScheme,
  isUserDocumentChange,
  isUserSelectionChange,
} from '../../../src/core/activityFilter';

describe('isIgnoredScheme', () => {
  it.each(['output', 'debug', 'git', 'gitfs', 'log'])('ignores %s', (scheme) => {
    expect(isIgnoredScheme(scheme)).toBe(true);
  });

  it.each(['file', 'untitled', 'vscode-remote', 'vscode-notebook-cell', 'vscode-userdata'])(
    'keeps %s',
    (scheme) => {
      expect(isIgnoredScheme(scheme)).toBe(false);
    },
  );
});

describe('isUserDocumentChange', () => {
  const typing = { windowFocused: true, scheme: 'file', isActiveEditorDocument: true, changeCount: 1 };

  it('counts typing in the active editor of the focused window', () => {
    expect(isUserDocumentChange(typing)).toBe(true);
    expect(isUserDocumentChange({ ...typing, scheme: 'untitled' })).toBe(true);
  });

  it.each([
    ['the window is not focused', { windowFocused: false }],
    ['another document changed (formatter, AI agent)', { isActiveEditorDocument: false }],
    ['nothing changed', { changeCount: 0 }],
    ['an output channel changed', { scheme: 'output' }],
  ])('ignores changes when %s', (_label, override) => {
    expect(isUserDocumentChange({ ...typing, ...override })).toBe(false);
  });
});

describe('isUserSelectionChange', () => {
  it('counts keyboard, mouse and command selections in the focused window', () => {
    expect(isUserSelectionChange({ windowFocused: true, kind: 1 })).toBe(true);
    expect(isUserSelectionChange({ windowFocused: true, kind: 3 })).toBe(true);
  });

  it('ignores selections made through the API or in an unfocused window', () => {
    expect(isUserSelectionChange({ windowFocused: true, kind: undefined })).toBe(false);
    expect(isUserSelectionChange({ windowFocused: false, kind: 1 })).toBe(false);
  });
});
