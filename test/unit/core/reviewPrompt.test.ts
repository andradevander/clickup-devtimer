import { describe, expect, it } from 'vitest';
import {
  INITIAL_REVIEW_STATE,
  afterReviewAnswer,
  readReviewState,
  reviewUrl,
  shouldAskForReview,
  withSyncedEntries,
} from '../../../src/core/reviewPrompt';

describe('readReviewState', () => {
  it('starts asking after 10 synced entries', () => {
    expect(readReviewState(undefined)).toEqual({ syncedTotal: 0, askAt: 10 });
    expect(INITIAL_REVIEW_STATE).toEqual({ syncedTotal: 0, askAt: 10 });
  });

  it('keeps a valid stored state', () => {
    expect(readReviewState({ syncedTotal: 12, askAt: 32 })).toEqual({ syncedTotal: 12, askAt: 32 });
    expect(readReviewState({ syncedTotal: 12, askAt: null })).toEqual({ syncedTotal: 12, askAt: null });
  });

  it.each([null, 'x', { syncedTotal: 'a', askAt: 10 }, { syncedTotal: 1, askAt: 'b' }, { syncedTotal: -1 }])(
    'falls back to the initial state for %j',
    (value) => {
      expect(readReviewState(value)).toEqual(INITIAL_REVIEW_STATE);
    },
  );
});

describe('shouldAskForReview', () => {
  it('asks once the threshold is reached', () => {
    expect(shouldAskForReview({ syncedTotal: 9, askAt: 10 })).toBe(false);
    expect(shouldAskForReview({ syncedTotal: 10, askAt: 10 })).toBe(true);
    expect(shouldAskForReview({ syncedTotal: 15, askAt: 10 })).toBe(true);
  });

  it('never asks after the user rated or declined', () => {
    expect(shouldAskForReview({ syncedTotal: 1_000, askAt: null })).toBe(false);
  });
});

describe('withSyncedEntries', () => {
  it('adds to the total', () => {
    expect(withSyncedEntries({ syncedTotal: 3, askAt: 10 }, 4)).toEqual({ syncedTotal: 7, askAt: 10 });
  });

  it('ignores non-positive counts', () => {
    const state = { syncedTotal: 3, askAt: 10 };
    expect(withSyncedEntries(state, 0)).toBe(state);
  });
});

describe('afterReviewAnswer', () => {
  const state = { syncedTotal: 11, askAt: 10 };

  it.each(['rate', 'never'] as const)('never asks again after "%s"', (answer) => {
    expect(afterReviewAnswer(state, answer)).toEqual({ syncedTotal: 11, askAt: null });
  });

  it.each(['later', undefined] as const)('asks again after 20 more entries on %s', (answer) => {
    expect(afterReviewAnswer(state, answer)).toEqual({ syncedTotal: 11, askAt: 31 });
  });
});

describe('reviewUrl', () => {
  it.each(['vscode', 'vscode-insiders'])('uses the Marketplace on %s', (scheme) => {
    expect(reviewUrl(scheme)).toBe(
      'https://marketplace.visualstudio.com/items?itemName=andradevander.clickup-devtimer&ssr=false#review-details',
    );
  });

  it.each(['cursor', 'vscodium', 'windsurf'])('uses Open VSX on %s', (scheme) => {
    expect(reviewUrl(scheme)).toBe('https://open-vsx.org/extension/andradevander/clickup-devtimer/reviews');
  });
});
