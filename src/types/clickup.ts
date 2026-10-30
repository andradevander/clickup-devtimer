/*
 * Subset of the ClickUp API v2 payloads used by the extension.
 * Only the fields the extension reads are declared.
 */

export interface ClickUpUser {
  id: number;
  username: string;
  email: string;
}

export interface ClickUpTeam {
  id: string;
  name: string;
}

export interface ClickUpStatus {
  status: string;
  type: string;
  color: string;
}

export interface ClickUpTask {
  id: string;
  custom_id: string | null;
  name: string;
  url: string;
  status: ClickUpStatus;
  list: { id: string; name: string };
  folder: { id: string; name: string; hidden?: boolean };
  space: { id: string };
  team_id: string;
  date_updated: string | null;
}

export interface ClickUpTasksPage {
  tasks: ClickUpTask[];
  last_page?: boolean;
}

export interface ClickUpList {
  id: string;
  name: string;
  statuses: ClickUpStatus[];
}

export interface ClickUpTimeEntry {
  id: string;
  /** Epoch milliseconds, as a string. */
  start: string;
  /** Milliseconds, as a string (negative while a native timer is running). */
  duration: string;
  description: string;
  task: { id: string } | null;
}

export interface NewTimeEntry {
  /** Internal task ID. */
  tid: string;
  /** Epoch milliseconds. */
  start: number;
  /** Milliseconds. */
  duration: number;
  /** Omitted when the plan does not allow descriptions ("Advanced Time Tracking"). */
  description?: string;
}
