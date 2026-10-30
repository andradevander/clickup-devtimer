/*
 * When to ask for a store review: once after enough time entries were synced, again later if the
 * user picked "Later", never after "Rate it" or "Don't ask again".
 */

export interface ReviewPromptState {
  /** Time entries synced to ClickUp so far. */
  syncedTotal: number;
  /** Ask once `syncedTotal` reaches this; `null` never asks again. */
  askAt: number | null;
}

export type ReviewAnswer = 'rate' | 'later' | 'never' | undefined;

export const REVIEW_FIRST_ASK_AT = 10;
export const REVIEW_LATER_INTERVAL = 20;
export const INITIAL_REVIEW_STATE: ReviewPromptState = { syncedTotal: 0, askAt: REVIEW_FIRST_ASK_AT };

const MARKETPLACE_REVIEW_URL =
  'https://marketplace.visualstudio.com/items?itemName=andradevander.clickup-devtimer&ssr=false#review-details';
const OPEN_VSX_REVIEW_URL = 'https://open-vsx.org/extension/andradevander/clickup-devtimer/reviews';

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The stored state, or the initial one when missing or malformed. */
export function readReviewState(value: unknown): ReviewPromptState {
  if (typeof value !== 'object' || value === null) {
    return INITIAL_REVIEW_STATE;
  }
  const { syncedTotal, askAt } = value as Record<string, unknown>;
  return isCount(syncedTotal) && (askAt === null || isCount(askAt))
    ? { syncedTotal, askAt }
    : INITIAL_REVIEW_STATE;
}

export function withSyncedEntries(state: ReviewPromptState, count: number): ReviewPromptState {
  return count > 0 ? { ...state, syncedTotal: state.syncedTotal + count } : state;
}

export function shouldAskForReview(state: ReviewPromptState): boolean {
  return state.askAt !== null && state.syncedTotal >= state.askAt;
}

/** Closing the message without answering counts as "Later". */
export function afterReviewAnswer(state: ReviewPromptState, answer: ReviewAnswer): ReviewPromptState {
  return answer === 'rate' || answer === 'never'
    ? { ...state, askAt: null }
    : { ...state, askAt: state.syncedTotal + REVIEW_LATER_INTERVAL };
}

/** The Marketplace for VS Code itself; Open VSX for the other editors (Cursor, VSCodium, Windsurf...). */
export function reviewUrl(uriScheme: string): string {
  return uriScheme === 'vscode' || uriScheme === 'vscode-insiders'
    ? MARKETPLACE_REVIEW_URL
    : OPEN_VSX_REVIEW_URL;
}
