export type TodoRecurrenceFreq = "daily" | "weekly" | "monthly" | "yearly";

/** byWeekdays 用 0=周一 .. 6=周日（与 Rust 侧 ISO 约定一致） */
export interface TodoRecurrenceRule {
  freq: TodoRecurrenceFreq;
  interval: number;
  byWeekdays: number[];
  anchorDate: string;
  endDate?: string | null;
}

export interface TodoList {
  id: string;
  name: string;
  sortOrder: number;
  defaultTagIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TodoTag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  id: string;
  listId: string;
  title: string;
  pinned: boolean;
  sortOrder: number;
  tagIds: string[];
  /** "YYYY-MM-DD"，本地日期语义 */
  dueDate?: string | null;
  /** RFC3339 UTC */
  remindAt?: string | null;
  recurrence?: TodoRecurrenceRule | null;
  createdAt: string;
  updatedAt: string;
}

export interface TodoArchiveEntry {
  id: string;
  listId: string;
  listName: string;
  title: string;
  pinned: boolean;
  tagIds: string[];
  dueDate?: string | null;
  remindAt?: string | null;
  completedAt: string;
  createdAt: string;
}

export interface SaveTodoItemRequest {
  listId: string;
  title: string;
  pinned: boolean;
  tagIds: string[];
  dueDate?: string | null;
  remindAt?: string | null;
  recurrence?: TodoRecurrenceRule | null;
}

export interface CreateTodoListRequest {
  name: string;
  defaultTagIds: string[];
}

export interface CreateTodoTagRequest {
  name: string;
  color: string;
}

export interface UpdateTodoTagRequest {
  name: string;
  color: string;
}

export interface TodoCompleteResult {
  archived: TodoArchiveEntry;
  nextItem: TodoItem | null;
}
